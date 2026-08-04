/**
 * Жизненный цикл импортного контракта — перенос syncContractLifecycleFromVehicles
 * PROMACH (Phase 20.9.2): статус контракта выводится из статусов его единиц
 * МОНОТОННО — только вперёд, closed/cancelled не пересинхронизируются.
 *
 * Исправление бага донора: у него 'paying' ОТСУТСТВОВАЛ в таблице рангов
 * (получал ранг 0 как draft), и контракт «в оплате» синк мог утащить назад
 * в signed. Здесь paying стоит между signed и shipping — тест фиксирует.
 */

import type { UnitStatus } from "./unit-status";

export const IMPORT_LIFECYCLE = [
  "draft",
  "signed",
  "paying",
  "shipping",
  "customs",
  "warehoused",
  "delivered",
  "closed",
  "cancelled",
] as const;
export type ImportLifecycle = (typeof IMPORT_LIFECYCLE)[number];

export const IMPORT_LIFECYCLE_LABELS: Record<ImportLifecycle, string> = {
  draft: "черновик",
  signed: "подписан",
  paying: "оплата заводу",
  shipping: "отгрузка",
  customs: "таможня",
  warehoused: "на складе",
  delivered: "передан клиенту",
  closed: "закрыт",
  cancelled: "отменён",
};

/** Ранги монотонности. Донор давал paying ранг 0 — исправлено (см. шапку). */
const RANK: Record<ImportLifecycle, number> = {
  cancelled: -1,
  draft: 0,
  signed: 1,
  paying: 2,
  shipping: 3,
  customs: 4,
  warehoused: 5,
  delivered: 6,
  closed: 7,
};

export const lifecycleRank = (s: ImportLifecycle): number => RANK[s];

/** Статусы единиц, дающие каждую фазу (правила донора дословно). */
const WAREHOUSED_UNITS: readonly UnitStatus[] = ["DELIVERED_TO_WH", "IM40"];
const CUSTOMS_UNITS: readonly UnitStatus[] = ["AT_BORDER", "CUSTOMS_CLEARANCE", "IM74"];
const SHIPPING_UNITS: readonly UnitStatus[] = [
  "READY_FOR_SHIPMENT",
  "IN_TRANSIT_TO_BORDER",
  "IN_TRANSIT_TO_UZ",
];

/**
 * Фаза по статусам единиц контракта. CANCELLED/ARCHIVED исключаются здесь же;
 * не осталось активных единиц — null (no-op, как у донора).
 * Приоритет — сверху вниз: склад > таможня > отгрузка > подписан.
 */
export function lifecycleFromUnits(unitStatuses: readonly string[]): ImportLifecycle | null {
  const active = unitStatuses.filter((s) => s !== "CANCELLED" && s !== "ARCHIVED");
  if (active.length === 0) return null;
  const has = (list: readonly UnitStatus[]): boolean =>
    active.some((s) => (list as readonly string[]).includes(s));
  if (has(WAREHOUSED_UNITS)) return "warehoused";
  if (has(CUSTOMS_UNITS)) return "customs";
  if (has(SHIPPING_UNITS)) return "shipping";
  return "signed";
}

/**
 * Монотонный шаг: куда двигать контракт. null — не двигать (назад нельзя,
 * closed/cancelled заморожены, вычислить нечего).
 */
export function monotonicLifecycleStep(
  current: ImportLifecycle,
  computed: ImportLifecycle | null,
): ImportLifecycle | null {
  if (computed === null) return null;
  if (current === "closed" || current === "cancelled") return null;
  if (RANK[computed] > RANK[current]) return computed;
  return null;
}

/**
 * Правила финальных фаз (донор): delivered — ВСЕ активные единицы переданы
 * актами И у всех есть UZS-договор; closed — delivered + каждый договор
 * оплачен полностью (в сумовом эквиваленте — антибаг донора).
 */
export function finalLifecycle(input: {
  activeUnits: { inHandoverAct: boolean; hasSaleContract: boolean }[];
  allSaleContractsPaid: boolean;
}): "delivered" | "closed" | null {
  if (input.activeUnits.length === 0) return null;
  const delivered = input.activeUnits.every((u) => u.inHandoverAct && u.hasSaleContract);
  if (!delivered) return null;
  return input.allSaleContractsPaid ? "closed" : "delivered";
}
