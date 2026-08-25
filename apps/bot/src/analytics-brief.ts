import { TZ } from "@mydon/shared";
import type {
  DeadRow,
  DeadStockReport,
  MarginMachine,
  MarginProduct,
  MarginReport,
  PriceChange,
  PriceChangesReport,
  PriceGapReport,
  PriceGapRow,
} from "@mydon/shared";
import type {
  AnalyticsWarning,
  AnalyticsWarningCode,
  BootstrapSalePriceResult,
  OurvendHealth,
  SetSalePriceResult,
  WithWarnings,
} from "./core-client";
import { parsePriceCommand } from "./purchase-brief";
import { MAX_PARTS, RU, chunk } from "./purchase-plan";

/**
 * Аналитика снек-контура в Telegram (П5b): маржа, мёртвый сток, изменения цен,
 * разрыв витрины с эталоном, здоровье сбора OurVend.
 *
 * Числа считает Core (`@mydon/shared/vending-reports` — один расчёт на всех,
 * R-P5b-10); здесь только разбор фразы, оформление и нарезка на сообщения.
 *
 * ТРИ ПРАВИЛА, КОТОРЫЕ ЗДЕСЬ НЕЛЬЗЯ «УПРОСТИТЬ».
 *
 * 1. Каждый заголовок называет охват — «снек-автоматы (OurVend)» (R-P5b-9).
 *    Кофейный контур сюда не входит вовсе: `coffee_sale` пуст, и «маржа» без
 *    оговорки читалась бы как маржа всего парка. При этом «нет данных по
 *    кофе» тоже не пишем — это отчёт не про кофе, а не отчёт с дыркой.
 *
 * 2. Пустой отчёт — не «всё хорошо». «Продаж нет», «эталон не задан», «цена
 *    закупки неизвестна», «снимков нет» пишутся словами. Нули вместо них
 *    выглядят как посчитанный результат, хотя не посчитано ничего.
 *
 * 3. Товар без себестоимости называется в КАЖДОЙ витрине маржи. Его выручка
 *    остаётся в отчёте, а cogs нет, значит маржа завышена ровно на неё
 *    (R-P5b-2). Спрятать это в число «маржа 27.6 %» — соврать на всю сумму.
 */

/** Сколько строк товаров показываем в марже: дальше это уже не сводка. */
const PRODUCTS_SHOWN = 10;
/** Сколько позиций мёртвого стока помещается в раздел, не превращая его в простыню. */
const DEAD_ROWS_SHOWN = 40;
/** Сколько изменений цен показываем на ленту. */
const CHANGES_SHOWN = 20;
/** Сколько прогонов сбора называем поимённо. */
const RUNS_SHOWN = 5;
/** Сколько строк разрыва витрины помещается в отчёт (как у прочих списков). */
const GAP_ROWS_SHOWN = 30;

/** Окна по умолчанию и потолки Core (DTO): зажимаем здесь, чтобы не ловить 400. */
export const MARGIN_DAYS_DEFAULT = 30;
export const MARGIN_DAYS_MAX = 90;
export const DEAD_STOCK_DAYS_DEFAULT = 21;
export const DEAD_STOCK_DAYS_MAX = 180;
export const PRICE_CHANGES_DAYS_DEFAULT = 30;
export const PRICE_CHANGES_DAYS_MAX = 180;
export const PRICE_GAP_DAYS_DEFAULT = 14;
export const PRICE_GAP_DAYS_MAX = 90;
/**
 * «витрина как факт»: окно то же, что у отчёта, а потолок — СВОЙ.
 * `BootstrapSalePriceDto` допускает 180 суток (в отличие от `PriceGapDto`
 * с его 90), и общий потолок молча срезал бы «витрина как факт за 120 дней»
 * до 90 — эталон встал бы не по тому окну, которое просил владелец.
 */
export const BOOTSTRAP_DAYS_MAX = 180;

// ── Разбор фраз ─────────────────────────────────────────────────────────────

