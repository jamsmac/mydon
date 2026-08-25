import { DAY } from "./expiry";
import { normalizeMachineSerial } from "./machine-serial";
import { tashkentDay } from "./tashkent-time";
import { normalizeProductName, priceDeviationPct } from "./vending-calc";

/**
 * Аналитика снек-контура (П5b): маржа, мёртвый сток, изменения цен, разрыв
 * витрины с эталоном, недельные границы. Чистые детерминированные функции без
 * БД и ввода-вывода — их зовут и Core, и бот, и панель, поэтому число у
 * владельца везде одно (R-P5b-10).
 *
 * ДВА РЕШЕНИЯ, КОТОРЫЕ НЕЛЬЗЯ «УПРОСТИТЬ».
 *
 * 1. Строка без себестоимости остаётся в выручке, но не даёт cogs.
 *    Донор (`mydon-stock/app/reports.py`, `margin_by_machine`) считает cogs под
 *    `if cost:` — то есть товар без цены закупки прибавляет revenue и ноль
 *    затрат. Маржа тогда завышена ровно на эту выручку. Соблазн «упростить» —
 *    подставить нулевую цену и получить честные 100 % маржи, либо выбросить
 *    строку и потерять живые деньги. Оба варианта врут. Поэтому: выручка
 *    остаётся, cogs не начисляется, а штуки и имена таких товаров едут в
 *    `unknownUnits`/`unknownProducts` — и КАЖДАЯ витрина обязана их показать,
 *    иначе завышение остаётся невидимым (R-P5b-2).
 *    Из того же правила: цена `0` или отсутствующая — это «цены НЕТ», а не
 *    «товар бесплатный». `CostIndex` возвращает `null`, ноль отбрасывается.
 *
 * 2. ISO-неделя считается по ташкентским суткам, а не по UTC.
 *    `sale.dt` — закрытый бизнес-день Ташкента, а база живёт в UTC. Неделя,
 *    посчитанная от UTC-момента, для всего интервала 19:00–24:00 по Ташкенту
 *    уезжает на сутки назад, и в понедельник 08:05 сводка показала бы окно,
 *    смещённое относительно тех же дней в SQL. Поэтому момент сперва
 *    сводится к ташкентским суткам общим `tashkentDay` (второй константы
 *    смещения в репозитории быть не должно — урок R-FW-11), и только потом
 *    идёт календарная арифметика.
 *    `Intl`/`toLocaleDateString` здесь запрещены: набор ICU в рантайме разный,
 *    а ключ недели обязан совпадать байт-в-байт с `to_char(dt,'IYYY-IW')`
 *    в Postgres.
 */

// ── Общие мелочи ────────────────────────────────────────────────────────────

/**
 * Порог «низкой маржи» по умолчанию. Боевое значение — настройка
 * `MARGIN_LOW_PCT` (R-P5b-11), её читает Core и передаёт сюда в `opts.lowPct`;
 * это лишь запасной вариант для вызова без настроек, а не второй источник
 * правды.
 */
const MARGIN_LOW_PCT_FALLBACK = 15;

/** Процент с одним знаком после запятой; `null`, когда база нулевая. */
function pct1(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return null;
  const v = Math.round((part / whole) * 1000) / 10;
  return v === 0 ? 0 : v; // гасим −0: `deepStrictEqual` отличает его от 0
}

/**
 * Деньги — целые сумы: складываем точно, округляем один раз на выходе.
 * `|| 0` гасит `-0` (`Math.round(-0.4)` даёт именно его): `deepStrictEqual`
 * отличает `-0` от `0`, а в JSON отчёта владельцу уехало бы «-0 сум».
 */
const money = (v: number): number => (Number.isFinite(v) ? Math.round(v) || 0 : 0);

const num = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Сортировка по коду символов: не зависит от набора ICU в рантайме. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Строка продажи — единственный источник денег (R-P5b-1). */
export interface SaleRow {
  dt: string;
  serial: string;
  product: string;
  qty: number;
  amount: number;
}

