import type { VendingPurchase } from "./core-client";

/**
 * Телеграм-брифинг закупа (ТЗ Фаза 2): владелец спрашивает «что заказать» —
 * получает готовую сводку к закупу, а не таблицу для разбора. Данные считает
 * Core (GET /vending/purchase, §5.4–5.5); здесь только оформление.
 *
 * Порядок по деньгам: сначала итог (сколько купить и на сколько), потом топ
 * позиций по стоимости. «Не закупать» и «без цены» — отдельными строками, как
 * на панели: это разные решения, их нельзя смешивать с закупом.
 */
const RU = (n: number): string => Math.round(n).toLocaleString("ru-RU");

/** Сколько позиций показать в топе — остальное сворачиваем в «…и ещё N». */
const TOP = 10;

export function formatPurchaseBrief(p: VendingPurchase): string {
  const nothing = p.items.length === 0 && p.excludedNoSales.length === 0 && p.noPrice.length === 0;
  if (nothing) return "🛒 Закупать нечего — дефицита у автоматов в расчёте нет.";

  const lines: string[] = ["🛒 Что заказать", ""];

  if (p.items.length > 0) {
    const money = p.costRounded > 0 ? ` · на ${RU(p.costRounded)} сум` : "";
    lines.push(`Купить ${RU(p.totalBuy)} ед · с упаковками ${RU(p.totalOrder)} ед${money}`);
    if (p.overpay > 0) lines.push(`Переплата за упаковки: ${RU(p.overpay)} сум`);

    // Топ по стоимости: деньги — главный приоритет владельца при закупе.
    const top = [...p.items].sort((a, b) => b.costRounded - a.costRounded).slice(0, TOP);
    lines.push("");
    for (const i of top) {
      const cost = i.noPrice ? "нет цены" : `${RU(i.costRounded)} сум`;
      lines.push(`• ${i.product} — заказать ${RU(i.order)} (нехватка ${RU(i.buy)}) · ${cost}`);
    }
    if (p.items.length > TOP) lines.push(`…и ещё ${p.items.length - TOP}`);
  } else {
    lines.push("Позиций к закупу нет — только разбор ниже.");
  }

  if (p.noPrice.length > 0) {
    lines.push("", `⚠️ Без цены — на разбор: ${p.noPrice.join(", ")}`);
  }
  if (p.excludedNoSales.length > 0) {
    lines.push("", `🚫 Не закупать (нет продаж): ${p.excludedNoSales.map((i) => i.product).join(", ")}`);
  }

  return lines.join("\n");
}