/**
 * «маржа», «маржа за 7 дней», «маржинальность автоматов».
 *
 * Без `\b`: в JS-regex он не срабатывает после кириллицы (не входит в `\w`) —
 * тот же нюанс, что в purchase-plan.ts. Якорь `^` обязателен: «что там с
 * маржой» — это вопрос к ассистенту, а не запрос отчёта.
 */
export function isMarginQuery(text: string): boolean {
  return /^марж(а|е|и|у|ой|инал)/i.test(text.trim());
}

/** «мёртвый сток», «мертвый сток», «мёртвые остатки». Обе буквы «е/ё» — живые. */
export function isDeadStockQuery(text: string): boolean {
  return /^(мёртв|мертв)/i.test(text.trim());
}

/**
 * «цены», «цены за 60 дней», «изменения цен».
 *
 * `цены` и `цена` различаются одной буквой и означают противоположное: первое
 * — отчёт, второе — ПРАВКА закупочной цены. Поэтому здесь строгий хвост
 * `(\s|:|$)`, а не префикс `^цен`.
 */
export function isPriceChangesQuery(text: string): boolean {
  return /^цены(\s|:|$)|^изменени[а-я]*\s+цен/i.test(text.trim());
}

/**
 * «витрина как факт» — разовый бутстрап эталона по факту продаж.
 * Проверяется СТРОГО раньше `isPriceGapQuery`: обе фразы начинаются с
 * «витрина», и отчёт перехватил бы мутацию.
 */
export function isSalePriceBootstrapCommand(text: string): boolean {
  return /^витрина\s+как\s+факт/i.test(text.trim());
}

/** «витрина», «витрина за 30 дней» — отчёт о разрыве с эталоном (кроме бутстрапа). */
export function isPriceGapQuery(text: string): boolean {
  const t = text.trim();
  return /^витрин/i.test(t) && !isSalePriceBootstrapCommand(t);
}

/**
 * «цена продажи TUC 15000» — эталон витрины (R-P5b-6).
 *
 * Ветка обязана стоять СТРОГО раньше закупочной `isPriceCommand`
 * (`/^цена(\s|:|$)/i`): та ловит и эту фразу, и правка ушла бы в закупочную
 * цену — молча, в другую колонку и с другим гейтом.
 */
export function isSalePriceCommand(text: string): boolean {
  return /^цена\s+продажи(\s|:|$)/i.test(text.trim());
}

/** «сверка», «сверься» — здоровье сбора OurVend плюс паритет (R-P5b-8). */
export function isOurvendCheckQuery(text: string): boolean {
  return /^сверк|^свер[ья]/i.test(text.trim());
}

/**
 * Окно из фразы: «маржа за 7 дней» → 7, «маржа 7» → 7, «маржа» → `fallback`.
 *
 * Границы держим здесь, а не надеемся на Core: он отвечает 400 на день вне
 * своего диапазона, а владелец увидел бы «попробуй позже» и стал бы ждать —
 * хотя чинить надо было фразу (та же причина, что у `parseShrinkageDays`).
 */
export function parseDays(text: string, fallback: number, max: number): number {
  const t = text.trim();
  const m = /за\s+(\d{1,4})\s*(?:дн|сут)/i.exec(t) ?? /(?:^|\s)(\d{1,4})\s*$/.exec(t);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), Math.max(1, max));
}

/**
 * «цена продажи TUC Sour cream 15 000 точно» → товар, сумма, подтверждение.
 *
 * Число, «к» = ×1000, разделители тысяч и слово «точно» разбирает та же
 * `parsePriceCommand`, что и закупочную цену: второй разбор числа разъехался
 * бы с первым (и «15 000» в одной команде значило бы 15 000, а в другой —
 * 15). `null` → показать формат.
 */
