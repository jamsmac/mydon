import { TZ } from "@mydon/shared";
import type { VendingPlan, VendingPlanMachine, VendingPurchaseItem } from "./core-client";

/**
 * Телеграм-план закупа (П5a): владелец спрашивает «план закупа» — получает не
 * список «что купить», а готовый маршрут похода: сколько везти в каждый
 * автомат, что взять со склада, что докупить и какие слоты всё равно
 * останутся пустыми. Числа считает Core (GET /vending/plan); здесь только
 * оформление и нарезка на сообщения.
 *
 * Порядок сообщений — порядок действий владельца: сводка и маршрут → что
 * купить на базаре → что забрать со склада → что убрано правилом → слоты по
 * автоматам (шпаргалка на месте).
 */

/** Telegram обрезает на 4096 — держимся заметно ниже (как owner-actions.ts). */
export const TG_BUDGET = 3500;

const RU = (n: number): string => Math.round(n).toLocaleString("ru-RU");

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });

/**
 * «план закупа» / «план закупки» / «маршрут закупа» / «план загрузки».
 * Без `\b`: в JS-regex он не срабатывает после кириллицы (не входит в `\w`) —
 * тот же нюанс, что и в purchase-brief.ts. «что заказать» и «закуп» остаются
 * за брифингом закупа: это другой ответ, а не другая формулировка того же.
 */
export function isPlanCommand(text: string): boolean {
  return /^(план|маршрут)\s+(закуп|загруз)/i.test(text.trim());
}

/** Пометка куска строки, разорванной по бюджету. */
const WRAP = "… ";

/**
 * Режет ОДНУ строку, которая не влезает в сообщение целиком. Такие строки
 * реальны: Core отдаёт «Без цены — вне бюджета: …» и «Нет в прайсе вендинга:
 * …» одним перечислением на все товары. Рвём по последней запятой (или
 * пробелу) до предела, чтобы имя товара не разорвалось пополам; сплошное
 * слово длиннее предела режем по символам — иначе выхода из цикла нет.
 */
function splitLine(line: string, room: number): string[] {
  const out: string[] = [];
  let rest = line;
  let limit = room;
  while (rest.length > limit) {
    const comma = rest.lastIndexOf(", ", limit - 1);
    const space = comma > 0 ? comma : rest.lastIndexOf(" ", limit - 1);
    const cut = space > 0 ? space + 1 : limit;
    const piece = rest.slice(0, cut).trimEnd();
    out.push(out.length === 0 ? piece : `${WRAP}${piece}`);
    rest = rest.slice(cut).trimStart();
    limit = Math.max(1, room - WRAP.length);
  }
  out.push(out.length === 0 ? rest : `${WRAP}${rest}`);
  return out;
}

/**
 * Режет список строк на сообщения ≤ TG_BUDGET, каждое со своим заголовком
 * (продолжение помечается явно — иначе второй кусок читается как отдельный
 * непонятный список). Длина считается ровно так, как её даст join("\n").
 *
 * Инвариант «каждая часть ≤ TG_BUDGET» держится для ЛЮБОГО входа: строку
 * длиннее сообщения сначала рвём сами. Иначе она уходила в Telegram целиком,
 * тот отвечал 400, и владелец не получал ВЕСЬ план, а не одну строку.
 */
function chunk(title: string, lines: string[]): string[] {
  const cont = `${title} (продолжение)`;
  // Сколько остаётся строке в пустом сообщении: заголовок + "\n" + "" + "\n".
  const room = Math.max(1, TG_BUDGET - Math.max(title.length, cont.length) - 2);
  const flat = lines.flatMap((line) => (line.length > room ? splitLine(line, room) : [line]));
  const out: string[] = [];
  let cur: string[] = [title, ""];
  let len = title.length + 1;
  for (const line of flat) {
    if (len + line.length + 1 > TG_BUDGET) {
      out.push(cur.join("\n"));
      cur = [cont, ""];
      len = cont.length + 1;
    }
    cur.push(line);
    len += line.length + 1;
  }
  out.push(cur.join("\n"));
  return out;
}

/** Строка маршрута: сколько везём в автомат и из чего это собрано. */
function machineLine(m: VendingPlanMachine): string {
  const load = m.fromPurchase + m.fromStock;
  const empty = m.unfilled > 0 ? ` · пусто ${RU(m.unfilled)}` : "";
  return `${m.routeIndex}. ${m.name} — загрузить ${RU(load)} (закуп ${RU(m.fromPurchase)} · склад ${RU(m.fromStock)})${empty}`;
}

/** Куда именно уйдёт складской товар: «Olma 3, American Hospital 2». */
function stockByMachine(p: VendingPlan, product: string): string {
  return p.machines
    .filter((m) => m.slots.some((sl) => sl.product === product && sl.fromStock > 0))
    .map((m) => {
      const units = m.slots.filter((sl) => sl.product === product).reduce((sum, sl) => sum + sl.fromStock, 0);
      return `${m.name} ${RU(units)}`;
    })
    .join(", ");
}

