/**
 * Отчёт владельцу о фактическом расходе кофе-ингредиентов — прямо в Telegram.
 *
 * «расход кофе» → сводка за 30 дней: заливка − возврат наборов через тару
 * (GET /coffee/container-consumption). Та же математика, что в панели
 * (Сверка → «Расход по наборам»), но без открытия панели.
 */

export interface CoffeeConsumptionReport {
  from: string;
  to: string;
  locations: {
    locationId: string;
    locationName: string;
    grams: number;
    cost: number | null;
    pairs: number;
    unknownPairs: number;
  }[];
  totalGrams: number;
  totalCost: number | null;
}

/** Вопрос владельца о расходе кофе/бункеров/наборов. */
export function isCoffeeConsumptionQuery(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /расход/.test(t) && /(кофе|бункер|набор)/.test(t);
}

const num = (n: number) => Math.round(n).toLocaleString("ru-RU");

/** Сводка словами: итог, топ точек, честное «не посчитать». */
export function formatCoffeeConsumption(rep: CoffeeConsumptionReport): string {
  if (rep.locations.length === 0) {
    return (
      `Расход по наборам за ${rep.from} — ${rep.to}: пар «заливка → возврат» нет.\n` +
      "Расход появляется, когда набор засыпали (с номером) и вернули с весом."
    );
  }

  const lines = [
    `☕ Расход по наборам · ${rep.from} — ${rep.to}`,
    "",
    `Всего: ${num(rep.totalGrams)} г` +
      (rep.totalCost !== null ? ` · себестоимость ${num(rep.totalCost)} сум` : " · цены ингредиентов не заведены"),
    "",
  ];
  for (const l of rep.locations.slice(0, 8)) {
    lines.push(
      `• ${l.locationName}: ${num(l.grams)} г` +
        (l.cost !== null ? ` · ${num(l.cost)} сум` : "") +
        (l.unknownPairs > 0 ? ` · не посчитать: ${l.unknownPairs}` : ""),
    );
  }
  if (rep.locations.length > 8) lines.push(`…и ещё точек: ${rep.locations.length - 8}`);

  const unknownTotal = rep.locations.reduce((s, l) => s + l.unknownPairs, 0);
  if (unknownTotal > 0) {
    lines.push("", `Пар без тары или с противоречием веса: ${unknownTotal} — они не выдуманы нулями.`);
  }
  return lines.join("\n");
}

/** Период отчёта: последние 30 дней по Ташкенту. */
export function consumptionPeriod(now = new Date()): { from: string; to: string } {
  const iso = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 30);
  return { from: iso(fromDate), to: iso(now) };
}