export function parseSalePriceCommand(text: string): { product: string; price: number; confirmed: boolean } | null {
  const t = text.trim();
  if (!isSalePriceCommand(t)) return null;
  const rest = t.replace(/^цена\s+продажи\s*:?\s*/i, "").trim();
  if (rest === "") return null;
  return parsePriceCommand(`цена ${rest}`);
}

/** Подсказка формата, когда «цена продажи …» не разобралась. */
export const SALE_PRICE_HINT =
  "Формат: «цена продажи <товар> <сум за штуку>», например «цена продажи TUC 15000». " +
  "Это ЭТАЛОН витрины, а не закупочная цена (та — «цена TUC 12000»). " +
  "Если эталон расходится с фактом продаж больше чем на 20% — повтори со словом «точно».";

// ── Оформление ──────────────────────────────────────────────────────────────

/** Процент с подписью. `null` — процента НЕТ (нулевая выручка), а не «0 %». */
export const PCT = (p: number | null): string => (p === null ? "— %" : `${p} %`);

/** Процент со знаком: «+20 %», «−20 %». Минус — типографский, как в усушке. */
export const ЗНАК = (p: number): string => `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)} %`;

/**
 * «2026-08-18» → «18.08». Голые сутки режем строкой (они уже по Ташкенту),
 * а момент времени переводим в Ташкент: `at` закупочных изменений приходит
 * штампом события, витринных — бизнес-днём.
 */
export const день = (iso: string): string => {
  if (/^\d{4}-\d{2}-\d{2}/.test(iso) && iso.length <= 10) return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" });
};

/** Момент по Ташкенту: «23.08 08:02». Нечитаемый штамп — «?», а не «Invalid Date». */
export const момент = (iso: string | null): string => {
  if (!iso) return "не было";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  // Запятую между датой и временем убираем: «23.08, 08:02» в строке, где
  // рядом стоят другие поля через «·», читается как ещё один разделитель.
  return d
    .toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    .replace(", ", " ");
};

/** Русское склонение по числу: 1 отказ, 2 отказа, 5 отказов. */
export function сущ(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.round(n)) % 100;
  if (a > 10 && a < 20) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/**
 * Хвост отчёта: почему посчитано не всё (`warnings` от Core, П5b Task 3).
 *
 * Коды, которые отчёт УЖЕ проговорил своими строками, сюда не попадают
 * (`кроме`): владелец не должен читать одно и то же дважды — сначала в теле
 * отчёта, потом в предупреждениях. Именно ради этого у предупреждений есть
 * код, а не только текст.
 *
 * Повторы по тексту гасим, как в усушке: одна и та же причина приходит по
 * каждому автомату, и списком в три десятка одинаковых строк она вытеснила бы
 * сам отчёт.
 */
function предупреждения(warnings: AnalyticsWarning[] | undefined, кроме: AnalyticsWarningCode[] = []): string[] {
  if (!warnings || warnings.length === 0) return [];
  const видели = new Set<string>();
  const строки: string[] = [];
  for (const w of warnings) {
    if (кроме.includes(w.code) || видели.has(w.message)) continue;
    видели.add(w.message);
    строки.push(`⚠️ ${w.message}`);
  }
  return строки.length === 0 ? [] : ["", "Посчитано не всё:", ...строки];
}

/**
 * Нарезка отчёта на сообщения с потолком частей.
 *
 * Сверх лимита отчёт не досылаем, а честно говорим, где он целиком: три
 * десятка сообщений подряд уносят из видимой части чата первое — то самое, где
 * стоит итог (та же причина, что в `formatShrinkage`).
 *
 * `max` — для недельной сводки (R-P5b-7): её никто не спрашивал, она приходит
 * сама в понедельник утром, и двенадцать сообщений подряд в этом случае
 * читаются как поломка бота, а не как отчёт.
 */
export function capped(title: string, lines: string[], лист: string, max = MAX_PARTS): string[] {
  const parts = chunk(title, lines);
  if (parts.length <= max) return parts;
  const kept = parts.slice(0, max - 1);
  kept.push(`…показал ${max - 1} из ${parts.length} частей — остальное на листе «${лист}» в панели.`);
  return kept;
}