/**
 * Себестоимость единицы товара. `null` — цены НЕТ (0 ≠ известная цена, R-P5b-2).
 *
 * Индекс обязан быть построен ПО КАНОНУ ИМЕНИ (`normalizeProductName`): модуль
 * спрашивает цену ровно один раз на канонический ключ и передаёт в запрос
 * первое встреченное написание. «Moxito Lime 330ml» и «MOXITO LIME 330ML» —
 * один товар и одна себестоимость; без этого второе написание молча уехало бы
 * в `unknownUnits` и тихо подняло маржу — ровно то, против чего R-P5b-2.
 */
export type CostIndex = (product: string) => number | null;

/**
 * Обёртка над `CostIndex`: один запрос на КАНОНИЧЕСКИЙ ключ за вызов отчёта,
 * плюс отсев нуля и мусора в «цены нет» (R-P5b-2).
 */
function costLookup(cost: CostIndex): (product: string) => number | null {
  const byKey = new Map<string, number | null>();
  return (product) => {
    const key = normalizeProductName(product);
    if (byKey.has(key)) return byKey.get(key) ?? null;
    const raw = cost(product); // спрашиваем первым встреченным написанием
    const value = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
    byKey.set(key, value);
    return value;
  };
}

/**
 * Одно написание товара на весь отчёт: канон → первое встреченное написание.
 *
 * Иначе один и тот же товар выглядел бы в разных автоматах по-разному, и
 * владелец читал бы две строки там, где товар один.
 */
function nameRegistry(): (product: string) => string {
  const seen = new Map<string, string>();
  return (product) => {
    const key = normalizeProductName(product);
    const hit = seen.get(key);
    if (hit !== undefined) return hit;
    seen.set(key, product);
    return product;
  };
}

// ── Маржа по проданному (R-P5b-3) ───────────────────────────────────────────

export interface MarginProduct {
  product: string;
  qty: number;
  revenue: number;
  cogs: number;
  margin: number;
  pct: number | null;
  unknownUnits: number;
  low: boolean;
}

export interface MarginMachine extends Omit<MarginProduct, "product"> {
  serial: string;
  name: string;
  products: MarginProduct[];
}

export interface MarginTotals {
  qty: number;
  revenue: number;
  cogs: number;
  margin: number;
  pct: number | null;
  unknownUnits: number;
}

/** Строки продаж, выброшенные фильтром «в строю» (R-P5b-1): склад «продал» — реальный случай прода. */
export interface MarginExcluded {
  serial: string;
  qty: number;
  amount: number;
}

export interface MarginReport {
  days: number;
  from: string;
  to: string;
  lowPct: number;
  machines: MarginMachine[];
  products: MarginProduct[];
  totals: MarginTotals;
  unknownUnits: number;
  unknownProducts: string[];
  excluded: MarginExcluded[];
}

interface Cell {
  product: string;
  qty: number;
  revenue: number;
  cogsRaw: number;
  unknownUnits: number;
}

interface MachineAcc {
  serial: string;
  name: string;
  cells: Map<string, Cell>;
}

const emptyCell = (product: string): Cell => ({ product, qty: 0, revenue: 0, cogsRaw: 0, unknownUnits: 0 });

function finishProduct(cell: Cell, lowPct: number): MarginProduct {
  const revenue = money(cell.revenue);
  const cogs = money(cell.cogsRaw);
  const margin = revenue - cogs;
  const pct = pct1(margin, revenue);
  return {
    product: cell.product,
    qty: cell.qty,
    revenue,
    cogs,
    margin,
    pct,
    unknownUnits: cell.unknownUnits,
    low: margin < 0 || (pct !== null && pct < lowPct),
  };
}

/** Свод строк отчёта в один итог: cogs складываем уже округлённые — иначе итог не равен сумме строк. */
function rollUp(rows: readonly Omit<MarginProduct, "product">[], lowPct: number): Omit<MarginProduct, "product"> {
  let qty = 0, revenue = 0, cogs = 0, unknownUnits = 0;
  for (const r of rows) {
    qty += r.qty;
    revenue += r.revenue;
    cogs += r.cogs;
    unknownUnits += r.unknownUnits;
  }
  const margin = revenue - cogs;
  const pct = pct1(margin, revenue);
  return { qty, revenue, cogs, margin, pct, unknownUnits, low: margin < 0 || (pct !== null && pct < lowPct) };
}

const byMargin = <T extends { margin: number }>(a: T, b: T): number => b.margin - a.margin;

