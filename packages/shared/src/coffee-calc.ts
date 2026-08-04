/**
 * Расчётное ядро кофе-бункеров (ручные кофемашины, без сетевого сбора).
 *
 * Чистые детерминированные функции без инфраструктуры — тот же приём, что и
 * `vending-calc.ts`: ядро переиспользуется и в Core, и в панели. Модель
 * сверена с рабочим референс-приложением владельца (vendhubunker) и портирована
 * с трёх независимых доноров (VendHub-OS Container/ContainerWeighing,
 * mydon-command-center BunkerWeighing/reconcile, mydon-agent-os refill_events) —
 * везде одна и та же форма: точка → позиция бункера (1–8) → физический
 * контейнер («набор» 1–27, тара которого известна из калибровки) → вес.
 */

/** Чистый вес ингредиента = вес после засыпки − тара контейнера. null — тара не откалибрована. */
export function netWeight(filledWeight: number, tareWeight: number | null): number | null {
  if (tareWeight === null) return null;
  return filledWeight - tareWeight;
}

/**
 * Расход с прошлой заливки этой же позиции на этой же точке: сколько ушло в
 * автомат между предыдущей заливкой и следующим замером «до досыпки».
 *
 * `prevFilledNet` — чистый вес СРАЗУ ПОСЛЕ прошлой заливки; `measuredBeforeNet`
 * — чистый вес, который техник застал ПЕРЕД тем как досыпать сейчас. Расход
 * отрицательным быть не должен (досыпали больше, чем было — телеметрия
 * противоречит сама себе): в этом случае считаем расход неизвестным (null),
 * а не выдумываем отрицательное число.
 */
export function consumedSince(prevFilledNet: number | null, measuredBeforeNet: number | null): number | null {
  if (prevFilledNet === null || measuredBeforeNet === null) return null;
  const delta = prevFilledNet - measuredBeforeNet;
  return delta >= 0 ? delta : null;
}

/**
 * Себестоимость расхода: грамм × цена за грамм (`coffee_ingredient.purchasePrice`).
 * null — цена не заведена: себестоимость неизвестна, а не ноль (тот же приём,
 * что и `recipeCost()`/`consumptionReport()` в `recipe.ts`/`consumption.ts` —
 * непосчитанное не выдаётся за посчитанный ноль).
 */
export function costOf(grams: number | null, pricePerGram: number | null): number | null {
  if (grams === null || pricePerGram === null) return null;
  return grams * pricePerGram;
}

export type FillStatus = "ok" | "underfill" | "unknown";

export interface FillCheckResult {
  status: FillStatus;
  /** Фактический чистый вес / эталон, доля (1 = точно по норме). null — не с чем сравнить. */
  fillRatio: number | null;
}

/** Ниже какой доли от эталона заливка считается недоливом (решение как у доноров: 85%). */
export const UNDERFILL_RATIO = 0.85;

/**
 * Недолив бункера: сравнивает фактический ЧИСТЫЙ вес после заливки
 * (`netWeight()`) с эталонным (`coffee_bunker_config.targetFillWeight`).
 * Нет эталона или веса — `unknown`, а не молчаливый `ok`: отсутствие сигнала
 * не должно читаться как «всё в порядке».
 */
export function fillStatus(netFillWeight: number | null, targetFillWeight: number | null, threshold = UNDERFILL_RATIO): FillCheckResult {
  if (netFillWeight === null || targetFillWeight === null || targetFillWeight <= 0) {
    return { status: "unknown", fillRatio: null };
  }
  const fillRatio = netFillWeight / targetFillWeight;
  return { status: fillRatio < threshold ? "underfill" : "ok", fillRatio };
}

export type ReconcileStatus = "ok" | "anomaly" | "unknown";

export interface ReconcileResult {
  status: ReconcileStatus;
  /** actual − expected, г. null, если сверить не с чем (unknown). */
  deltaGrams: number | null;
  /** |delta| / expected, доля (0.1 = 10%). null при expected=0 или unknown. */
  deltaRatio: number | null;
}

/** Порог расхождения факт/ожидание, за которым — сигнал на разбор (решение как у доноров: 10%). */
export const RECONCILE_THRESHOLD_RATIO = 0.1;