/**
 * Что отчёт маржи уже сказал сам: штуки без себестоимости (строка после итога)
 * и продажи не в строю (строка `исключённые`). Повторять их же в хвосте
 * предупреждений значит удлинить отчёт, ничего не добавив.
 */
const ПОКРЫТО_МАРЖОЙ: AnalyticsWarningCode[] = ["unknown_cost", "excluded_sales"];
/** Мёртвый сток сам называет позиции без цены закупки (строка после итога). */
const ПОКРЫТО_СТОКОМ: AnalyticsWarningCode[] = ["unknown_cost"];
/** Витрина сама печатает список «эталон не задан (N): …». */
const ПОКРЫТО_ВИТРИНОЙ: AnalyticsWarningCode[] = ["no_reference"];

/** Строки продаж, выброшенные фильтром «в строю»: названы, а не потеряны (R-P5b-1). */
function исключённые(r: MarginReport): string[] {
  if (r.excluded.length === 0) return [];
  const строки = r.excluded.map((e) => `${e.serial} — ${RU(e.qty)} шт на ${RU(e.amount)} сум`);
  return [
    "",
    `⚠️ Не в счёт (автомат не в строю, ${r.excluded.length}): ${строки.join(" · ")}`,
  ];
}

function машинаСтрока(m: MarginMachine): string {
  const тревога = m.low ? " ⚠️" : "";
  return (
    `• ${m.name}: выручка ${RU(m.revenue)}, маржа ${RU(m.margin)} (${PCT(m.pct)})${тревога} · ${RU(m.qty)} шт` +
    (m.unknownUnits > 0 ? ` · без себестоимости ${RU(m.unknownUnits)} шт` : "")
  );
}

/**
 * Строка товара. Хвост «без себестоимости N шт» обязателен ровно так же, как у
 * автомата (R-P5b-2): без него товар, у которого цены закупки нет, печатается
 * как «маржа 60 000 (100 %)» — лучшая строка списка, хотя затрат по ней просто
 * не посчитали.
 */
export function товарСтрока(p: MarginProduct): string {
  const тревога = p.low ? " ⚠️" : "";
  return (
    `• ${p.product}: маржа ${RU(p.margin)} (${PCT(p.pct)})${тревога} · ${RU(p.qty)} шт · выручка ${RU(p.revenue)}` +
    (p.unknownUnits > 0 ? ` · без себестоимости ${RU(p.unknownUnits)} шт` : "")
  );
}