/**
 * Маржа по проданному: автомат → товар и товар → итог по парку.
 *
 * `inService` — автоматы в строю (`machine_card.status = 'in_service'`),
 * серийник → имя. Строки продаж с чужим серийником в деньги НЕ идут: на проде
 * склад-заглушка SKLAD 4S «продал» 1 шт Moxito 09.07, а SKLAD 5S/6S отдают
 * 45 млн сум «остатка» из воздуха. Такие строки не молча теряются, а
 * называются отдельно в `excluded` — иначе расхождение с кассой необъяснимо.
 *
 * ПОРЯДОК СТРОК — часть контракта, а не оформление: бот режет «топ-5 и
 * худшие-3 по марже» (R-P5b-7) прямо этим порядком. Автоматы и товары —
 * по марже по убыванию, при равенстве по имени (серийнику); `excluded` —
 * по сумме по убыванию. Закреплено тестами.
 *
 * `low` сравнивает ОКРУГЛЁННЫЙ `pct` (14.96 → 15.0 → не помечен): флаг обязан
 * совпадать с числом, которое владелец видит на витрине.
 */
export function marginByMachine(
  rows: readonly SaleRow[],
  cost: CostIndex,
  opts: { days: number; from: string; to: string; inService: ReadonlyMap<string, string>; lowPct?: number },
): MarginReport {
  const lowPct = opts.lowPct ?? MARGIN_LOW_PCT_FALLBACK;
  const unitCost = costLookup(cost);
  const display = nameRegistry();

  const park = new Map<string, { serial: string; name: string }>();
  for (const [serial, name] of opts.inService) park.set(normalizeMachineSerial(serial), { serial, name });

  const machines = new Map<string, MachineAcc>();
  const excluded = new Map<string, MarginExcluded>();
  const unknownNames = new Map<string, string>();

  for (const row of rows) {
    const qty = num(row.qty);
    const amount = num(row.amount);
    const serial = normalizeMachineSerial(row.serial);
    const card = park.get(serial);
    if (!card) {
      const acc = excluded.get(serial) ?? { serial, qty: 0, amount: 0 };
      acc.qty += qty;
      acc.amount += amount;
      excluded.set(serial, acc);
      continue;
    }

    const machine = machines.get(serial) ?? { serial: card.serial, name: card.name, cells: new Map<string, Cell>() };
    machines.set(serial, machine);

    const key = normalizeProductName(row.product);
    const cell = machine.cells.get(key) ?? emptyCell(display(row.product));
    machine.cells.set(key, cell);

    const unit = unitCost(cell.product);
    cell.qty += qty;
    cell.revenue += amount;
    if (unit === null) {
      cell.unknownUnits += qty;
      unknownNames.set(key, cell.product);
    } else {
      cell.cogsRaw += qty * unit;
    }
  }

  const byProduct = new Map<string, MarginProduct[]>();
  const machineRows: MarginMachine[] = [];
  for (const acc of machines.values()) {
    const products: MarginProduct[] = [];
    for (const [key, cell] of acc.cells) {
      const row = finishProduct(cell, lowPct);
      products.push(row);
      const bucket = byProduct.get(key);
      if (bucket) bucket.push(row);
      else byProduct.set(key, [row]);
    }
    products.sort((a, b) => byMargin(a, b) || byText(a.product, b.product));
    machineRows.push({ serial: acc.serial, name: acc.name, products, ...rollUp(products, lowPct) });
  }
  machineRows.sort((a, b) => byMargin(a, b) || byText(a.serial, b.serial));

  const productRows: MarginProduct[] = [];
  for (const rowsOfProduct of byProduct.values()) {
    productRows.push({ product: rowsOfProduct[0]!.product, ...rollUp(rowsOfProduct, lowPct) });
  }
  productRows.sort((a, b) => byMargin(a, b) || byText(a.product, b.product));

  const { low: _low, ...totals } = rollUp(machineRows, lowPct);

  return {
    days: opts.days,
    from: opts.from,
    to: opts.to,
    lowPct,
    machines: machineRows,
    products: productRows,
    totals,
    unknownUnits: totals.unknownUnits,
    unknownProducts: [...unknownNames.values()].sort(byText),
    excluded: [...excluded.values()].sort((a, b) => b.amount - a.amount || byText(a.serial, b.serial)),
  };
}

