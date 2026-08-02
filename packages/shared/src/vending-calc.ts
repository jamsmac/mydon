/**
 * Расчётное ядро вендинга (ТЗ «Вендинг-операции», раздел 5).
 *
 * Чистые детерминированные функции без инфраструктуры: те же входные данные →
 * те же числа. Специально стек-независимо (ни БД, ни коннектора, ни tRPC) —
 * ядро переиспользуется и в Core, и в панели, и в отчётах. Формулы приведены в
 * том виде, в каком проверены на боевых данных; воспроизводит контрольный пример
 * (Приложение Г) до единицы — см. vending-calc.test.ts.
 */

/** Валидной считаем вместимость 0 < capacity ≤ MAX_CAPACITY (порог — настройка). */
export const MAX_CAPACITY = 100;
/** Автомат «uncalibrated», если валидных слотов меньше этой доли от слотов с товаром. */
export const UNCALIBRATED_RATIO = 0.5;
/** Кратности по умолчанию (решение владельца 02.08.2026): напитки 12, снеки 10. */
export const PACK_DRINK = 12;
export const PACK_SNACK = 10;

export type Category = "drink" | "snack" | "other";
export type PlanogramStatus = "ok" | "no_slots" | "uncalibrated";

/** Кратность закупки по категории (если у товара не задана своя `pack_size`). */
export function packForCategory(category: Category): number {
  return category === "drink" ? PACK_DRINK : PACK_SNACK;
}

/**
 * Ключ имени товара для сопоставления с алиасами. Рукописные листы и Ourvend
 * пишут одно и то же по-разному («Coca Cola cl», «Coca cola classic can 0.25»):
 * приводим к нижнему регистру, сводим пробелы и ё→е, чтобы регистр и лишние
 * пробелы не мешали точному соответствию. Разные формулировки покрываются
 * самими алиасами — здесь только нормализация, не нечёткое сравнение.
 */
