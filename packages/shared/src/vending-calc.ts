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
 * приводим к нижнему регистру, сводим пробелы, ё→е и десятичную запятую к
 * точке, чтобы регистр, лишние пробелы и знак разделителя не мешали ТОЧНОМУ
 * соответствию. Разные формулировки покрываются самими алиасами — здесь
 * только нормализация, не нечёткое сравнение.
 *
 * ДЕСЯТИЧНЫЙ РАЗДЕЛИТЕЛЬ (R-FW-P1, адверсариал прод-данных 26.08). Каталог
 * ведёт объём и запятой, и точкой: 26 карточек с `0,45` против двух с `0.25`,
 * а среди алиасов уже лежит РУКОПАШНАЯ пара «Fanta CAN 0,25» / «Fanta can
 * 0.25» — владелец заводил второе написание именно потому, что нормализация
 * их не склеивала. Из-за этого 4 из 11 имён, которые бэкфилл печатал как «без
 * карточки», отличались от УЖЕ ЗАВЕДЁННОЙ карточки/алиаса ровно этим знаком, а
 * инструкция выкатки («заведите карточку под именем из списка») вела ко
 * второму прайсу на ту же SKU.
 *
 * Фолдинг узкий НАМЕРЕННО — только запятая МЕЖДУ ЦИФРАМИ: запятая-разделитель
 * («Кофе, чай») остаётся на месте, и склеить два разных товара фолдинг не
 * может. На прод-каталоге (52 карточки, 109 алиасов) проверено: новых коллизий
 * ключа — ноль, случаев «алиас затеняет чужую карточку» — ноль.
 */
