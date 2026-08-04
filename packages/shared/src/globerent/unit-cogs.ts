/**
 * Себестоимость единицы техники — перенос recalc_vehicle_cost PROMACH.
 *
 * Факт: платежи money_flow, привязанные к единице (unit_id), направление out.
 * Корзины донора: закуп (supplier) / логистика / таможня / прочее.
 * Суммы — в сумовом эквиваленте по курсу записи; запись без курса не
 * выдумывается — считается отдельно («неприведённая»), итог честно неполон.
 */

export interface CogsRow {
  category: string | null;
  /** Сумовой эквивалент записи. null — курса нет. */
  uzs: number | null;
}

export interface CogsBreakdown {
  supplier: number;
  logistics: number;
  customs: number;
  other: number;
  totalUzs: number;
  /** Записей без курса — в итог не вошли. */
  unconverted: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function cogsBreakdown(rows: readonly CogsRow[]): CogsBreakdown {
  const b: CogsBreakdown = { supplier: 0, logistics: 0, customs: 0, other: 0, totalUzs: 0, unconverted: 0 };
  for (const r of rows) {
    if (r.uzs === null || !Number.isFinite(r.uzs)) {
      b.unconverted += 1;
      continue;
    }
    if (r.category === "supplier") b.supplier += r.uzs;
    else if (r.category === "logistics") b.logistics += r.uzs;
    else if (r.category === "customs") b.customs += r.uzs;
    else b.other += r.uzs;
    b.totalUzs += r.uzs;
  }
  b.supplier = round2(b.supplier);
  b.logistics = round2(b.logistics);
  b.customs = round2(b.customs);
  b.other = round2(b.other);
  b.totalUzs = round2(b.totalUzs);
  return b;
}

/**
 * Маржа сделки по единице (донор, sales-analytics):
 * marginPct = ROUND((sale − cost) / sale × 100, 2) — от ЦЕНЫ ПРОДАЖИ
 * (в отличие от тиров комиссии, где маржа считается от себестоимости).
 */
export function unitMargin(salePrice: number, costTotal: number): { margin: number; marginPct: number | null } {
  const margin = round2(salePrice - costTotal);
  const marginPct = salePrice > 0 ? round2((margin / salePrice) * 100) : null;
  return { margin, marginPct };
}
