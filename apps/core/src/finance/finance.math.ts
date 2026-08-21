/**
 * Денежная математика финансового контура — ЧИСТЫЕ функции без БД.
 *
 * Перенос расчётных паттернов PROMACH (донор ~/Developer/promach):
 *   • агинг открытых обязательств по сроку (notifications.ts: «к сроку ≤ 7 дней»);
 *   • концентрация долга по контрагентам (термометр из mydon-agent-os, порог 60%);
 *   • кэш-флоу по месяцам (finance dashboard: by_month).
 *
 * Критическое отличие от донора: PROMACH в дашборде складывал `SUM(amount)`
 * поверх разных валют — USD и UZS в одну цифру. Здесь суммы ВСЕГДА раздельно
 * по валютам, а сводить их разрешено только в сум и только по курсу записи
 * (rate на дату операции, PROMACH миграция 083). Запись без курса не
 * пропадает и не выдумывается — считается отдельно как «неприведённая».
 */

export interface FlowForMath {
  id: string;
  direction: "in" | "out";
  /** planned | actual | cancelled */
  status: string;
  /** Суммы из БД приходят строками — числом они становятся только здесь. */
  amount: string;
  currency: string;
  rate: string | null;
  amountUzs: string | null;
  /** YYYY-MM-DD. null — срока нет. */
  dueDate: string | null;
  /** Дата операции. */
  date: Date | string;
  /** Ключ контрагента: карточка реестра либо имя словами. */
  counterpartyKey: string | null;
  counterpartyName: string | null;
}

/** Сумма по одной валюте — валюты никогда не складываются между собой. */
export interface CurrencyAmount {
  currency: string;
  amount: number;
  count: number;
}

export interface BucketSummary {
  count: number;
  byCurrency: CurrencyAmount[];
  /** Эквивалент в сумах ТОЛЬКО приведённых записей. */
  uzs: number;
  /** Записей в валюте без курса — в `uzs` они не вошли. */
  unconverted: number;
}

/** Корзины агинга — как в плане интеграции PROMACH: 0–30/31–60/61–90/90+. */
export interface AgingReport {
  /** Срок ещё не наступил. */
  notDue: BucketSummary;
  /** Просрочка 1–30 дней. */
  d0_30: BucketSummary;
  d31_60: BucketSummary;
  d61_90: BucketSummary;
  d90plus: BucketSummary;
  /** Срока нет вовсе — честная отдельная корзина, а не молчаливый пропуск. */
  noDue: BucketSummary;
  /** Всего открыто. */
  total: BucketSummary;
}

export interface ConcentrationRow {
  key: string;
  name: string;
  uzs: number;
  byCurrency: CurrencyAmount[];
  /** Доля в приведённой (сумовой) части долга: 0..1. null — привести нечего. */
  share: number | null;
}

/** Термометр концентрации: доля крупнейшего должника. Порог красного — 60%. */
export interface ConcentrationReport {
  rows: ConcentrationRow[];
  topShare: number | null;
  /** ≥ 0.6 — риск концентрации (правило OLMA из финконтура GLOBERENT). */
  alarm: boolean;
  totalUzs: number;
  unconverted: number;
}

export interface MonthCash {
  /** YYYY-MM. */
  month: string;
  inflow: CurrencyAmount[];
  outflow: CurrencyAmount[];
  inflowUzs: number;
  outflowUzs: number;
}

export const CONCENTRATION_ALARM = 0.6;

