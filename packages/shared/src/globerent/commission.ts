/**
 * Комиссия менеджера — ВСЕ ТРИ метода донора PROMACH, на выбор владельца.
 *
 * У донора жили три несовместимые формулы (sales-analytics, commission
 * engine v2, бонус калькулятора) и применялись вразнобой. Здесь все три
 * перенесены дословно, а КАКАЯ действует — решает тумблер «Системы»
 * (GR_COMMISSION_METHOD): выбор метода — слово владельца, не константа кода.
 */

export const COMMISSION_METHODS = ["margin_rate", "tiers", "flat_bonus"] as const;
export type CommissionMethod = (typeof COMMISSION_METHODS)[number];

export const COMMISSION_METHOD_LABELS: Record<CommissionMethod, string> = {
  margin_rate: "процент от маржи сделки (ставка должности)",
  tiers: "тиры от процента маржи (0.5–3.5%)",
  flat_bonus: "процент от фактической прибыли (бонус калькулятора)",
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Метод 1 — sales-analytics донора: комиссия = margin × ставка(%),
 * округление ПОСЛЕ умножения: Math.round(margin × rate) / 100 — дословно
 * (на суммах ~10⁹ сум порядок округления даёт расхождение в тийинах).
 * Окно начисления у донора — месяц выдачи клиенту (DELIVERED_TO_CLIENT).
 */
export function commissionMarginRate(input: { salePrice: number; costTotal: number; ratePct: number }): number | null {
  if (!Number.isFinite(input.salePrice) || !Number.isFinite(input.costTotal)) return null;
  if (input.salePrice <= 0) return null;
  const margin = input.salePrice - input.costTotal;
  return Math.round(margin * input.ratePct) / 100;
}

/** Тир комиссии: полуоткрытый интервал [from, to) по проценту маржи. */
export interface CommissionTier {
  /** null — общий тир; иначе персональный для должности (бьёт общий). */
  positionId: string | null;
  marginPctFrom: number;
  /** null — без верхней границы. */
  marginPctTo: number | null;
  ratePct: number;
  /** net_pocket | margin | revenue — от чего считается база. */
  baseType: "net_pocket" | "margin" | "revenue";
}

/** Seed донора (миграция 029, base_type=net_pocket, общие тиры). */
export const DEFAULT_COMMISSION_TIERS: CommissionTier[] = [
  { positionId: null, marginPctFrom: 0, marginPctTo: 5, ratePct: 0.5, baseType: "net_pocket" },
  { positionId: null, marginPctFrom: 5, marginPctTo: 10, ratePct: 1.5, baseType: "net_pocket" },
  { positionId: null, marginPctFrom: 10, marginPctTo: 15, ratePct: 2.5, baseType: "net_pocket" },
  { positionId: null, marginPctFrom: 15, marginPctTo: null, ratePct: 3.5, baseType: "net_pocket" },
];

/**
 * Подбор тира — правило донора: интервал [from, to) полуоткрытый,
 * персональный тир должности бьёт общий, при пересечении выигрывает
 * больший from. Не подобран → null (комиссия 0, «не подобран tier»).
 */
export function pickTier(
  tiers: readonly CommissionTier[],
  marginPct: number,
  positionId?: string | null,
): CommissionTier | null {
  const candidates = tiers
    .filter(
      (t) =>
        marginPct >= t.marginPctFrom &&
        (t.marginPctTo === null || marginPct < t.marginPctTo) &&
        (t.positionId === null || t.positionId === (positionId ?? null)),
    )
    .sort((a, b) => {
      const aPersonal = a.positionId !== null ? 1 : 0;
      const bPersonal = b.positionId !== null ? 1 : 0;
      if (aPersonal !== bPersonal) return bPersonal - aPersonal;
      return b.marginPctFrom - a.marginPctFrom;
    });
  return candidates[0] ?? null;
}

/**
 * Метод 2 — commission engine v2 донора: маржа считается ОТ СЕБЕСТОИМОСТИ
 * (только официальный контур), тир по проценту маржи, база — по base_type
 * тира. Guard донора: sale ≤ 0 или cost ≤ 0 → null, а не выдуманный ноль.
 */
export function commissionTiers(input: {
  salePrice: number;
  costOfficialTotal: number;
  qty?: number;
  /** «В карман» за единицу (для base_type net_pocket). null — базы нет. */
  netPocketPerUnit?: number | null;
  tiers?: readonly CommissionTier[];
  positionId?: string | null;
}): { commission: number; marginPct: number; tier: CommissionTier } | null {
  const sale = input.salePrice;
  const cost = input.costOfficialTotal;
  if (!Number.isFinite(sale) || !Number.isFinite(cost) || sale <= 0 || cost <= 0) return null;
  const qty = Math.max(1, input.qty ?? 1);
  const marginPct = round2(((sale - cost) / cost) * 100);
  const tier = pickTier(input.tiers ?? DEFAULT_COMMISSION_TIERS, marginPct, input.positionId);
  if (tier === null) return null;
  let base: number;
  switch (tier.baseType) {
    case "net_pocket": {
      const perUnit = input.netPocketPerUnit;
      if (perUnit === undefined || perUnit === null || !Number.isFinite(perUnit)) return null;
      base = perUnit * qty;
      break;
    }
    case "margin":
      base = sale - cost;
      break;
    case "revenue":
      base = sale * qty;
      break;
  }
  return { commission: round2((base * tier.ratePct) / 100), marginPct, tier };
}

/**
 * Метод 3 — бонус калькулятора: % от ФАКТИЧЕСКОЙ прибыли (после наличных
 * расходов), не от официальной — уточнение владельца донору от 2026-05-17.
 * Отрицательная прибыль бонуса не даёт.
 */
export function commissionFlatBonus(input: { netProfitTotal: number; ratePct?: number }): number {
  const rate = (input.ratePct ?? 8) / 100;
  return round2(Math.max(0, input.netProfitTotal) * rate);
}

/** Итог расчёта комиссии выбранным методом. */
export interface CommissionResult {
  method: CommissionMethod;
  commission: number;
  /** Почему комиссии нет/ноль — словами (для UI). */
  note: string | null;
}

/**
 * Диспетчер: считает комиссию МЕТОДОМ, выбранным владельцем в «Системе».
 * Недостающие входы дают честный note, а не тихий ноль.
 */
export function computeCommission(
  method: CommissionMethod,
  figures: {
    salePrice?: number | null;
    costTotal?: number | null;
    costOfficialTotal?: number | null;
    netProfitTotal?: number | null;
    netPocketPerUnit?: number | null;
    qty?: number;
    ratePct?: number;
    tiers?: readonly CommissionTier[];
    positionId?: string | null;
  },
): CommissionResult {
  switch (method) {
    case "margin_rate": {
      if (figures.salePrice == null || figures.costTotal == null) {
        return { method, commission: 0, note: "нет цены продажи или себестоимости" };
      }
      const c = commissionMarginRate({
        salePrice: figures.salePrice,
        costTotal: figures.costTotal,
        ratePct: figures.ratePct ?? 0,
      });
      if (c === null) return { method, commission: 0, note: "цена продажи не заполнена" };
      return { method, commission: c, note: (figures.ratePct ?? 0) === 0 ? "ставка должности не задана" : null };
    }
    case "tiers": {
      if (figures.salePrice == null || figures.costOfficialTotal == null) {
        return { method, commission: 0, note: "нет цены продажи или официальной себестоимости" };
      }
      const r = commissionTiers({
        salePrice: figures.salePrice,
        costOfficialTotal: figures.costOfficialTotal,
        qty: figures.qty,
        netPocketPerUnit: figures.netPocketPerUnit,
        tiers: figures.tiers,
        positionId: figures.positionId,
      });
      if (r === null) return { method, commission: 0, note: "не подобран tier или нет базы net_pocket" };
      return { method, commission: r.commission, note: null };
    }
    case "flat_bonus": {
      if (figures.netProfitTotal == null) {
        return { method, commission: 0, note: "нет фактической прибыли (нужен расчёт калькулятора)" };
      }
      return {
        method,
        commission: commissionFlatBonus({ netProfitTotal: figures.netProfitTotal, ratePct: figures.ratePct }),
        note: figures.netProfitTotal <= 0 ? "прибыль не положительная — бонуса нет" : null,
      };
    }
  }
}
