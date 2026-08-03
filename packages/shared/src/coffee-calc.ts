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