/** Дата → YYYY-MM-DD по ташкентскому поясу: сравнение дат — строковое, как в брифинге Core. */
export function dayKey(d: Date | string, tz: string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function utcOf(day: string): number | null {
  if (!ISO_DAY.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/** Дней от a до b. null — одна из дат не читается. */
export function daysBetween(a: string, b: string): number | null {
  const ta = utcOf(a);
  const tb = utcOf(b);
  if (ta === null || tb === null) return null;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * Эквивалент записи в сумах. Порядок источников — как в PROMACH:
 * своя валюта → сохранённый amount_uzs → пересчёт по rate записи.
 * Нет курса — null: цифру не выдумываем.
 */
export function uzsEquivalent(row: Pick<FlowForMath, "amount" | "currency" | "rate" | "amountUzs">): number | null {
  const amount = Number(row.amount);
  if (!Number.isFinite(amount)) return null;
  if (row.currency === "UZS") return amount;
  if (row.amountUzs !== null) {
    const stored = Number(row.amountUzs);
    if (Number.isFinite(stored)) return stored;
  }
  if (row.rate !== null) {
    const rate = Number(row.rate);
    if (Number.isFinite(rate) && rate > 0) return amount * rate;
  }
  return null;
}

function emptyBucket(): BucketSummary {
  return { count: 0, byCurrency: [], uzs: 0, unconverted: 0 };
}

function addToBucket(b: BucketSummary, row: FlowForMath): void {
  const amount = Number(row.amount);
  if (!Number.isFinite(amount)) return;
  b.count += 1;
  const cur = b.byCurrency.find((c) => c.currency === row.currency);
  if (cur) {
    cur.amount += amount;
    cur.count += 1;
  } else {
    b.byCurrency.push({ currency: row.currency, amount, count: 1 });
  }
  const uzs = uzsEquivalent(row);
  if (uzs === null) b.unconverted += 1;
  else b.uzs += uzs;
}

function sortCurrencies(b: BucketSummary): void {
  // Сум первым, дальше по алфавиту — порядок стабилен, как в moneyByCurrency панели.
  b.byCurrency.sort((a, c) =>
    a.currency === "UZS" ? -1 : c.currency === "UZS" ? 1 : a.currency.localeCompare(c.currency),
  );
}

/** Открытые обязательства: план, не отменён. */
export const isOpen = (r: Pick<FlowForMath, "status">): boolean => r.status === "planned";

/**
 * Агинг открытых обязательств одного направления движения (in — дебиторка,
 * out — кредиторка) на день `today` (YYYY-MM-DD).
 */
export function aging(rows: FlowForMath[], direction: "in" | "out", today: string): AgingReport {
  const report: AgingReport = {
    notDue: emptyBucket(),
    d0_30: emptyBucket(),
    d31_60: emptyBucket(),
    d61_90: emptyBucket(),
    d90plus: emptyBucket(),
    noDue: emptyBucket(),
    total: emptyBucket(),
  };
  for (const row of rows) {
    if (!isOpen(row) || row.direction !== direction) continue;
    addToBucket(report.total, row);
    const due = row.dueDate;
    if (due === null || !ISO_DAY.test(due)) {
      addToBucket(report.noDue, row);
      continue;
    }
    if (due >= today) {
      addToBucket(report.notDue, row);
      continue;
    }
    const overdueDays = daysBetween(due, today);
    if (overdueDays === null) {
      addToBucket(report.noDue, row);
    } else if (overdueDays <= 30) {
      addToBucket(report.d0_30, row);
    } else if (overdueDays <= 60) {
      addToBucket(report.d31_60, row);
    } else if (overdueDays <= 90) {
      addToBucket(report.d61_90, row);
    } else {
      addToBucket(report.d90plus, row);
    }
  }
  for (const b of [report.notDue, report.d0_30, report.d31_60, report.d61_90, report.d90plus, report.noDue, report.total]) {
    sortCurrencies(b);
  }
  return report;
}

/**
 * «К сроку ≤ N дней» — запрос из notifications.ts PROMACH
 * (due_date <= CURRENT_DATE + INTERVAL '7 days' AND NOT paid), включая уже
 * просроченное: долг, который надо было заплатить вчера, не исчезает из тревоги.
 */
export function dueSoon(rows: FlowForMath[], direction: "in" | "out", today: string, horizonDays = 7): FlowForMath[] {
  const horizonUtc = utcOf(today);
  if (horizonUtc === null) return [];
  const horizon = new Date(horizonUtc + horizonDays * 86_400_000).toISOString().slice(0, 10);
  return rows
    .filter(
      (r) =>
        isOpen(r) &&
        r.direction === direction &&
        r.dueDate !== null &&
        ISO_DAY.test(r.dueDate) &&
        r.dueDate <= horizon,
    )
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
}

/**
 * Концентрация открытой дебиторки по контрагентам. Доли считаются по
 * сумовому эквиваленту; записи без курса в долю не входят, но показываются
 * счётчиком — молча выкидывать долг нельзя.
 */
export function concentration(rows: FlowForMath[]): ConcentrationReport {
  const open = rows.filter((r) => isOpen(r) && r.direction === "in");
  const byKey = new Map<string, { name: string; bucket: BucketSummary }>();
  for (const row of open) {
    const key = row.counterpartyKey ?? row.counterpartyName ?? "—";
    const name = row.counterpartyName ?? (row.counterpartyKey !== null ? row.counterpartyKey : "не указан");
    const found = byKey.get(key) ?? { name, bucket: emptyBucket() };
    addToBucket(found.bucket, row);
    byKey.set(key, found);
  }
  let totalUzs = 0;
  let unconverted = 0;
  for (const { bucket } of byKey.values()) {
    totalUzs += bucket.uzs;
    unconverted += bucket.unconverted;
  }
  const rowsOut: ConcentrationRow[] = [...byKey.entries()]
    .map(([key, { name, bucket }]) => {
      sortCurrencies(bucket);
      return {
        key,
        name,
        uzs: bucket.uzs,
        byCurrency: bucket.byCurrency,
        share: totalUzs > 0 ? bucket.uzs / totalUzs : null,
      };
    })
    .sort((a, b) => b.uzs - a.uzs);
  const topShare = rowsOut.length > 0 ? rowsOut[0].share : null;
  return {
    rows: rowsOut,
    topShare,
    alarm: topShare !== null && topShare >= CONCENTRATION_ALARM,
    totalUzs,
    unconverted,
  };
}

/**
 * Кэш-флоу по месяцам (факт): by_month из finance dashboard PROMACH,
 * но по валютам раздельно + сумовой эквивалент отдельно.
 */
export function byMonth(rows: FlowForMath[], tz: string, months = 12): MonthCash[] {
  const map = new Map<string, MonthCash>();
  for (const row of rows) {
    if (row.status !== "actual") continue;
    const month = dayKey(row.date, tz).slice(0, 7);
    const entry = map.get(month) ?? { month, inflow: [], outflow: [], inflowUzs: 0, outflowUzs: 0 };
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    const list = row.direction === "in" ? entry.inflow : entry.outflow;
    const cur = list.find((c) => c.currency === row.currency);
    if (cur) {
      cur.amount += amount;
      cur.count += 1;
    } else {
      list.push({ currency: row.currency, amount, count: 1 });
    }
    const uzs = uzsEquivalent(row);
    if (uzs !== null) {
      if (row.direction === "in") entry.inflowUzs += uzs;
      else entry.outflowUzs += uzs;
    }
    map.set(month, entry);
  }
  return [...map.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-months);
}

/* ── Сверка кассы: изъято по системе vs сдано в банк (срез К, задача 4, R-K6) ── */

/** Одно денежное событие для сверки: сумма и дата, откуда бы она ни пришла. */
export interface CashMovement {
  date: string | Date;
  amount: number;
}

/**
 * Один календарный месяц окна сверки. `status` — не разница, а признак ДАННЫХ:
 * «пусто» с одной стороны — это не «недостача 100%», а «нечего сравнивать»
 * (тот же принцип, что у `статус` строки в `CollectionsService.reconcile`).
 */
export interface CashReconcilePeriod {
  /** YYYY-MM. */
  period: string;
  withdrawn: number;
  withdrawnCount: number;
  deposited: number;
  depositedCount: number;
  /** `deposited − withdrawn`. */
  diff: number;
  /**
   * `ok` — данные есть с обеих сторон; `empty` — операций не было ни с одной
   * (тихий месяц, а не разрыв); `noWithdrawn`/`noDeposit` — ровно ОДНА сторона
   * пуста — это и есть разрыв (факт 9 плана среза К), стоящий внимания.
   */
  status: "ok" | "empty" | "noWithdrawn" | "noDeposit";
}

export interface CashReconcileReport {
  from: string;
  to: string;
  withdrawn: number;
  withdrawnCount: number;
  /** `false` — за весь период не было ни одной инкассации: `withdrawn: 0` тогда — не факт сходимости, а отсутствие данных. */
  hasWithdrawn: boolean;
  deposited: number;
  depositedCount: number;
  /** `false` — за весь период банк не показал ни одного взноса `0200`. */
  hasDeposited: boolean;
  diff: number;
  /** Помесячная раскладка на весь запрошенный диапазон, включая месяцы без единой операции. */
  periods: CashReconcilePeriod[];
  /** Только периоды, где ровно ОДНА сторона пуста (не обе) — то, что стоит смотреть в первую очередь. */
  gaps: CashReconcilePeriod[];
  /**
   * Явное предупреждение о лаге между изъятием и зачислением ({@link
   * CASH_RECONCILE_LAG_NOTE}) — молчащая витрина хуже неточной: без него
   * расхождение на границе двух месяцев читалось бы как недостача.
   */
  note: string;
}

/**
 * Между сбором денег из автомата (`collectedAt`) и появлением взноса в банке
 * лаг **2–7 дней** (замерено в сверке по автоматам, срез К, задача 3:
 * `медианныйЛагДней` в `CollectionsService.reconcile`). При ПОМЕСЯЧНОЙ
 * группировке это значит: деньги, изъятые в последние дни месяца, банк
 * покажет уже в следующем — месяц изъятия недосчитается, следующий получит
 * лишнее. Разница НА ГРАНИЦЕ двух соседних месяцев может быть этим лагом,
 * а не недостачей — прежде чем искать пропажу, сравнить несколько месяцев
 * подряд, а не один.
 */
export const CASH_RECONCILE_LAG_NOTE =
  "Между изъятием из автомата (сбор) и появлением взноса в банке — лаг 2–7 дней " +
  "(замерено в сверке по автоматам, задача 3). Деньги, изъятые в конце месяца, банк " +
  "покажет уже в следующем: расхождение НА ГРАНИЦЕ двух соседних месяцев может быть " +
  "этим лагом, а не недостачей — сравнивайте несколько месяцев подряд, а не один.";

/** Месяцы `YYYY-MM` от `from` до `to` включительно (обе даты `YYYY-MM-DD`). */
function monthRange(from: string, to: string): string[] {
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const yTo = Number(to.slice(0, 4));
  const mTo = Number(to.slice(5, 7));
  const out: string[] = [];
  // Защита от бесконечного цикла на мусорном вводе — сервис уже проверил формат
  // и `from <= to`, но чистая функция не должна зависать даже на чужой ошибке.
  let guard = 0;
  while ((y < yTo || (y === yTo && m <= mTo)) && guard < 1200) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    guard += 1;
  }
  return out;
}

/**
 * Сверка кассы за период (R-K6): изъято по системе (инкассации) против сдано
 * в банк (взносы с кассовым символом `0200`) — АГРЕГАТНО по месяцам, а не
 * построчно: у 43 взносов и сотен инкассаций нет общего ключа операции,
 * банк видит суммарный взнос, система — сборы по автоматам.
 *
 * `periods` перечисляет КАЖДЫЙ месяц диапазона, даже без единой операции —
 * иначе «нет данных» и «сошлось в ноль» выглядели бы одинаково. `gaps` —
 * только те месяцы, где ровно одна сторона пуста: это и есть разрыв, который
 * стоит объяснять (пропуск инкассации в систему или задержка сдачи в банк),
 * а не «в этом месяце просто было тихо» (обе стороны пусты — `empty`).
 */
export function cashReconcile(
  withdrawals: readonly CashMovement[],
  deposits: readonly CashMovement[],
  from: string,
  to: string,
  tz: string,
): CashReconcileReport {
  const inRange = (d: string | Date): boolean => {
    const key = dayKey(d, tz);
    return key >= from && key <= to;
  };
  const w = withdrawals.filter((x) => inRange(x.date));
  const dep = deposits.filter((x) => inRange(x.date));

  const byMonth = (rows: readonly CashMovement[]): Map<string, { sum: number; count: number }> => {
    const map = new Map<string, { sum: number; count: number }>();
    for (const x of rows) {
      const month = dayKey(x.date, tz).slice(0, 7);
      const e = map.get(month) ?? { sum: 0, count: 0 };
      e.sum += x.amount;
      e.count += 1;
      map.set(month, e);
    }
    return map;
  };
  const wByMonth = byMonth(w);
  const depByMonth = byMonth(dep);

  const periods: CashReconcilePeriod[] = monthRange(from, to).map((month) => {
    const wm = wByMonth.get(month) ?? { sum: 0, count: 0 };
    const dm = depByMonth.get(month) ?? { sum: 0, count: 0 };
    const status: CashReconcilePeriod["status"] =
      wm.count === 0 && dm.count === 0
        ? "empty"
        : wm.count === 0
          ? "noWithdrawn"
          : dm.count === 0
            ? "noDeposit"
            : "ok";
    return {
      period: month,
      withdrawn: Math.round(wm.sum),
      withdrawnCount: wm.count,
      deposited: Math.round(dm.sum),
      depositedCount: dm.count,
      diff: Math.round(dm.sum - wm.sum),
      status,
    };
  });

  const withdrawn = Math.round(w.reduce((s, x) => s + x.amount, 0));
  const deposited = Math.round(dep.reduce((s, x) => s + x.amount, 0));

  return {
    from,
    to,
    withdrawn,
    withdrawnCount: w.length,
    hasWithdrawn: w.length > 0,
    deposited,
    depositedCount: dep.length,
    hasDeposited: dep.length > 0,
    diff: deposited - withdrawn,
    periods,
    gaps: periods.filter((p) => p.status === "noWithdrawn" || p.status === "noDeposit"),
    note: CASH_RECONCILE_LAG_NOTE,
  };
}

/* ── Автокурс ЦБ РУз (cbu.uz) ────────────────────────────────────────────── */

/** Валюты, которые тянутся из ЦБ автоматически — словарь формы курса панели. */
export const FX_AUTO_CURRENCIES: readonly string[] = ["USD", "CNY", "EUR", "RUB"];

/** Строка ответа cbu.uz (форма коннектора @mydon/connectors). */
export interface CbuRateRow {
  Ccy: string;
  Rate: string;
  /** Дата курса в формате ЦБ: ДД.ММ.ГГГГ. */
  Date: string;
}

/** Действующая строка курса — то, что уже лежит в fx_rate. */
export interface FxLatestRow {
  currency: string;
  rate: string;
  source: string;
  createdAt: Date | string;
}

export interface FxRefreshInsert {
  currency: string;
  rate: number;
  note: string;
}

export interface FxRefreshSkip {
  currency: string;
  /** Причина словами — панель показывает её владельцу как есть. */
  reason: string;
}

export interface FxRefreshPlan {
  inserts: FxRefreshInsert[];
  skipped: FxRefreshSkip[];
}

/**
 * План обновления курсов из ЦБ РУз. Правила (паттерн PROMACH
 * «manual override главнее»):
 *   • ручной курс, заданный СЕГОДНЯ, автообновление не перекрывает —
 *     завтра ЦБ снова станет источником по умолчанию;
 *   • курс не изменился — новая строка не пишется (история без спама);
 *   • валюты нет в ответе ЦБ или курс не число — честный пропуск словами.
 */
export function fxRefreshPlan(
  cbuRates: readonly CbuRateRow[],
  latest: readonly FxLatestRow[],
  todayKey: string,
  tz: string,
  targets: readonly string[] = FX_AUTO_CURRENCIES,
): FxRefreshPlan {
  const plan: FxRefreshPlan = { inserts: [], skipped: [] };
  for (const currency of targets) {
    const cbuRow = cbuRates.find((r) => r.Ccy === currency);
    const rate = cbuRow !== undefined ? Number(cbuRow.Rate) : NaN;
    if (cbuRow === undefined || !Number.isFinite(rate) || rate <= 0) {
      plan.skipped.push({ currency, reason: "ЦБ не дал курс" });
      continue;
    }
    const current = latest.find((r) => r.currency === currency);
    if (current !== undefined && current.source === "manual" && dayKey(current.createdAt, tz) === todayKey) {
      plan.skipped.push({ currency, reason: "ручной курс за сегодня главнее" });
      continue;
    }
    if (current !== undefined && Number(current.rate) === rate) {
      plan.skipped.push({ currency, reason: "не изменился" });
      continue;
    }
    plan.inserts.push({ currency, rate, note: `ЦБ РУз на ${cbuRow.Date}` });
  }
  return plan;
}