/**
 * Сверка факта и ожидания расхода ингредиента.
 *
 * `actualGrams` — из веса бункеров (`consumedSince`), `expectedGrams` — из
 * проданных чашек × состав (`consumptionReport()` в `consumption.ts`,
 * `coffee_sale × coffee_product.recipe`). Разошлись больше чем на
 * `RECONCILE_THRESHOLD_RATIO` — `anomaly` (перелив, хищение, неучтённые
 * продажи); нечем сверить (нет одной из сторон) — `unknown`, а не молчаливый ok.
 */
export function reconcileConsumption(
  actualGrams: number | null,
  expectedGrams: number | null,
  threshold = RECONCILE_THRESHOLD_RATIO,
): ReconcileResult {
  if (actualGrams === null || expectedGrams === null) return { status: "unknown", deltaGrams: null, deltaRatio: null };
  const deltaGrams = actualGrams - expectedGrams;
  if (expectedGrams === 0) {
    // Ожидание нулевое (продаж не было) — любое фактическое списание уже расхождение.
    return { status: actualGrams > 0 ? "anomaly" : "ok", deltaGrams, deltaRatio: null };
  }
  const deltaRatio = Math.abs(deltaGrams) / expectedGrams;
  return { status: deltaRatio > threshold ? "anomaly" : "ok", deltaGrams, deltaRatio };
}

// ── Сводная таблица (CC «Таблица»): последняя заливка на (точка, позиция) ──

export interface LatestRefillRow {
  locationName: string;
  position: number;
  packageCount: number;
  filledWeight: number;
}

export interface BunkerCell {
  packageCount: number;
  weight: number;
}

export interface LocationSummaryRow {
  location: string;
  /** Позиция 1–8 → последняя заливка. Пусто — по этой позиции ещё не вносили. */
  byPosition: Record<number, BunkerCell>;
}

/**
 * Свести последние заливки в матрицу «точка × позиция 1–8» для сводной
 * таблицы. Каждая точка присутствует в результате, даже если по ней ещё
 * ничего не вносили (пустая строка) — сводка не должна молча терять адрес.
 */
export function buildLocationSummary(locations: readonly string[], latest: readonly LatestRefillRow[]): LocationSummaryRow[] {
  const byLocation = new Map<string, LocationSummaryRow>();
  for (const name of locations) byLocation.set(name, { location: name, byPosition: {} });
  for (const r of latest) {
    const row = byLocation.get(r.locationName) ?? { location: r.locationName, byPosition: {} };
    row.byPosition[r.position] = { packageCount: r.packageCount, weight: r.filledWeight };
    byLocation.set(r.locationName, row);
  }
  return locations.map((name) => byLocation.get(name)!);
}

// ── Возвраты наборов: разбор строк «позиция. набор. вес» ────────────────────

export interface ReturnLine {
  position: number;
  containerNumber: number;
  /** Вес брутто (с тарой), г — как написали в сообщении. */
  weight: number;
}

export interface ParsedReturnMessage {
  returns: ReturnLine[];
  /** Заголовок сообщения («Кпп остатки») — подсказка точки, сырьём. */
  locationNote: string | null;
  /** Строки, похожие на возврат, но с числами вне диапазонов — на разбор глазами. */
  rejected: string[];
}

const RETURN_LINE = /^(\d{1,2})[.\s]+(\d{1,3})[.\s]+(\d{1,5})\s*\.?$/;

/**
 * Разобрать сообщение о возвратах наборов. Формат из рабочей группы владельца:
 * строка «позиция. набор. вес» (напр. «1. 027. 787», допускаются пробелы вместо
 * точек — «7  024. 936»). Первая строка без чисел («Кпп остатки») — подсказка
 * точки, сохраняется как есть. Числа вне диапазонов (позиция 1–8, набор 1–27,
 * вес ≤10000) не «чинятся», а уходят в rejected — решает человек.
 */