export function normalizeProductName(name: string): string {
  return name.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").replace(/(\d),(\d)/g, "$1.$2");
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

export const hasProduct = (s: Slot): boolean => typeof s.product === "string" && s.product.trim().length > 0;

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

/**
 * Порог гейта цены, % — выше него правка прайса требует подтверждения.
 * Значение из проверенного процесса mydon-stock (PRICE_SPIKE_PCT): ловит
 * опечатку (45000 вместо 4500) и скрытое подорожание поставщика.
 */
export const PRICE_SPIKE_PCT = 20;

/**
 * Отклонение новой цены от прежней, % (всегда ≥0). null — сравнивать не с
 * чем (прежней цены нет или она не положительная): гейт пропускается, как
 * у донора.
 */
export function priceDeviationPct(next: number, last: number | null | undefined): number | null {
  if (typeof last !== "number" || !Number.isFinite(last) || last <= 0) return null;
  if (!Number.isFinite(next)) return null;
  return Math.abs(((next - last) / last) * 100);
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

export type AllocationPolicy = "purchase-first" | "warehouse-first";

/** Правила закупа товара (vending_product): исключён / фикс-количество / блок без цены (П5a). */
export interface ProductRule {
  excluded?: boolean;
  fixedQty?: number | null;
  pack?: number;
}

export interface PurchaseItem {
  product: string;
  perMachine: Record<string, number>;
  need: number;
  stock: number;
  /**
   * Закроется складом: min(stock, need). СОВМЕСТИМОСТЬ, а не раздача: сколько
   * реально уедет со склада в автоматы, говорит `fromStock` (зависит от
   * политики раздачи), и при purchase-first он меньше `covered`.
   */
  covered: number;
  /** Надо купить: max(0, need − stock). */
  buy: number;
  /**
   * Останется на складе: max(0, stock − need). СОВМЕСТИМОСТЬ, а не раздача:
   * фактический остаток после похода — `stockAfter`.
   */
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
  /** В автоматы из закупа (новая упаковка). */
  fromPurchase: number;
  /** В автоматы со склада. */
  fromStock: number;
  /** Не заполнится. */
  unfilled: number;
  /** Излишек закупки → на склад: order − fromPurchase. */
  toStock: number;
  /** Склад после: stock − fromStock + toStock. */
  stockAfter: number;
  /** Правило «убрано из закупки». */
  excluded: boolean;
  /** Фикс-количество, если задано. */
  fixedQty: number | null;
}

export interface PurchaseSummary {
  /** Позиции к закупу (участвуют в итогах). */
  items: PurchaseItem[];
  /** «Не закупать — нет продаж»: показываются отдельно, в итоги НЕ входят. */
  excludedNoSales: PurchaseItem[];
  /** «Убрано из закупки» правилом товара — в деньги не входит, в раздачу входит. */
  excludedByRule: PurchaseItem[];
  /** Товары без цены в прайсе — на разбор менеджеру. */
  noPrice: string[];
  /** Политика раздачи, применённая к этому расчёту. */
  allocation: AllocationPolicy;
  totalNeed: number;
  /** Σ covered — совместимость (см. `PurchaseItem.covered`), не раздача. */
  totalCovered: number;
  totalBuy: number;
  totalOrder: number;
  /** Строго по нехватке: Σ buy × price. */
  costExact: number;
  /** С округлением до упаковок: Σ order × price. */
  costRounded: number;
  /** Переплата за округление/фикс сверх нехватки: max(0, costRounded − costExact). */
  overpay: number;
  /**
   * Недобор деньгами: max(0, costExact − costRounded). Бывает при
   * фикс-количестве МЕНЬШЕ нехватки — купим меньше, чем нужно, и часть слотов
   * останется пустой. Это решение владельца, а не ошибка, но молчать о нём
   * нельзя: «переплата −260 000» выглядела как экономия.
   */
  shortfallCost: number;
  /** «Закуп по прайсу» (§8.1): полный дефицит по прайсу, без склада и округления. */
  costByPriceFull: number;
  totalFromPurchase: number;
  totalFromStock: number;
  totalUnfilled: number;
  totalToStock: number;
}

export interface PurchaseOptions {
  /** Округлять до упаковок (иначе order = buy). По умолчанию да. */
  round?: boolean;
  /** Включать позиции без продаж в закуп и итоги. По умолчанию нет (§5.5). */
  includeNoSales?: boolean;
  maxCapacity?: number;
  /** Политика раздачи (R-P5a-1). По умолчанию purchase-first. */
  allocation?: AllocationPolicy;
  /** Правила по канону имени; товар без записи — обычный. */
  rules?: Map<string, ProductRule>;
}

/**
 * Сводный закуп: потребность − склад, округление до упаковок, суммы (§5.4–5.5).
 * Показывает ОБЕ суммы и переплату — это управленческое решение, а не деталь.
 * Позиции без цены исключаются из денег; позиции без продаж по умолчанию
 * выносятся в отдельную группу и в итоги не входят (переключается опцией).
 *
 * Раздача (П5a, §4.1): дополнительно считает, сколько уйдёт в автоматы из
 * новой упаковки (`fromPurchase`) и сколько — со склада (`fromStock`);
 * порядок раздачи задаёт `allocation` (по умолчанию purchase-first —
 * новая упаковка расходуется первой, склад не трогается лишний раз).
 * Правила товара (`rules`) могут исключить товар из закупки целиком
 * (`excluded`) или зафиксировать количество закупки при дефиците
 * (`fixedQty`, без округления до упаковки).
 */
export function computePurchase(
  input: PurchaseRow[],
  prices: Map<string, PriceEntry>,
  opts: PurchaseOptions = {},
): PurchaseSummary {
  const round = opts.round ?? true;
  const includeNoSales = opts.includeNoSales ?? false;
  const allocation = opts.allocation ?? "purchase-first";
  const rules = opts.rules ?? new Map<string, ProductRule>();

  const items: PurchaseItem[] = [];
  const excludedNoSales: PurchaseItem[] = [];
  const excludedByRule: PurchaseItem[] = [];
  const noPrice: string[] = [];

  let totalNeed = 0;
  let totalCovered = 0;
  let totalBuy = 0;
  let totalOrder = 0;
  let costExact = 0;
  let costRounded = 0;
  let costByPriceFull = 0;
  let totalFromPurchase = 0;
  let totalFromStock = 0;
  let totalUnfilled = 0;
  let totalToStock = 0;

  for (const row of input) {
    const need = row.need ?? Object.values(row.perMachine).reduce((a, b) => a + b, 0);
    if (need <= 0) continue;

    const price = prices.get(row.product);
    const rule = rules.get(row.product);
    const excluded = rule?.excluded === true;
    const fixedQty = typeof rule?.fixedQty === "number" && rule.fixedQty > 0 ? rule.fixedQty : null;
    const stock = row.stock;
    const covered = Math.min(stock, need);
    const surplus = Math.max(0, stock - need);
    // Кратность НИКОГДА не 0: `pack_size` в базе — обычный integer, и строка с
    // нулём (правка мимо CHECK, старый импорт) дала бы ceil(buy/0)×0 = NaN, а
    // NaN×цена — NaN в сумме закупа, то есть молча испорченный бюджет. Порог 1
    // означает «без упаковки, поштучно» — безопасный смысл по умолчанию.
    const pack = Math.max(1, price?.pack ?? rule?.pack ?? 1);
    const unit = price?.price ?? 0;
    const noSales = row.sold7 <= 0;

    // Сколько купить: исключённые товары — ничего; иначе обычный дефицит.
    // Фикс-количество задаёт заказ (не сам дефицит) — покупаем ровно фикс,
    // без округления до упаковки.
    const shortage = Math.max(0, need - stock);
    const buy = excluded ? 0 : shortage;
    const order =
      excluded || buy === 0
        ? 0
        : fixedQty !== null
          ? fixedQty
          : !round
            ? buy
            : Math.ceil(buy / pack) * pack;

    // Раздача (R-P5a-1): «нет продаж» и «исключён» ничего не покупают, но в
    // автоматы грузится то, что уже есть на складе.
    const purchasable = !excluded && (includeNoSales || !noSales);
    const orderForLoad = purchasable ? order : 0;
    let fromPurchase: number;
    let fromStock: number;
    if (allocation === "purchase-first") {
      fromPurchase = Math.min(need, orderForLoad);
      fromStock = Math.min(stock, need - fromPurchase);
    } else {
      fromStock = Math.min(stock, need);
      fromPurchase = Math.min(orderForLoad, need - fromStock);
    }
    const unfilled = need - fromPurchase - fromStock;
    const toStock = orderForLoad - fromPurchase;
    const stockAfter = stock - fromStock + toStock;

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
      extra: Math.max(0, order - buy),
      price: unit,
      costExact: buy * unit,
      costRounded: order * unit,
      noPrice: price === undefined,
      noSales,
      fromPurchase,
      fromStock,
      unfilled,
      toStock,
      stockAfter,
      excluded,
      fixedQty,
    };

    // totalFrom*/totalUnfilled/totalToStock — по ВСЕМ позициям раздачи
    // (items + excludedByRule + excludedNoSales), это штуки, не деньги.
    totalFromPurchase += fromPurchase;
    totalFromStock += fromStock;
    totalUnfilled += unfilled;
    totalToStock += toStock;

    if (excluded) {
      excludedByRule.push(item);
      continue;
    }

    // «Без цены» — список НА РАЗБОР владельцу: чего не хватает в бюджете.
    // Исключённый из закупки товар в бюджет не входит по решению владельца, и
    // его отсутствующая цена ничего не меняет — строка была бы шумом, который
    // владелец не может закрыть (цена ему не нужна). Поэтому пометка ставится
    // ПОСЛЕ ветки excluded (A3/UX#22).
    if (item.noPrice) noPrice.push(row.product);

    // Полный дефицит по прайсу — по всем позициям с ценой, что реально закупаются (§8.1).
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
    excludedByRule,
    noPrice,
    allocation,
    totalNeed,
    totalCovered,
    totalBuy,
    totalOrder,
    costExact,
    costRounded,
    // Переплата и недобор — ДВА РАЗНЫХ числа, а не одно со знаком. Фикс
    // меньше нехватки (Snickers: нехватка 100, фикс 48) делает costRounded
    // МЕНЬШЕ costExact, и прежняя разность уходила в минус: «переплата
    // −260 000 сум» читается как экономия, хотя на деле это недокупленный
    // товар. Минус в переплате гасим, а недобор показываем отдельно.
    overpay: Math.max(0, costRounded - costExact),
    shortfallCost: Math.max(0, costExact - costRounded),
    costByPriceFull,
    totalFromPurchase,
    totalFromStock,
    totalUnfilled,
    totalToStock,
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

// ── §5.8 Касса закупа: получил − статьи = остаток ───────────────────────────
//
// Реальный поход владельца на базар: взял наличные, купил по статьям
// («корзинка», «базар» — одна и та же статья может повторяться, например
// «базар» отдельно для снеков и отдельно для напитков), в конце — что
// осталось. Строчная арифметика («47×2090») уже посчитана владельцем от руки
// и приходит готовой суммой — здесь только сведение статей и остаток.
// Воспроизводит реальную запись 02.08.2026 до сума — см. vending-calc.test.ts.

export interface CashLine {
  /** Что купили (свободный текст — «Barni», «47×2090» и т.п.). */
  label: string;
  qty?: number;
  unitPrice?: number;
  /** Сумма строки, сум — уже посчитана владельцем, не пересчитывается. */
  amount: number;
}

export interface CashCategoryInput {
  /** Статья расхода: «корзинка», «базар» и т.п. Может повторяться. */
  name: string;
  lines: CashLine[];
}

export interface CashCategorySummary extends CashCategoryInput {
  /** Σ lines.amount. */
  subtotal: number;
}

export interface PurchaseCashSession {
  /** Сколько наличных получено на закуп, сум. */
  receivedAmount: number;
  categories: CashCategorySummary[];
  /** Σ categories.subtotal. */
  totalSpent: number;
  /** receivedAmount − totalSpent. Отрицательный — потратили больше, чем получили. */
  remainder: number;
}

/**
 * Касса закупа: получил → статьи (со строками) → остаток. Статьи не
 * дедуплицируются по имени намеренно — «базар» для снеков и «базар» для
 * напитков считаются владельцем отдельно и должны остаться двумя строками.
 */
export function computePurchaseCash(receivedAmount: number, categories: CashCategoryInput[]): PurchaseCashSession {
  const summarized: CashCategorySummary[] = categories.map((c) => ({
    ...c,
    subtotal: c.lines.reduce((a, l) => a + l.amount, 0),
  }));
  const totalSpent = summarized.reduce((a, c) => a + c.subtotal, 0);
  return { receivedAmount, categories: summarized, totalSpent, remainder: receivedAmount - totalSpent };
}
