import { MAX_CAPACITY, slotDeficit, slotValid, type PurchaseItem, type Slot } from "./vending-calc";

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

/** Порядок обхода: серийники из настройки первыми (в их порядке), остальные — по имени. */
export function routeOrderFrom(setting: string, machines: { serial: string; name: string }[]): string[] {
  const known = new Set(machines.map((m) => m.serial));
  const first = setting.split(",").map((s) => s.trim()).filter((s) => s !== "" && known.has(s));
  const seen = new Set(first);
  const rest = machines.filter((m) => !seen.has(m.serial)).sort((a, b) => a.name.localeCompare(b.name, "ru")).map((m) => m.serial);
  return [...first, ...rest];
}

export interface ProductAllocation { need: number; fromPurchase: number; fromStock: number; unfilled: number }
export interface MachineAllocation {
  serial: string;
  byProduct: Record<string, ProductAllocation>;
  need: number; fromPurchase: number; fromStock: number; unfilled: number;
}

/** Раздача позиций по автоматам в порядке маршрута: закуп — первому автомату первым, потом склад. */
export function allocateByRoute(items: PurchaseItem[], route: string[]): MachineAllocation[] {
  const out = new Map<string, MachineAllocation>(
    route.map((serial) => [serial, { serial, byProduct: {}, need: 0, fromPurchase: 0, fromStock: 0, unfilled: 0 }]),
  );
  for (const i of items) {
    let restPurchase = i.fromPurchase, restStock = i.fromStock;
    for (const serial of route) {
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
    if (!s.product || !slotValid(s, maxCapacity)) continue;
    const need = slotDeficit(s);
    if (need <= 0) continue;
    const product = s.product.trim();
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