/** Строка «забрать со склада»: сколько, куда и что там останется. */
function stockLine(p: VendingPlan, i: VendingPurchaseItem): string {
  const where = stockByMachine(p, i.product);
  return `• ${i.product} — ${RU(i.fromStock)}${where ? ` (${where})` : ""} · останется ${RU(i.stockAfter)}`;
}

/** Строка слота: что стоит сейчас, сколько не хватает и откуда возьмём. */
function slotLine(sl: VendingPlanMachine["slots"][number]): string {
  const src = [
    sl.fromPurchase > 0 ? `закуп ${RU(sl.fromPurchase)}` : "",
    sl.fromStock > 0 ? `склад ${RU(sl.fromStock)}` : "",
    sl.unfilled > 0 ? `пусто ${RU(sl.unfilled)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `слот ${sl.coilId} ${sl.product}: ${sl.quantity}/${sl.capacity} +${sl.need} → ${src}`;
}

/** План закупа сообщениями Telegram: первое — сводка, дальше — разделы. */
export function formatPurchasePlan(p: VendingPlan): string[] {
  const s = p.summary;
  const need = s.totalFromPurchase + s.totalFromStock + s.totalUnfilled;
  if (need === 0) return ["📋 План закупа: грузить нечего — дефицита у автоматов в расчёте нет."];

  const load = s.totalFromPurchase + s.totalFromStock;
  const money = s.costRounded > 0 ? ` на ${RU(s.costRounded)} сум` : "";
  const empty = s.totalUnfilled > 0 ? ` · пусто ${RU(s.totalUnfilled)}` : "";

  // Сводку режем тем же chunk: маршрут — строка на автомат (их два десятка)
  // плюс предупреждение на каждый пропущенный, так что «одно сообщение» —
  // надежда, а не гарантия.
  const head: string[] = [];
  head.push(
    `Загрузить ${RU(load)} из ${RU(need)} нужных · со склада ${RU(s.totalFromStock)} · ` +
      `купить ${RU(s.totalOrder)} ед (${s.items.length} поз.)${money}${empty}`,
  );
  head.push("", "Маршрут:");
  for (const m of p.machines) head.push(machineLine(m));
  const asOf = p.stock.asOf ? ` · инвентаризация ${day(p.stock.asOf)}` : "";
  head.push(
    "",
    `Склад: ${RU(p.stock.totalBefore)} → ${RU(p.stock.totalAfter)} ` +
      `(взять ${RU(p.stock.use)}, вернуть ${RU(p.stock.back)})${asOf}`,
  );
  for (const w of p.warnings) head.push(`⚠️ ${w.message}`);
  const parts: string[] = chunk(`📋 План закупа — ${day(p.generatedAt)}`, head);

  // Что купить — по деньгам сверху: это единственный раздел, где владелец
  // тратит, и порядок должен совпадать с ценой ошибки.
  if (s.items.length > 0) {
    const rows = [...s.items]
      .sort((a, b) => b.costRounded - a.costRounded)
      .map(
        (i) =>
          `• ${i.product} — ${RU(i.order)} (в автоматы ${RU(i.fromPurchase)}, на склад ${RU(i.toStock)}) · ` +
          `${i.noPrice ? "нет цены" : `${RU(i.costRounded)} сум`}`,
      );
    if (s.noPrice.length > 0) rows.push("", `⚠️ Без цены — на разбор: ${s.noPrice.join(", ")}`);
    parts.push(...chunk(`🛒 Купить — ${RU(s.totalOrder)} ед${money}`, rows));
  }

  // Со склада берут и те позиции, которых нет в закупе (убраны правилом или
  // «нет продаж») — иначе владелец приедет на склад без половины списка.
  const fromStock = [...s.items, ...s.excludedByRule, ...s.excludedNoSales].filter((i) => i.fromStock > 0);
  if (fromStock.length > 0) {
    parts.push(
      ...chunk(
        `📦 Со склада собрать — ${RU(s.totalFromStock)} ед`,
        fromStock.map((i) => stockLine(p, i)),
      ),
    );
  }

  if (s.excludedByRule.length > 0) {
    parts.push(
      ...chunk(
        "🚫 Убрано из закупки — только склад",
        s.excludedByRule.map((i) => `• ${i.product} — со склада ${RU(i.fromStock)}, пусто ${RU(i.unfilled)}`),
      ),
    );
  }

  for (const m of p.machines) {
    if (m.slots.length === 0) continue;
    const title = `🎰 ${m.name} — загрузить ${RU(m.fromPurchase + m.fromStock)}` +
      `${m.unfilled > 0 ? ` · пусто ${RU(m.unfilled)}` : ""}`;
    parts.push(...chunk(title, m.slots.map(slotLine)));
  }

  return parts;
}