/** Маржа снек-автоматов сообщениями Telegram. */
export function formatMargin(r: MarginReport & WithWarnings): string[] {
  const title = `💰 Маржа снек-автоматов (OurVend) за ${r.days} дн. (${день(r.from)} — ${день(r.to)})`;
  const lines: string[] = [];

  // Пусто — это НЕ «маржа ноль»: чаще всего это сбой сбора продаж. Нули
  // прочитались бы как посчитанный результат.
  if (r.machines.length === 0 || r.totals.revenue === 0) {
    lines.push(`Считать нечего — продаж за ${r.days} дн. нет.`);
    lines.push(...исключённые(r));
    lines.push(...предупреждения(r.warnings, ПОКРЫТО_МАРЖОЙ));
    return capped(title, lines, "Маржа");
  }

  const t = r.totals;
  lines.push(`Итого: выручка ${RU(t.revenue)}, маржа ${RU(t.margin)} (${PCT(t.pct)}) · ${RU(t.qty)} шт`);
  // Строка обязательна при любом unknownUnits: без неё завышение маржи
  // невидимо, а именно оно и есть цена этого отчёта (R-P5b-2).
  if (t.unknownUnits > 0) {
    const имена = r.unknownProducts.length > 0 ? `: ${r.unknownProducts.join(", ")}` : "";
    lines.push(
      `⚠️ ${RU(t.unknownUnits)} шт без себестоимости — на их выручку маржа завышена${имена}`,
    );
  }

  lines.push("", "Автоматы (по деньгам):");
  for (const m of r.machines) lines.push(машинаСтрока(m));

  if (r.products.length > 0) {
    lines.push("", `Товары (топ ${Math.min(PRODUCTS_SHOWN, r.products.length)} по марже):`);
    for (const p of r.products.slice(0, PRODUCTS_SHOWN)) lines.push(товарСтрока(p));
    // Убыточные и низкомаржинальные — отдельно и с конца списка: в топе их не
    // видно, а решение владельца принимается именно по ним.
    // …и только те, что НЕ попали в топ: на коротком каталоге (34 SKU на
    // проде, а в окне бывает и три) оба списка совпадали строка в строку, и
    // отчёт печатал один и тот же товар дважды под разными заголовками.
    const показаны = new Set(r.products.slice(0, PRODUCTS_SHOWN));
    const слабые = r.products.filter((p) => p.low && !показаны.has(p)).slice(-PRODUCTS_SHOWN);
    if (слабые.length > 0) {
      lines.push("", `Ниже ${r.lowPct} % или в минус (${слабые.length}, кроме показанных выше):`);
      for (const p of слабые) lines.push(товарСтрока(p));
    }
  }

  lines.push(...исключённые(r));
  lines.push(...предупреждения(r.warnings, ПОКРЫТО_МАРЖОЙ));
  return capped(title, lines, "Маржа");
}

/** Строка мёртвой позиции: где лежит, сколько и на сколько денег. */
export function мёртваяСтрока(d: DeadRow): string {
  const где = d.machineName ? `${d.machineName} · ` : d.serial ? `${d.serial} · ` : "";
  // «Цены нет» — не «ноль сум»: складывать такие нули как деньги нельзя.
  const деньги = d.noPrice ? "цена закупки неизвестна" : `≈ ${RU(d.value)} сум`;
  return `• ${где}${d.product} ${RU(d.qty)} шт — ${деньги}`;
}

/**
 * Раздел мёртвого стока: дорогие позиции сверху, хвост назван числом.
 *
 * Обрезанный список обязан сказать, что он обрезан, И где лежит целиком:
 * молчаливый хвост читается как «это всё», и владелец считает, что мёртвого
 * стока ровно на показанную сумму.
 */
function мёртвыйРаздел(title: string, rows: DeadRow[], lines: string[]): void {
  if (rows.length === 0) return;
  lines.push("", `${title} (${RU(rows.length)}):`);
  for (const d of rows.slice(0, DEAD_ROWS_SHOWN)) lines.push(мёртваяСтрока(d));
  if (rows.length > DEAD_ROWS_SHOWN) {
    lines.push(`…и ещё ${RU(rows.length - DEAD_ROWS_SHOWN)} поз. — весь список на листе «Мёртвый сток» в панели.`);
  }
}

/** Мёртвый сток снек-контура сообщениями Telegram. */
export function formatDeadStock(r: DeadStockReport & WithWarnings): string[] {
  const title = `🪦 Мёртвый сток снек-автоматов (OurVend) за ${r.days} дн.`;
  const всего = r.warehouse.length + r.machines.length;
  const lines: string[] = [];

  if (всего === 0) {
    // «Двигалось всё» — утверждение о ДВИЖЕНИИ, и оно ложно, когда продаж не
    // приехало вовсе: тогда двигаться было нечему. Разницу называет Core
    // кодом `no_sales`, и хвост предупреждений тут обязателен.
    lines.push(`Мёртвых позиций нет: за ${r.days} дн. двигалось всё, что лежит на складе и в автоматах.`);
    lines.push(...предупреждения(r.warnings, ПОКРЫТО_СТОКОМ));
    return capped(title, lines, "Мёртвый сток");
  }

  lines.push(
    `Склад и автоматы: нет движения ${r.days} дн., ${RU(всего)} поз., оценка ≈ ${RU(r.totalValue)} сум ` +
      `(считаем с ${день(r.since)}).`,
  );
  if (r.noPriceCount > 0) {
    lines.push(`⚠️ У ${RU(r.noPriceCount)} поз. цена закупки неизвестна — в оценку они не вошли.`);
  }

  мёртвыйРаздел("📦 На складе", r.warehouse, lines);
  мёртвыйРаздел("🎰 В автоматах", r.machines, lines);
  lines.push(...предупреждения(r.warnings, ПОКРЫТО_СТОКОМ));
  return capped(title, lines, "Мёртвый сток");
}

