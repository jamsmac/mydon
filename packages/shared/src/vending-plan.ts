import { normalizeMachineSerial } from "./machine-serial";
import { hasProduct, MAX_CAPACITY, slotDeficit, slotValid, type PurchaseItem, type Slot } from "./vending-calc";

/**
 * Раздача закупочного плана по автоматам и слотам (П5a, донор vending-ops
 * build_plan.py:214-262). Чистые функции: те же входы → те же числа.
 */

/** Порядок слотов: числовые coilId по возрастанию, потом строковые. */
export function coilOrder(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  const an = Number.isFinite(na) && a.trim() !== "", bn = Number.isFinite(nb) && b.trim() !== "";
  if (an && bn) return na - nb;
  if (an) return -1;
  if (bn) return 1;
  return a.localeCompare(b, "ru");
}

/**
 * Разбор настройки маршрута против списка автоматов плана.
 *
 * Серийник сравнивается ПО КАНОНУ с обеих сторон (`normalizeMachineSerial`):
 * реестр и рукописные заметки владельца пишут снековые серийники с приставкой
 * («c2508160376»), Ourvend — без неё, и точное равенство молча роняло бы
 * настройку в «мусор» — маршрут вставал по имени, а владелец видел свой
 * порядок в настройках и не понимал, почему бот ведёт иначе.
 *
 * Возвращается серийник АВТОМАТА (как он записан в слотах), а не строка
 * настройки: дальше по нему ищут `perMachine`, и чужая форма записи не нашла
 * бы ничего.
 */
function parseRouteSetting(
  setting: string,
  machines: { serial: string; name: string }[],
): { first: string[]; firstSet: Set<string>; unknown: string[] } {
  const byCanon = new Map<string, string>();
  for (const m of machines) {
    const canon = normalizeMachineSerial(m.serial);
    if (!byCanon.has(canon)) byCanon.set(canon, m.serial);
  }
  const firstSet = new Set<string>();
  const first: string[] = [];
  const unknown: string[] = [];
  for (const raw of setting.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    const serial = byCanon.get(normalizeMachineSerial(token));
    if (serial === undefined) {
      if (!unknown.includes(token)) unknown.push(token);
      continue;
    }
    if (firstSet.has(serial)) continue;
    firstSet.add(serial);
    first.push(serial);
  }
  return { first, firstSet, unknown };
}

/** Порядок обхода: серийники из настройки первыми (в их порядке, без повторов), остальные — по имени. */
export function routeOrderFrom(setting: string, machines: { serial: string; name: string }[]): string[] {
  const { first, firstSet } = parseRouteSetting(setting, machines);
  const rest = machines.filter((m) => !firstSet.has(m.serial)).sort((a, b) => a.name.localeCompare(b.name, "ru")).map((m) => m.serial);
  return [...first, ...rest];
}

/**
 * Что не так с настройкой маршрута: серийники, которых нет среди автоматов
 * плана, и признак «порядок вообще задан».
 *
 * Нужны плану отдельно от самого порядка: опечатка в настройке иначе
 * выглядит как «маршрут просто по имени» — молчаливое игнорирование правки
 * владельца (A4/UX#16).
 */
export function routeIssuesFrom(
  setting: string,
  machines: { serial: string; name: string }[],
): { unknown: string[]; configured: boolean } {
  const { first, unknown } = parseRouteSetting(setting, machines);
  return { unknown, configured: first.length > 0 };
}

export interface ProductAllocation { need: number; fromPurchase: number; fromStock: number; unfilled: number }
export interface MachineAllocation {
  serial: string;
  byProduct: Record<string, ProductAllocation>;
  need: number; fromPurchase: number; fromStock: number; unfilled: number;
}

/**
 * Раздача позиций по автоматам в порядке маршрута: закуп — первому автомату
 * первым, потом склад. Повторы серийников в `route` схлопываются (первое
 * вхождение задаёт позицию) — иначе автомат бы обрабатывался дважды за
 * позицию и суммы задваивались.
 */
export function allocateByRoute(items: PurchaseItem[], route: string[]): MachineAllocation[] {
  const uniqueRoute = [...new Set(route)];
  const out = new Map<string, MachineAllocation>(
    uniqueRoute.map((serial) => [serial, { serial, byProduct: {}, need: 0, fromPurchase: 0, fromStock: 0, unfilled: 0 }]),
  );
  for (const i of items) {
    let restPurchase = i.fromPurchase, restStock = i.fromStock;
    for (const serial of uniqueRoute) {
      const need = i.perMachine[serial] ?? 0;
      if (need <= 0) continue;
      const fromPurchase = Math.min(need, restPurchase); restPurchase -= fromPurchase;
      const fromStock = Math.min(need - fromPurchase, restStock); restStock -= fromStock;
      const unfilled = need - fromPurchase - fromStock;
      const m = out.get(serial)!;
      m.byProduct[i.product] = { need, fromPurchase, fromStock, unfilled };
      m.need += need; m.fromPurchase += fromPurchase; m.fromStock += fromStock; m.unfilled += unfilled;
    }
  }
  return [...out.values()];
}

export interface SlotPlanRow {
  coilId: string; product: string; quantity: number; capacity: number;
  need: number; fromPurchase: number; fromStock: number; unfilled: number;
}

/** Раздача по слотам одного автомата: меньший coilId первым; сначала закуп, потом склад, остаток — пусто. */
export function allocateBySlots(slots: Slot[], alloc: MachineAllocation, maxCapacity = MAX_CAPACITY): SlotPlanRow[] {
  const left = new Map<string, { p: number; s: number }>();
  for (const [product, a] of Object.entries(alloc.byProduct)) left.set(product, { p: a.fromPurchase, s: a.fromStock });
  const rows: SlotPlanRow[] = [];
  const ordered = [...slots].sort((a, b) => coilOrder(a.coilId, b.coilId));
  for (const s of ordered) {
    if (!hasProduct(s) || !slotValid(s, maxCapacity)) continue;
    const need = slotDeficit(s);
    if (need <= 0) continue;
    const product = s.product!.trim();
    const l = left.get(product) ?? { p: 0, s: 0 };
    const fromPurchase = Math.min(need, l.p); l.p -= fromPurchase;
    const fromStock = Math.min(need - fromPurchase, l.s); l.s -= fromStock;
    left.set(product, l);
    rows.push({
      coilId: s.coilId, product, quantity: Math.min(s.quantity, s.capacity), capacity: s.capacity,
      need, fromPurchase, fromStock, unfilled: need - fromPurchase - fromStock,
    });
  }
  return rows;
}
