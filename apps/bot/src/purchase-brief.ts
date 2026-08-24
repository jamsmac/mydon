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
    // Раздача (П5a): часть дефицита закрывается складом, часть слотов не
    // закроется вовсе. Без этой строки «купить N» читалось как «после закупа
    // всё полно», хотя пустые слоты остаются и их видно только в плане.
    if (p.totalFromStock > 0 || p.totalUnfilled > 0) {
      const unfilled = p.totalUnfilled > 0 ? ` · пусто ${RU(p.totalUnfilled)}` : "";
      lines.push(
        `В автоматы: из закупа ${RU(p.totalFromPurchase)} · со склада ${RU(p.totalFromStock)}${unfilled} — «план закупа»`,
      );
    }

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
  // «ещё не принял», «не получил» — отрицание прямо перед глаголом: владелец
  // говорит, что приёмки НЕ было, а не наоборот (найдено адверсариал-ревью).
  // Без \b: в JS-regex он не срабатывает после кириллицы (не входит в \w) —
  // тот же нюанс, что и в stock-intake.ts.
  if (/не\s+(прин\w*|получ\w*)/.test(t)) return false;
  return /(принят|принял|приёмк|приемк|получен|получил)/.test(t) && /(закуп|заказ|товар|накладн|склад)/.test(t);
}

/**
 * Разбор «сколько сразу раздали по автоматам» из той же команды приёмки —
 * реальный процесс владельца (лист «Snack склад»): часть закупа при приёмке
 * сразу уходит в автоматы, минуя склад. Без этого зачислялся бы на склад весь
 * order, и до следующего пересчёта («склад X N») это выглядело бы как
 * фиктивная недостача.
 *
 * Формат: всё после ПЕРВОГО двоеточия — пары «товар N» (как у ввода склада).
 * Без двоеточия — распределения нет, приёмка ведёт себя как раньше (весь
 * order на склад): «принять закуп» само по себе не требует уточнения.
 *
 * Имя товара не может содержать двоеточие: если владелец вставил пояснение
 * с своим двоеточием ДО списка («Принял: по факту раскладка: Кола 5, …»),
 * этот кусок просто не распознаётся как пара, а не склеивается в мусорный
 * ключ вида «по факту раскладка: Кола» → 5 (найдено адверсариал-ревью).
 */