// ── Мёртвый сток (R-P5b-4) ──────────────────────────────────────────────────

export interface StockPosition {
  product: string;
  qty: number;
  serial?: string;
  machineName?: string;
}

export interface DeadRow extends StockPosition {
  value: number;
  noPrice: boolean;
}

export interface DeadStockReport {
  days: number;
  since: string;
  warehouse: DeadRow[];
  machines: DeadRow[];
  totalValue: number;
  noPriceCount: number;
}

/** Ключ движения товара в конкретном автомате: `serial|канон товара`. */
export const machineMovementKey = (serial: string, product: string): string =>
  `${normalizeMachineSerial(serial)}|${normalizeProductName(product)}`;

const byValue = (a: DeadRow, b: DeadRow): number =>
  b.value - a.value || byText(a.product, b.product) || byText(a.serial ?? "", b.serial ?? "");

/**
 * Мёртвый сток: позиции с остатком, по которым за окно не было ни продажи, ни
 * заливки, ни приёмки.
 *
 * `moved`: для склада — `normalizeProductName(product)` (движение глобально:
 * товар уехал со склада, где бы он потом ни продался); для автоматов — пара
 * `serial|канон` (R-P5b-4). Разделение не косметическое: один и тот же товар
 * бойко продаётся в American Hospital и месяцами стоит в Olma — глобальный флаг
 * спрятал бы вторую позицию.
 *
 * Без себестоимости позиция остаётся в отчёте с `value = 0` и `noPrice = true`.
 * Это НЕ «ноль сум»: складывать такие нули в `totalValue` как деньги нельзя,
 * поэтому счётчик `noPriceCount` едет рядом с итогом.
 *
 * ПОРЯДОК СТРОК: по оценке по убыванию (при равенстве — товар, затем
 * серийник). Недельная сводка берёт «топ-5 по оценке» (R-P5b-7) первыми пятью
 * строками, не пересортировывая. Закреплено тестом.
 */
export function deadStock(
  warehouse: readonly StockPosition[],
  inMachines: readonly StockPosition[],
  moved: ReadonlySet<string>,
  cost: CostIndex,
  days: number,
  since: string,
): DeadStockReport {
  const unitCost = costLookup(cost);
  const display = nameRegistry();

  const collect = (positions: readonly StockPosition[], key: (p: StockPosition) => string): DeadRow[] => {
    const out: DeadRow[] = [];
    for (const p of positions) {
      const qty = num(p.qty);
      if (qty <= 0 || moved.has(key(p))) continue;
      const unit = unitCost(p.product);
      // Строка собирается ПОЛЯМИ, а не `...p`: позиция приезжает из выборки БД
      // со своими `productId`/`countedAt`, и спред утащил бы их в JSON отчёта —
      // форма ответа перестала бы совпадать с `DeadRow`, который читают бот и
      // панель (R-P5b-10).
      const row: DeadRow = {
        product: display(p.product),
        qty,
        value: unit === null ? 0 : money(qty * unit),
        noPrice: unit === null,
      };
      if (p.serial !== undefined) row.serial = p.serial;
      if (p.machineName !== undefined) row.machineName = p.machineName;
      out.push(row);
    }
    return out.sort(byValue);
  };

  const warehouseRows = collect(warehouse, (p) => normalizeProductName(p.product));
  const machineRows = collect(inMachines, (p) => machineMovementKey(p.serial ?? "", p.product));
  const all = [...warehouseRows, ...machineRows];

  return {
    days,
    since,
    warehouse: warehouseRows,
    machines: machineRows,
    totalValue: all.reduce((sum, r) => sum + r.value, 0),
    noPriceCount: all.filter((r) => r.noPrice).length,
  };
}

// ── Изменения цен (R-P5b-5) ─────────────────────────────────────────────────

export interface PriceChange {
  product: string;
  from: number;
  to: number;
  pct: number;
  at: string;
}

export interface PurchasePriceEvent {
  product: string;
  oldPrice: number | null;
  newPrice: number;
  at: string;
}

export interface RetailDailyPrice {
  product: string;
  dt: string;
  price: number;
}

export interface PriceChangesReport {
  days: number;
  pct: number;
  purchase: PriceChange[];
  retail: PriceChange[];
}