export const изменениеСтрока = (c: PriceChange): string =>
  `• ${c.product}: ${RU(c.from)} → ${RU(c.to)} (${ЗНАК(c.pct)}) · ${день(c.at)}`;

function лентаЦен(title: string, rows: PriceChange[], lines: string[]): void {
  if (rows.length === 0) return;
  lines.push("", `${title} (${rows.length}):`);
  for (const c of rows.slice(0, CHANGES_SHOWN)) lines.push(изменениеСтрока(c));
  if (rows.length > CHANGES_SHOWN) {
    lines.push(`…и ещё ${rows.length - CHANGES_SHOWN} изменений — весь список на листе «Цены» в панели.`);
  }
}

/** Изменения цен: закупочные и витринные, свежие сверху. */
export function formatPriceChanges(r: PriceChangesReport & WithWarnings): string[] {
  const title = `📈 Цены снек-автоматов (OurVend) за ${r.days} дн. · порог ${r.pct} %`;
  const lines: string[] = [];
  if (r.purchase.length === 0 && r.retail.length === 0) {
    // «Изменений нет» и «продаж не приехало» — разные новости: витринная лента
    // строится из продаж, и без них она пуста независимо от цен.
    lines.push(`Заметных изменений цен за ${r.days} дн. нет (порог ${r.pct} %).`);
    lines.push(...предупреждения(r.warnings));
    return capped(title, lines, "Цены");
  }
  лентаЦен("🛒 Закупочные (что платим)", r.purchase, lines);
  лентаЦен("🏷 Витринные (что берём в автомате)", r.retail, lines);
  lines.push(...предупреждения(r.warnings));
  return capped(title, lines, "Цены");
}

/** Строка разрыва: факт против эталона и что с этим делать. */
function разрывСтрока(g: PriceGapRow): string {
  const сторона = g.gap > 0 ? "ниже" : "выше";
  const хвост =
    g.lost > 0
      ? `недобор ≈ ${RU(g.lost)} сум`
      : `продали дороже эталона на ≈ ${RU(-g.lost)} сум — проверь эталон`;
  return (
    `• ${g.product}: факт ${RU(g.fact)} · эталон ${RU(g.reference)} · ${сторона} на ${Math.abs(g.gapPct)} % · ` +
    `${RU(g.qty)} шт → ${хвост}`
  );
}

