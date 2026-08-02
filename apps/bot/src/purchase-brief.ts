import type { VendingPurchase, VendingOrder } from "./core-client";

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

/**
 * Команда «оформить закуп» — отправить закуп на утверждение (§5.7), в отличие
 * от «что заказать» (просто показать). Требуем и глагол-намерение, и слово о
 * закупе, чтобы не спутать с брифингом: «закуп» сам по себе остаётся брифингом.
 */
export function isPurchaseSubmitCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  const verb = /(оформ|заявк|отправ|на утвержд|подтверд|согласу)/.test(t);
  const about = /(закуп|заказ)/.test(t);
  return verb && about;
}

/** Подтверждение отправки закупа владельцу. */
export function formatPurchaseSubmitAck(res: {
  submitted: boolean;
  positions: number;
  costRounded: number;
  reason?: string;
}): string {
  if (!res.submitted) return res.reason ?? "Закупать нечего — заявка не нужна.";
  const sum = Math.round(res.costRounded).toLocaleString("ru-RU");
  return [
    `✋ Заявка на закуп отправлена на утверждение.`,
    "",
    `Позиций: ${res.positions} · сумма ~${sum} сум.`,
    `Смотри «согласования» — там ✅ Одобрить / ❌ Отклонить.`,
  ].join("\n");
}

/**
 * Команда приёмки закупа на склад: «принять закуп», «закуп принят», «принял
 * товар». Требуем глагол приёмки + слово о закупе/товаре, чтобы не спутать с
 * решением по согласованию.
 */
export function isPurchaseReceiveCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /(принят|принял|приёмк|приемк|получен|получил)/.test(t) && /(закуп|заказ|товар|накладн|склад)/.test(t);
}

/** Подтверждение приёмки накладной на склад. */
export function formatReceiveOrderAck(res: {
  received: boolean;
  replenished: number;
  units: number;
  reason?: string;
}): string {
  if (!res.received) return res.reason ?? "Непринятых накладных нет.";
  return [
    `📥 Накладная принята на склад.`,
    "",
    `Пополнено позиций: ${res.replenished} · всего ${res.units} ед.`,
    `«что заказать» — пересчитать закуп с учётом прихода.`,
  ].join("\n");
}

/** Запрос списка накладных закупа (материализованы при одобрении). */
export function isPurchaseOrdersQuery(text: string): boolean {
  return /(накладн|история закуп|заказы закуп|оформленн.* закуп)/i.test(text.trim().toLowerCase());
}

const ORDER_STATUS: Record<VendingOrder["status"], string> = {
  approved: "одобрена",
  ordered: "заказана",
  received: "принята",
  cancelled: "отменена",
};

/** Список накладных закупа для владельца. */
export function formatPurchaseOrders(orders: VendingOrder[]): string {
  if (orders.length === 0) {
    return "📄 Накладных закупа пока нет. Одобри заявку — «оформить закуп», затем «согласования».";
  }
  const lines = orders.slice(0, 10).map((o) => {
    const when = new Date(o.createdAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    const sum = Math.round(o.costRounded).toLocaleString("ru-RU");
    return `• ${when} — ${o.positions} поз., ~${sum} сум (${ORDER_STATUS[o.status] ?? o.status})`;
  });
  if (orders.length > 10) lines.push(`…и ещё ${orders.length - 10}`);
  return ["📄 Накладные закупа:", "", ...lines].join("\n");
}