/**
 * Цена дня витрины = round(Σamount / Σqty) по (товар, сутки) (R-P5b-5).
 *
 * Считается по ВСЕМ автоматам сразу: на проде у всех 34 SKU витринная цена на
 * обоих автоматах одинакова, а средняя по паре автоматов устойчивее к дырке в
 * сборе, чем цена одного. `dt` — уже закрытый ташкентский бизнес-день из
 * `sale`, своей арифметики времени здесь не нужно.
 *
 * ПОРЯДОК СТРОК: товар, затем сутки по возрастанию — лента цен читается
 * слева направо, и `priceChanges` идёт по ней соседними парами.
 */
export function retailDaily(rows: readonly SaleRow[]): RetailDailyPrice[] {
  const acc = new Map<string, { product: string; dt: string; qty: number; amount: number }>();
  for (const row of rows) {
    const qty = num(row.qty);
    if (qty <= 0) continue; // без штук цены дня нет — делить не на что
    const key = `${normalizeProductName(row.product)}|${row.dt}`;
    const cell = acc.get(key) ?? { product: row.product, dt: row.dt, qty: 0, amount: 0 };
    cell.qty += qty;
    cell.amount += num(row.amount);
    acc.set(key, cell);
  }
  return [...acc.values()]
    .map((c) => ({ product: c.product, dt: c.dt, price: money(c.amount / c.qty) }))
    .sort((a, b) => byText(a.product, b.product) || byText(a.dt, b.dt));
}

/** Свежие изменения сверху: владельца интересует «что поехало», а не история. */
const byRecency = (a: PriceChange, b: PriceChange): number => byText(b.at, a.at) || byText(a.product, b.product);

/**
 * Две ленты изменений цен за окно: закупочные (из событий) и витринные
 * (переходы день-к-дню в `retailDaily`).
 *
 * Окно уже применено на входе — `days` едет в отчёт для подписи витрины, здесь
 * ничего не фильтруется: у чистой функции нет «сейчас».
 *
 * Прошлая цена `≤ 0` — мусор, а не «цена выросла с нуля»: на проде позиция
 * «Недостача (Рустам)» с нулевой прошлой ценой давала в доноре +1269.6 % и
 * возглавляла список изменений. Такие переходы пропускаются.
 *
 * ПОРЯДОК СТРОК: свежие сверху (`at` по убыванию, при равенстве — имя товара):
 * владельцу важно «что поехало сейчас», а не история с начала окна.
 * Закреплено тестом.
 */
export function priceChanges(
  purchase: readonly PurchasePriceEvent[],
  retail: readonly RetailDailyPrice[],
  pct: number,
  days: number,
): PriceChangesReport {
  const limit = num(pct);
  // Отклонение считает `priceDeviationPct` из `vending-calc` — та же функция,
  // которой Core закрывает гейт правки цены. Второй копии формулы в репозитории
  // быть не должно, и правило «прежняя цена ≤ 0 → сравнивать не с чем» тоже
  // живёт там: на проде это позиция «Недостача (Рустам)», дававшая +1269.6 %.
  const significant = (from: number, to: number): boolean => {
    const deviation = priceDeviationPct(to, from);
    return deviation !== null && deviation > limit;
  };
  const change = (product: string, from: number, to: number, at: string): PriceChange => ({
    product,
    from,
    to,
    pct: pct1(to - from, from)!,
    at,
  });

  const purchaseRows: PriceChange[] = [];
  for (const e of purchase) {
    const from = e.oldPrice;
    if (from === null || !significant(num(from), num(e.newPrice))) continue;
    purchaseRows.push(change(e.product, num(from), num(e.newPrice), e.at));
  }

  const series = new Map<string, RetailDailyPrice[]>();
  for (const p of retail) {
    const key = normalizeProductName(p.product);
    const bucket = series.get(key);
    if (bucket) bucket.push(p);
    else series.set(key, [p]);
  }
  const retailRows: PriceChange[] = [];
  for (const points of series.values()) {
    const sorted = [...points].sort((a, b) => byText(a.dt, b.dt));
    for (let i = 1; i < sorted.length; i += 1) {
      const from = sorted[i - 1]!, to = sorted[i]!;
      if (!significant(from.price, to.price)) continue;
      retailRows.push(change(to.product, from.price, to.price, to.dt));
    }
  }

  return {
    days,
    pct: num(pct),
    purchase: purchaseRows.sort(byRecency),
    retail: retailRows.sort(byRecency),
  };
}