/** Витрина против эталона владельца (R-P5b-6). */
export function formatPriceGap(r: PriceGapReport & WithWarnings): string[] {
  const title = `🏷 Витрина снек-автоматов (OurVend) за ${r.days} дн. · порог ${r.pct} %`;
  const lines: string[] = [];
  const недобор = r.rows.filter((g) => g.lost > 0);
  const дороже = r.rows.filter((g) => g.lost <= 0);

  if (r.rows.length === 0) {
    lines.push(
      r.noReference.length > 0
        ? `Там, где эталон задан, витрина сходится: расхождений больше ${r.pct} % нет.`
        : `Витрина сходится с эталоном: расхождений больше ${r.pct} % нет.`,
    );
  } else {
    // Сумма — ТОЛЬКО по недобору: «продали дороже» не выручка, которой можно
    // закрыть недобор, а повод перепроверить сам эталон (R-P5b-6).
    lines.push(`Σ недобор ≈ ${RU(r.lostTotal)} сум по ${недобор.length} поз. за ${r.days} дн.`);
    if (дороже.length > 0) {
      lines.push(`Продаём дороже эталона: ${дороже.length} поз. — в сумму недобора не входят.`);
    }
    lines.push("");
    const строки = [...недобор, ...дороже];
    for (const g of строки.slice(0, GAP_ROWS_SHOWN)) lines.push(разрывСтрока(g));
    if (строки.length > GAP_ROWS_SHOWN) {
      lines.push(
        `…и ещё ${RU(строки.length - GAP_ROWS_SHOWN)} поз. — весь список на листе «Цены» в панели.`,
      );
    }
  }

  // Товары без эталона — отдельным списком: нулевая строка выглядела бы как
  // «эталон ноль» и дала бы разрыв в 100 %.
  if (r.noReference.length > 0) {
    lines.push(
      "",
      `эталон не задан (${r.noReference.length}): ${r.noReference.join(", ")}`,
      "«цена продажи <товар> <сум>» — задать вручную, «витрина как факт» — проставить по факту продаж.",
    );
  }
  lines.push(...предупреждения(r.warnings, ПОКРЫТО_ВИТРИНОЙ));
  return capped(title, lines, "Цены");
}

/** Ответ на «цена продажи …»: успех, гейт по факту витрины или «не найден». */
export function formatSalePriceResult(r: SetSalePriceResult): string {
  if (r.ok) {
    const было = r.oldPrice === null || r.oldPrice === undefined ? "не была задана" : `${RU(r.oldPrice)} сум`;
    return [
      `🏷 Эталон витрины «${r.product}»: ${было} → ${RU(r.newPrice ?? 0)} сум.`,
      "",
      "«витрина» — посмотреть, где факт продаж разошёлся с эталоном.",
    ].join("\n");
  }
  if (r.reason === "spike") {
    const факт = r.factPrice === null || r.factPrice === undefined ? "неизвестен" : `${RU(r.factPrice)} сум`;
    return [
      `⚠️ Эталон ${RU(r.newPrice ?? 0)} сум отличается от ФАКТА витрины ${факт} на ${r.deviationPct}%.`,
      "",
      "Факт — средняя цена продаж за 14 дн. (деньги ÷ штуки), эталон — твоя цена, по которой должно продаваться.",
      `Если так и задумано — повтори со словом «точно»: «цена продажи ${r.product} ${r.newPrice} точно».`,
    ].join("\n");
  }
  return `Товар «${r.product ?? "?"}» не найден в прайсе вендинга. Имя должно совпадать с карточкой товара или её алиасом.`;
}

/** Ответ на «витрина как факт»: что проставили и что пропустили — с причинами. */
export function formatSalePriceBootstrap(r: BootstrapSalePriceResult): string[] {
  const title = `🏷 Витрина как факт — эталон снек-автоматов (OurVend) по продажам за ${r.days} дн.`;
  const уже = r.skipped.filter((s) => s.reason === "already_set");
  const безПродаж = r.skipped.filter((s) => s.reason === "no_sales");
  const lines: string[] = [];

  if (r.set.length === 0) {
    lines.push(
      `Проставлять нечего: эталон уже задан ${уже.length} поз., без продаж за ${r.days} дн. — ${безПродаж.length} поз.`,
    );
    return capped(title, lines, "Цены");
  }

  lines.push(`Проставлено ${r.set.length} поз. — теперь это ЭТАЛОН, а не факт: дальше он не двигается сам.`);
  lines.push("");
  for (const s of r.set) lines.push(`• ${s.product} — ${RU(s.price)} сум (по ${RU(s.qty)} шт продаж)`);
  if (r.skipped.length > 0) {
    lines.push("", `Пропущено ${r.skipped.length}: эталон уже задан ${уже.length}, нет продаж ${безПродаж.length}.`);
    if (безПродаж.length > 0) {
      lines.push(`Без продаж: ${безПродаж.map((s) => s.product).join(", ")} — задай вручную «цена продажи …».`);
    }
  }
  return capped(title, lines, "Цены");
}