export function parseContainerReturnMessage(text: string): ParsedReturnMessage {
  const returns: ReturnLine[] = [];
  const rejected: string[] = [];
  let locationNote: string | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const m = RETURN_LINE.exec(line);
    if (!m) {
      if (locationNote === null && returns.length === 0 && rejected.length === 0) locationNote = line;
      continue;
    }
    const position = Number(m[1]);
    const containerNumber = Number(m[2]);
    const weight = Number(m[3]);
    if (position >= 1 && position <= 8 && containerNumber >= 1 && containerNumber <= 27 && weight <= 10000) {
      returns.push({ position, containerNumber, weight });
    } else {
      rejected.push(line);
    }
  }

  // Ни одной валидной строки — это не сообщение о возвратах, заголовок не в счёт.
  if (returns.length === 0 && rejected.length === 0) return { returns: [], locationNote: null, rejected: [] };
  return { returns, locationNote, rejected };
}

// ── Расход по наборам: заливка − возврат через тару ─────────────────────────

/** Заливка для сопоставления с возвратом (нетто уже посчитан через тару). */
export interface ContainerFillEvent {
  /** Дата заливки ISO (YYYY-MM-DD). */
  date: string;
  position: number;
  containerNumber: number;
  /** Нетто засыпанного, г; null — тара набора не калибрована. */
  netWeight: number | null;
  /** Точка заливки — расход относится к ней. */
  locationId: string;
  locationName: string;
}

/** Возврат для сопоставления (нетто через ту же тару). */
export interface ContainerReturnEvent {
  date: string;
  position: number;
  containerNumber: number;
  netWeight: number | null;
}

export interface ContainerConsumptionRow {
  containerNumber: number;
  position: number;
  locationId: string;
  locationName: string;
  fillDate: string;
  returnDate: string;
  fillNet: number | null;
  returnNet: number | null;
  /**
   * Израсходовано, г: fillNet − returnNet. null — посчитать честно нельзя
   * (нет тары, либо возврат тяжелее заливки — противоречие, не «0»).
   */
  consumedGrams: number | null;
}

/**
 * Сопоставить возвраты наборов с заливками: возврат закрывает БЛИЖАЙШУЮ
 * предыдущую заливку того же (набор, позиция), ещё не закрытую другим
 * возвратом. Физика процесса: набор засыпали на точке → он стоял → его
 * сняли и взвесили. Разница нетто — фактический расход ингредиента на точке
 * между визитами, безо всякой телеметрии.
 *
 * Возврат без предыдущей заливки (история началась с возврата) пропускается —
 * расход по нему неизвестен, выдумывать нечего.
 */
export function matchReturnsToRefills(
  fills: readonly ContainerFillEvent[],
  returns: readonly ContainerReturnEvent[],
): ContainerConsumptionRow[] {
  // По (набор, позиция): события в хронологии, заливки и возвраты вперемешку.
  const key = (e: { containerNumber: number; position: number }) => `${e.containerNumber}:${e.position}`;
  const fillsByKey = new Map<string, ContainerFillEvent[]>();
  for (const f of fills) {
    const list = fillsByKey.get(key(f)) ?? [];
    list.push(f);
    fillsByKey.set(key(f), list);
  }
  for (const list of fillsByKey.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const rows: ContainerConsumptionRow[] = [];
  const sortedReturns = [...returns].sort((a, b) => a.date.localeCompare(b.date));
  const consumedFillIdx = new Map<string, number>(); // сколько заливок пары уже закрыто

  for (const r of sortedReturns) {
    const k = key(r);
    const list = fillsByKey.get(k) ?? [];
    const from = consumedFillIdx.get(k) ?? 0;
    // Ближайшая ещё не закрытая заливка с датой ≤ даты возврата.
    let picked = -1;
    for (let i = from; i < list.length; i++) {
      if (list[i]!.date <= r.date) picked = i;
      else break;
    }
    if (picked < 0) continue; // возврат без заливки в истории — расход неизвестен
    consumedFillIdx.set(k, picked + 1);
    const fill = list[picked]!;
    const consumed =
      fill.netWeight !== null && r.netWeight !== null && fill.netWeight >= r.netWeight
        ? fill.netWeight - r.netWeight
        : null;
    rows.push({
      containerNumber: r.containerNumber,
      position: r.position,
      locationId: fill.locationId,
      locationName: fill.locationName,
      fillDate: fill.date,
      returnDate: r.date,
      fillNet: fill.netWeight,
      returnNet: r.netWeight,
      consumedGrams: consumed,
    });
  }
  return rows;
}