// ── Витрина против эталона (R-P5b-6) ────────────────────────────────────────

export interface PriceGapRow {
  product: string;
  fact: number;
  reference: number;
  gap: number;
  gapPct: number;
  qty: number;
  lost: number;
  action: "raise" | "check";
}

export interface PriceGapReport {
  days: number;
  pct: number;
  rows: PriceGapRow[];
  noReference: string[];
  lostTotal: number;
}

/**
 * Факт витрины (`amount/qty` за окно) против эталона владельца
 * (`vending_product.sale_price`).
 *
 * `lostTotal` складывает ТОЛЬКО положительные разрывы: недобор — это деньги,
 * которых не собрали, а «продали дороже эталона» — повод перепроверить эталон
 * (`action: "check"`), а не прибыль, которую можно зачесть против недобора.
 * Товары без эталона идут отдельным списком, а не нулевой строкой: строка
 * `reference = 0` выглядела бы как «эталон ноль» и дала бы разрыв в 100 %.
 *
 * ПОРЯДОК СТРОК: по `lost` по убыванию — недобор сверху, «продали дороже
 * эталона» в хвосте. Закреплено тестом.
 */
export function priceGap(
  fact: readonly { product: string; qty: number; amount: number }[],
  reference: ReadonlyMap<string, number>,
  pct: number,
  days: number,
): PriceGapReport {
  const threshold = num(pct) / 100;
  const refs = new Map<string, number>();
  for (const [product, price] of reference) {
    // `money` здесь обязателен: эталон приезжает из `numeric(12,2)`, и без
    // округления `gap` считался бы разностью с копейками (15000.55 − 12500 =
    // 2500.5499999999993) — именно это число и напечатали бы владельцу, при
    // том что `lost` рядом уже округлён. Деньги в отчёте целые все сразу.
    if (Number.isFinite(price) && price > 0) refs.set(normalizeProductName(product), money(price));
  }

  const acc = new Map<string, { product: string; qty: number; amount: number }>();
  for (const f of fact) {
    const qty = num(f.qty);
    if (qty <= 0) continue;
    const key = normalizeProductName(f.product);
    const cell = acc.get(key) ?? { product: f.product, qty: 0, amount: 0 };
    cell.qty += qty;
    cell.amount += num(f.amount);
    acc.set(key, cell);
  }

  const rows: PriceGapRow[] = [];
  const noReference: string[] = [];
  for (const [key, cell] of acc) {
    const ref = refs.get(key);
    if (ref === undefined) {
      noReference.push(cell.product);
      continue;
    }
    const factPrice = money(cell.amount / cell.qty);
    const gap = ref - factPrice;
    if (Math.abs(gap) / ref <= threshold) continue;
    const lost = money(gap * cell.qty);
    rows.push({
      product: cell.product,
      fact: factPrice,
      reference: ref,
      gap,
      gapPct: pct1(gap, ref)!,
      qty: cell.qty,
      lost,
      action: lost > 0 ? "raise" : "check",
    });
  }

  return {
    days,
    pct: num(pct),
    rows: rows.sort((a, b) => b.lost - a.lost || byText(a.product, b.product)),
    noReference: noReference.sort(byText),
    lostTotal: rows.reduce((sum, r) => sum + (r.lost > 0 ? r.lost : 0), 0),
  };
}

// ── Недели по Ташкенту (R-P5b-7) ────────────────────────────────────────────

export interface WeekTotals {
  qty: number;
  revenue: number;
  margin: number;
}

export interface WeekDelta {
  qty: number;
  revenue: number;
  margin: number;
  qtyPct: number | null;
  revenuePct: number | null;
  marginPct: number | null;
}

export interface IsoWeek {
  key: string;
  year: number;
  week: number;
  from: string;
  to: string;
}

// Сутки берём общей константой `DAY` из `expiry.ts` — своей копии 86 400 000
// в репозитории заводить нельзя. `dayToUtc`/`utcToDay` ниже повторяют приватные
// `dayNumber`/`isoOfDay` из `maintenance-due.ts`; выносить их в общий модуль —
// отдельная правка (расширение публичного API пакета), а не хвост этого среза.
const WEEK_MS = 7 * DAY;
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_KEY = /^(\d{4})-(\d{2})$/;