/**
 * Возраст снимка. `null` — снимков НЕТ вовсе, а это не «свежо».
 *
 * Проверка нестрогая (`== null`) намеренно: поле может не приехать вовсе
 * (старый Core, форма без `productSaleLagH`), и строгое `=== null` печатало бы
 * владельцу «витрина (product_sale) — не число ч» — то есть отчёт о свежести,
 * который сам себя не понял.
 */
const лагМин = (v: number | null | undefined): string =>
  v == null ? "снимков нет" : v < 90 ? `${RU(v)} мин` : `${RU(v / 60)} ч`;
const лагЧ = (v: number | null | undefined): string => (v == null ? "снимков нет" : `${RU(v)} ч`);

/**
 * «сверка» — здоровье сбора OurVend и паритет одним сообщением (R-P5b-8).
 *
 * Живого запроса к OurVend из бота нет (коннектор живёт в агентах по крону),
 * и делать вид, что «сверка» ходит в кабинет, нельзя. Ответ честный: когда
 * сбор работал в последний раз, насколько свежи снимки и сходятся ли наши
 * числа со stock-дорожкой.
 */
export function formatOurvendHealth(h: OurvendHealth): string[] {
  const title = "🩺 Сверка снек-автоматов (OurVend): сбор и паритет";
  const lines: string[] = [];

  // НИ ОДНОГО ПРОГОНА — ЭТО НЕ «ЗДОРОВ». Зелёная галка над «последний успех:
  // не было» — ровно те «нули как всё хорошо», против которых §7: серия
  // отказов равна нулю просто потому, что сбор ни разу не запускался.
  if (h.runs.length === 0) {
    lines.push(
      "❓ Прогонов сбора за период нет — здоровье не оценить: сбор не запускался или журнал прогонов пуст.",
      `Последний успех: ${момент(h.lastSuccessAt)}.`,
    );
  } else if (h.failedStreak > 0) {
    lines.push(
      `❌ ${RU(h.failedStreak)} ${сущ(h.failedStreak, "отказ", "отказа", "отказов")} подряд — ` +
        `сбор стоит, свежих данных нет. Последний успех: ${момент(h.lastSuccessAt)}.`,
    );
  } else {
    lines.push(`✅ Отказов подряд нет. Последний успех: ${момент(h.lastSuccessAt)}.`);
  }

  const успешных = h.runs.filter((r) => r.status === "success").length;
  const частичных = h.runs.filter((r) => r.status === "partial").length;
  const отказов = h.runs.filter((r) => r.status === "failed").length;
  if (h.runs.length > 0) {
    lines.push(
      `Прогоны (${h.runs.length}): успешных ${успешных} · частичных ${частичных} · с отказом ${отказов}`,
    );
  }
  lines.push(
    `Свежесть: слоты — ${лагМин(h.slotsLagMin)} · продажи — ${лагЧ(h.salesLagH)} · ` +
      `витрина (product_sale) — ${лагЧ(h.productSaleLagH)}`,
  );

  const p = h.parity;
  lines.push(
    `Паритет за ${p.days} дн.: ${p.ok ? "✅ сходится" : `❌ расхождений ${RU(p.mismatches)}`} · ` +
      `остатки ${p.stockOk ? "✅" : "❌"}${p.note ? ` · ${p.note}` : ""}`,
  );

  const проблемные = h.runs.filter((r) => r.status !== "success" && r.error).slice(0, RUNS_SHOWN);
  if (проблемные.length > 0) {
    lines.push("", "Последние отказы:");
    for (const r of проблемные) {
      lines.push(`• ${момент(r.startedAt)} — ${r.status}, автоматов ${r.machinesOk}/${r.machinesTotal}: ${r.error}`);
    }
  }
  return capped(title, lines, "Снек · Здоровье сбора");
}