export function parseReceiveDistribution(text: string): Record<string, number> | undefined {
  const colon = text.indexOf(":");
  if (colon === -1) return undefined;
  const body = text.slice(colon + 1).trim();
  if (!body) return undefined;

  const out: Record<string, number> = {};
  for (const chunk of body.split(/[,;\n]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    const m = /^([^:]*?)[\s:.\-—=]*(\d+)$/.exec(part);
    if (!m) continue;
    const product = m[1].trim().replace(/[«»"']/g, "");
    const qty = Number(m[2]);
    if (!product || !Number.isInteger(qty) || qty < 0) continue;
    out[product] = qty;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Подтверждение приёмки накладной на склад. */
export function formatReceiveOrderAck(res: {
  received: boolean;
  replenished: number;
  units: number;
  distributedUnits?: number;
  unmatchedDistribution?: string[];
  recordedPurchases?: number;
  reason?: string;
}): string {
  if (!res.received) return res.reason ?? "Непринятых накладных нет.";
  const lines = [`📥 Накладная принята на склад.`, "", `Зачислено на склад: ${res.units} ед. (${res.replenished} поз.)`];
  if (res.recordedPurchases && res.recordedPurchases > 0) {
    lines.push(`Журнал прихода: ${res.recordedPurchases} поз. Фото чека — пришли с подписью «чек».`);
  }
  if (res.distributedUnits && res.distributedUnits > 0) {
    lines.push(`Распределено по автоматам: ${res.distributedUnits} ед.`);
  }
  // Не молчим, если распределение не совпало ни с одной позицией накладной —
  // иначе выглядит так, будто оно учтено, а сумма тихо ушла на склад
  // (найдено адверсариал-ревью).
  if (res.unmatchedDistribution && res.unmatchedDistribution.length > 0) {
    lines.push(`⚠️ Не найдено в накладной (ушло на склад): ${res.unmatchedDistribution.join(", ")}`);
  }
  lines.push("", `«что заказать» — пересчитать закуп с учётом прихода.`);
  return lines.join("\n");
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

// ── Команда цены: «цена <товар> <число> [точно]» (П3) ────────────────────────
// Единственный живой путь правки vending_product.purchasePrice: сид существующие
// строки не трогает, CRUD в панели нет — «⚠️ Без цены — на разбор» из брифинга
// чинится прямо здесь. Гейт ±20% и подтверждение словом «точно» — процесс,
// проверенный в mydon-stock (PRICE_SPIKE_PCT), но без FSM: состояние заменяет
// повтор той же команды.

export interface PriceCommand {
  product: string;
  price: number;
  confirmed: boolean;
}

/** Начинается со слова «цена» (без \b — он не работает после кириллицы). */
export function isPriceCommand(text: string): boolean {
  return /^цена(\s|:|$)/i.test(text.trim());
}

/**
 * «цена TUC 12000», «цена: кола 12 000 точно», «цена ред булл 9к».
 * Число — в конце (пробелы внутри допустимы, «к» = ×1000); всё между «цена»
 * и числом — имя товара как в карточке/алиасе. null → показать формат.
 */
export function parsePriceCommand(text: string): PriceCommand | null {
  let t = text.trim().replace(/^цена\s*:?\s*/i, "");
  const confirmed = /(^|[\s,])точно(?=$|[\s,.!])/i.test(t);
  if (confirmed) t = t.replace(/(^|[\s,])точно(?=$|[\s,.!])/gi, " ").trim();
  // Число — ОДИН токен: пробелы внутри только как разделители тысяч (группы
  // ровно по 3). Жадное «\d[\d\s]*» склеивало числовой хвост имени с ценой:
  // «Cola 330 9000» давало цену 3 309 000 (найдено адверсариал-ревью).
  // Хвост «сум»/точка — самое естественное написание, не отвергаем.
  const m = /^(.+?)[\s:—=-]+(\d+(?:[\s\u00a0\u202f]\d{3})*)\s*([кk])?\s*(?:сум\.?|sum|uzs)?\s*[.!]?\s*$/i.exec(t);
  if (!m) return null;
  const product = m[1].trim().replace(/[,;:—-]+$/, "").trim();
  if (!product) return null;
  const digits = m[2].replace(/[\s\u00a0\u202f]+/g, "");
  let price = Number(digits);
  if (m[3]) price *= 1000;
  // Потолок — защита от строки штрихкода, принятой за цену: дороже 10 млн сум
  // за единицу в этом бизнесе не бывает.
  if (!Number.isInteger(price) || price <= 0 || price > 10_000_000) return null;
  return { product, price, confirmed };
}

/** Ответ на команду цены — успех, гейт или «не найден». */
export function formatPriceResult(res: {
  ok: boolean;
  product?: string;
  oldPrice?: number | null;
  newPrice?: number;
  deviationPct?: number;
  reason?: "not_found" | "spike";
}): string {
  if (res.ok) {
    const from = res.oldPrice === null || res.oldPrice === undefined ? "не была задана" : `${RU(res.oldPrice)} сум`;
    return [
      `💰 Цена «${res.product}»: ${from} → ${RU(res.newPrice ?? 0)} сум.`,
      "",
      "«что заказать» — пересчитать закуп по новой цене.",
    ].join("\n");
  }
  if (res.reason === "spike") {
    return [
      `⚠️ Новая цена ${RU(res.newPrice ?? 0)} сум отличается от текущей ${RU(res.oldPrice ?? 0)} сум на ${res.deviationPct}%.`,
      "",
      `Если это не опечатка — повтори со словом «точно»: «цена ${res.product} ${res.newPrice} точно».`,
    ].join("\n");
  }
  return `Товар «${res.product ?? "?"}» не найден в прайсе вендинга. Имя должно совпадать с карточкой товара или её алиасом.`;
}

/** Подсказка формата, когда «цена …» не разобралась. */
export const PRICE_COMMAND_HINT =
  "Формат: «цена <товар> <сум за единицу>», например «цена TUC 12000». Подорожание больше 20% — повтори со словом «точно».";

/**
 * К какой накладной привязать фото чека: последняя принятая, не старше суток.
 * Ограничение по времени осознанное — чек шлют сразу после «принять закуп»,
 * а фото недельной давности к случайной накладной привязывать нельзя.
 */
export function pickReceiptOrder(orders: VendingOrder[], now: Date): VendingOrder | null {
  let best: VendingOrder | null = null;
  for (const o of orders) {
    if (o.status !== "received" || !o.receivedAt) continue;
    const at = new Date(o.receivedAt).getTime();
    if (!Number.isFinite(at) || now.getTime() - at > 24 * 60 * 60 * 1000 || at > now.getTime() + 60_000) continue;
    if (best === null || at > new Date(best.receivedAt as string).getTime()) best = o;
  }
  return best;
}