export function normalizeProductName(name: string): string {
  return name.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

// ── §5.1 Валидность слота и статус автомата ─────────────────────────────────

export interface Slot {
  coilId: string;
  /** Имя товара; пусто/null — слот не назначен. */
  product: string | null;
  capacity: number;
  quantity: number;
}

/** Слот валиден: 0 < capacity ≤ maxCapacity. */
export function slotValid(s: Slot, maxCapacity = MAX_CAPACITY): boolean {
  return s.capacity > 0 && s.capacity <= maxCapacity;
}

const hasProduct = (s: Slot): boolean => typeof s.product === "string" && s.product.trim().length > 0;

/**
 * Статус планограммы автомата. `no_slots` — ни один слот не назначен;
 * `uncalibrated` — валидных меньше половины от назначенных (нужен Audit на
 * стороне вендора); иначе `ok`. Только `ok`-автоматы идут в расчёт.
 */
export function planogramStatus(
  slots: Slot[],
  maxCapacity = MAX_CAPACITY,
  ratio = UNCALIBRATED_RATIO,
): PlanogramStatus {
  const withProduct = slots.filter(hasProduct);
  if (withProduct.length === 0) return "no_slots";
  const valid = withProduct.filter((s) => slotValid(s, maxCapacity));
  if (valid.length < withProduct.length * ratio) return "uncalibrated";
  return "ok";
}

// ── §5.2 Дефицит ────────────────────────────────────────────────────────────

/** Дефицит слота: capacity − min(quantity, capacity). Защита от битых остатков. */
export function slotDeficit(s: Slot): number {
  return Math.max(0, s.capacity - Math.min(s.quantity, s.capacity));
}

export interface MachineDeficit {
  deficit: number;
  capacity: number;
  filled: number;
  /** Заполненность, %: round(filled / capacity × 100); capacity 0 → 0. */
  fillRate: number;
}

/** Дефицит и заполненность автомата — по ВАЛИДНЫМ слотам. */
export function machineDeficit(slots: Slot[], maxCapacity = MAX_CAPACITY): MachineDeficit {
  const valid = slots.filter((s) => slotValid(s, maxCapacity));
  let deficit = 0;
  let capacity = 0;
  let filled = 0;
  for (const s of valid) {
    const q = Math.min(s.quantity, s.capacity);
    deficit += s.capacity - q;
    capacity += s.capacity;
    filled += q;
  }
  return { deficit, capacity, filled, fillRate: capacity === 0 ? 0 : Math.round((filled / capacity) * 100) };
}

/** Цвет автомата в отчётах по дефициту (пороги — настройка). */
export function deficitColor(deficit: number, red = 100, yellow = 50): "red" | "yellow" | "green" {
  if (deficit >= red) return "red";
  if (deficit >= yellow) return "yellow";
  return "green";
}

// ── §5.3 Потребность по товарам (по ok-автоматам, с разбивкой) ───────────────

export interface MachineSlots {
  machineId: string;
  slots: Slot[];
}

export interface ProductNeed {
  product: string;
  /** Дефицит по каждому автомату: machineId → единицы. */
  perMachine: Record<string, number>;
  /** Суммарная потребность = Σ perMachine. */
  total: number;
}

/**
 * Потребность по товарам среди переданных автоматов (ожидается, что переданы
 * только `ok`). Разбивка по автоматам сохраняется — она нужна в закупе и
 * накладной. Учитываются только валидные слоты с назначенным товаром.
 */
export function needByProduct(machines: MachineSlots[], maxCapacity = MAX_CAPACITY): ProductNeed[] {
  const byProduct = new Map<string, ProductNeed>();
  for (const m of machines) {
    for (const s of m.slots) {
      if (!hasProduct(s) || !slotValid(s, maxCapacity)) continue;
      const def = slotDeficit(s);
      if (def <= 0) continue;
      const name = (s.product as string).trim();
      const entry = byProduct.get(name) ?? { product: name, perMachine: {}, total: 0 };
      entry.perMachine[m.machineId] = (entry.perMachine[m.machineId] ?? 0) + def;
      entry.total += def;
      byProduct.set(name, entry);
    }
  }
  return [...byProduct.values()];
}

// ── §5.4–5.5 Учёт склада, закуп: кратность и стоимость ───────────────────────

export interface PriceEntry {
  /** Закупочная цена за единицу, сум. */
  price: number;
  /** Кратность упаковки (products.pack_size). */
  pack: number;
}

export interface PurchaseRow {
  product: string;
  perMachine: Record<string, number>;
  /** Потребность = Σ perMachine (можно не передавать — посчитаем). */
  need?: number;
  /** Остаток склада. */
  stock: number;
  /** Продажи за 7 дней (для пометки «нет продаж»). */
  sold7: number;
}

export interface PurchaseItem {
  product: string;
  perMachine: Record<string, number>;
  need: number;
  stock: number;
  /** Закроется складом: min(stock, need). */
  covered: number;
  /** Надо купить: max(0, need − stock). */
  buy: number;
  /** Останется на складе: max(0, stock − need). */
  surplus: number;
  pack: number;
  /** Заказать с округлением до упаковки (или = buy, если round=false). */
  order: number;
  /** Уйдёт в запас: order − buy. */
  extra: number;
  price: number;
  costExact: number; // buy × price
  costRounded: number; // order × price
  /** Нет цены в прайсе — из денежных сумм исключён. */
  noPrice: boolean;
  /** Дефицит есть, но продаж за 7 дней нет — «не закупать». */
  noSales: boolean;
}

export interface PurchaseSummary {
  /** Позиции к закупу (участвуют в итогах). */
  items: PurchaseItem[];
  /** «Не закупать — нет продаж»: показываются отдельно, в итоги НЕ входят. */
  excludedNoSales: PurchaseItem[];
  /** Товары без цены в прайсе — на разбор менеджеру. */
  noPrice: string[];
  totalNeed: number;
  totalCovered: number;
  totalBuy: number;
  totalOrder: number;
  /** Строго по нехватке: Σ buy × price. */
  costExact: number;
  /** С округлением до упаковок: Σ order × price. */
  costRounded: number;
  /** Переплата за округление: costRounded − costExact. */
  overpay: number;
  /** «Закуп по прайсу» (§8.1): полный дефицит по прайсу, без склада и округления. */
  costByPriceFull: number;
}

export interface PurchaseOptions {
  /** Округлять до упаковок (иначе order = buy). По умолчанию да. */
  round?: boolean;
  /** Включать позиции без продаж в закуп и итоги. По умолчанию нет (§5.5). */
  includeNoSales?: boolean;
  maxCapacity?: number;
}

/**
 * Сводный закуп: потребность − склад, округление до упаковок, суммы (§5.4–5.5).
 * Показывает ОБЕ суммы и переплату — это управленческое решение, а не деталь.
 * Позиции без цены исключаются из денег; позиции без продаж по умолчанию
 * выносятся в отдельную группу и в итоги не входят (переключается опцией).
 */
export function computePurchase(
  input: PurchaseRow[],
  prices: Map<string, PriceEntry>,
  opts: PurchaseOptions = {},
): PurchaseSummary {
  const round = opts.round ?? true;
  const includeNoSales = opts.includeNoSales ?? false;

  const items: PurchaseItem[] = [];
  const excludedNoSales: PurchaseItem[] = [];
  const noPrice: string[] = [];

  let totalNeed = 0;
  let totalCovered = 0;
  let totalBuy = 0;
  let totalOrder = 0;
  let costExact = 0;
  let costRounded = 0;
  let costByPriceFull = 0;

  for (const row of input) {
    const need = row.need ?? Object.values(row.perMachine).reduce((a, b) => a + b, 0);
    if (need <= 0) continue;

    const price = prices.get(row.product);
    const stock = row.stock;
    const covered = Math.min(stock, need);
    const buy = Math.max(0, need - stock);
    const surplus = Math.max(0, stock - need);
    const pack = price?.pack ?? 1;
    const order = !round ? buy : buy === 0 ? 0 : Math.ceil(buy / pack) * pack;
    const unit = price?.price ?? 0;

    const item: PurchaseItem = {
      product: row.product,
      perMachine: row.perMachine,
      need,
      stock,
      covered,
      buy,
      surplus,
      pack,
      order,
      extra: order - buy,
      price: unit,
      costExact: buy * unit,
      costRounded: order * unit,
      noPrice: price === undefined,
      noSales: row.sold7 <= 0,
    };

    if (item.noPrice) noPrice.push(row.product);

    // Полный дефицит по прайсу — по всем позициям с ценой (§8.1).
    if (!item.noPrice) costByPriceFull += need * unit;

    // Позиции без продаж по умолчанию не входят в итоги (но остаются видимыми).
    if (item.noSales && !includeNoSales) {
      excludedNoSales.push(item);
      continue;
    }

    // Потребность и «закроется складом» считаем по всем участвующим позициям;
    // деньги — только по позициям с ценой.
    totalNeed += need;
    totalCovered += covered;
    totalBuy += buy;
    totalOrder += order;
    if (!item.noPrice) {
      costExact += item.costExact;
      costRounded += item.costRounded;
    }
    items.push(item);
  }

  return {
    items,
    excludedNoSales,
    noPrice,
    totalNeed,
    totalCovered,
    totalBuy,
    totalOrder,
    costExact,
    costRounded,
    overpay: costRounded - costExact,
    costByPriceFull,
  };
}

// ── §5.6 Прогноз «на сколько хватит» ────────────────────────────────────────

export interface RunoutInput {
  product: string;
  /** Продажи за 7 суток (только по ok-автоматам). */
  sold7: number;
  /** Остаток в машинах: Σ quantity по валидным слотам ok-автоматов. */
  inMachines: number;
}

export interface Runout {
  product: string;
  inMachines: number;
  /** Расход в день = sold7 / 7. */
  daily: number;
  /** На сколько хватит; Infinity, если продаж нет. */
  daysLeft: number;
}

/**
 * Прогноз запаса. Остаток и продажи ОБЯЗАНЫ считаться по одному множеству
 * автоматов (только `ok`) — иначе прогноз занижается (исправление ошибки
 * скрипта). Окно ровно 7 суток: делитель 7.
 */
export function runoutForecast(input: RunoutInput[], criticalDays = 3): { all: Runout[]; critical: Runout[] } {
  const all = input.map((r) => {
    const daily = r.sold7 / 7;
    return { product: r.product, inMachines: r.inMachines, daily, daysLeft: daily > 0 ? r.inMachines / daily : Infinity };
  });
  const critical = all
    .filter((r) => r.daysLeft <= criticalDays)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  return { all, critical };
}