/** Голые сутки → полночь UTC того же календарного дня (арифметика календаря, не зон). */
function dayToUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

const utcToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Понедельник ISO-недели, содержащей момент (Пн = 0). */
const mondayOf = (ms: number): number => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;

/** Четверг первой ISO-недели года: он же 4 января по определению стандарта. */
const week1Thursday = (year: number): number => mondayOf(Date.UTC(year, 0, 4)) + 3 * DAY;

function weekOfUtcDay(ms: number): IsoWeek {
  const monday = mondayOf(ms);
  const thursday = monday + 3 * DAY; // четверг решает, чьей недели день (ISO 8601)
  const year = new Date(thursday).getUTCFullYear();
  const week = (thursday - week1Thursday(year)) / WEEK_MS + 1;
  return {
    key: `${year}-${String(week).padStart(2, "0")}`,
    year,
    week,
    from: utcToDay(monday),
    to: utcToDay(monday + 6 * DAY),
  };
}

/**
 * ISO-неделя ташкентских суток момента: ключ `IYYY-IW`, `from`/`to` — пн и вс
 * по Ташкенту. См. решение 2 в шапке модуля: сперва сутки Ташкента, потом
 * календарь; без `Intl`, чтобы ключ совпадал с `to_char(dt,'IYYY-IW')`.
 */
export function isoWeekTashkent(at: Date): IsoWeek {
  return weekOfUtcDay(dayToUtc(tashkentDay(at)));
}

/** Ключ `IYYY-IW` → неделя. `null` — мусор или 53-я неделя в 52-недельном году. */
export function isoWeekFromKey(key: string): IsoWeek | null {
  const m = WEEK_KEY.exec(key.trim());
  if (!m) return null;
  const year = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const found = weekOfUtcDay(week1Thursday(year) + (week - 1) * WEEK_MS);
  return found.year === year && found.week === week ? found : null;
}

/** Предыдущая ISO-неделя: считается от границ, а не вычитанием единицы (год не всегда 52 недели). */
export function previousIsoWeek(w: IsoWeek): IsoWeek {
  const monday = BARE_DAY.test(w.from) ? dayToUtc(w.from) : week1Thursday(w.year) + (w.week - 1) * WEEK_MS - 3 * DAY;
  return weekOfUtcDay(monday - WEEK_MS);
}

/** Сравнение недели с предыдущей: знак и процент. Прошлая неделя в нуле → процента нет, а не «+100 %». */
export function weekCompare(current: WeekTotals, previous: WeekTotals): WeekDelta {
  const qty = num(current.qty) - num(previous.qty);
  const revenue = money(num(current.revenue) - num(previous.revenue));
  const margin = money(num(current.margin) - num(previous.margin));
  return {
    qty,
    revenue,
    margin,
    qtyPct: pct1(qty, num(previous.qty)),
    revenuePct: pct1(revenue, num(previous.revenue)),
    marginPct: pct1(margin, num(previous.margin)),
  };
}

/**
 * Взвешенная себестоимость по принятым накладным окна: Σ(price×qty)/Σqty;
 * пусто → `null`.
 *
 * Позиции с ценой `≤ 0` не участвуют: ноль — это «цену не вписали», а не
 * «привезли даром» (R-P5b-2). Если после отсева не осталось ничего, ответ —
 * `null` («цены нет»), и товар честно уедет в `unknownUnits`, а не получит
 * себестоимость 0 и 100 % маржи.
 *
 * Результат округляется до сотых, а не до целых сум: это ставка, а не платёж;
 * округление ставки заметно уводит cogs на объёмах в сотни штук — целые сумы
 * появляются один раз, уже на сумме.
 */
export function weightedCost(lots: readonly { price: number; qty: number }[]): number | null {
  let sum = 0, qty = 0;
  for (const lot of lots) {
    if (!Number.isFinite(lot.price) || !Number.isFinite(lot.qty) || lot.price <= 0 || lot.qty <= 0) continue;
    sum += lot.price * lot.qty;
    qty += lot.qty;
  }
  return qty === 0 ? null : Math.round((sum / qty) * 100) / 100;
}
