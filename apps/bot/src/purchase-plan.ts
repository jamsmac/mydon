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

/**
 * Сколько сообщений владелец готов принять за один ответ.
 *
 * Слоты печатаются по одному сообщению на автомат, и на парке из 26 машин это
 * 26+ подряд: бот минуту шлёт их в чат, телефон вибрирует, а нужное первое
 * сообщение уезжает вверх — план перестаёт быть планом. Сверх лимита слоты не
 * печатаем, а говорим, где их посмотреть целиком.
 */
export const MAX_PARTS = 12;

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
 *
 * Экспортируется ради усушки (shrinkage-brief.ts): второй такой резчик
 * разъехался бы с этим по бюджету и по пометке продолжения — а лечится это
 * всегда после того, как владелец уже не получил половину отчёта.
 */
export function chunk(title: string, lines: string[]): string[] {
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

/**
 * Строка закупа: сколько взять, почему столько и куда это ляжет.
 *
 * «(в автоматы 12, на склад 0)» читалось как «докупим 12 в автоматы», хотя это
 * РАЗДАЧА уже купленного: сколько встанет в аппараты сегодня, а сколько
 * доедет до склада. Фикс и нехватка названы прямо — иначе «купить 48» при
 * нехватке 10 выглядит ошибкой расчёта, а это решение владельца.
 */
function buyLine(i: VendingPurchaseItem): string {
  const почему = i.fixedQty !== null ? ` (фикс ${RU(i.fixedQty)}; нехватка ${RU(i.buy)})` : "";
  const деньги = i.noPrice ? "нет цены — в сумму не вошло" : `${RU(i.costRounded)} сум`;
  return (
    `• ${i.product} — ${RU(i.order)}${почему} — сразу в автоматы ${RU(i.fromPurchase)}, ` +
    `остальное на склад ${RU(i.toStock)} · ${деньги}`
  );
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
  const заголовок = `📋 План закупа — ${day(p.generatedAt)}`;
  if (need === 0) {
    // «Грузить нечего» без предупреждений — самый опасный ответ плана: он
    // одинаково звучит и когда всё полно, и когда автоматы выпали из расчёта
    // (не в строю, склад не считали, продажи не собрали). Молчать нельзя.
    const пусто = ["Грузить нечего — дефицита у автоматов в расчёте нет."];
    if (p.warnings.length > 0) {
      пусто.push("", "Но посчитано не всё:");
      for (const w of p.warnings) пусто.push(`⚠️ ${w.message}`);
    }
    return chunk(заголовок, пусто);
  }

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
  // «Пусто» — единственное слово плана, которое ничего не значит без пояснения:
  // владелец читал его как «пустые слоты в аппарате», а это штуки, которых не
  // хватит после похода (UX#29).
  if (s.totalUnfilled > 0) head.push(`пусто ${RU(s.totalUnfilled)} — столько штук не закроется ни закупом, ни складом`);
  head.push("", "Маршрут:");
  for (const m of p.machines) head.push(machineLine(m));
  // «Вернуть» звучало как возврат поставщику; на деле это излишек упаковки,
  // который доедет до склада. И дата — про ПЕРЕСЧЁТ склада, а не про план.
  const asOf = p.stock.asOf ? ` · последний пересчёт ${day(p.stock.asOf)}` : " · склад ещё не считали";
  head.push(
    "",
    `Склад: сейчас ${RU(p.stock.totalBefore)} → после похода ${RU(p.stock.totalAfter)} ` +
      `(увезём ${RU(p.stock.use)}, докупим сверх нужды ${RU(p.stock.back)})${asOf}`,
  );
  for (const w of p.warnings) head.push(`⚠️ ${w.message}`);
  const parts: string[] = chunk(заголовок, head);

  // Что купить — по деньгам сверху: это единственный раздел, где владелец
  // тратит, и порядок должен совпадать с ценой ошибки.
  if (s.items.length > 0) {
    const rows = [...s.items].sort((a, b) => b.costRounded - a.costRounded).map(buyLine);
    if (s.noPrice.length > 0) rows.push("", `⚠️ Без цены — на разбор: ${s.noPrice.join(", ")}`);
    // Список без следующего шага заканчивался ничем: владелец прочитал, что
    // купить, и не знал, чем это оформляется (UX#17).
    rows.push("", "Готов покупать — напиши «оформить закуп» (уйдёт тебе на утверждение).");
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
    // Сколько взять со склада уже сказано в 📦 — повторять здесь значит
    // предлагать взять вдвое больше (UX#31). Здесь важно другое: чего не
    // хватит, потому что товар не покупаем.
    parts.push(
      ...chunk(
        "🚫 Убрано из закупки — только склад",
        s.excludedByRule.map((i) => `• ${i.product}${i.unfilled > 0 ? ` — пусто ${RU(i.unfilled)}` : " — закроется складом целиком"}`),
      ),
    );
  }

  // Слоты — последними и с лимитом: на большом парке они одни дают три десятка
  // сообщений подряд, и первое (что купить) уезжает из видимой части чата.
  const сСлотами = p.machines.filter((m) => m.slots.length > 0);
  let напечатано = 0;
  for (const m of сСлотами) {
    const title = `🎰 ${m.name} — загрузить ${RU(m.fromPurchase + m.fromStock)}` +
      `${m.unfilled > 0 ? ` · пусто ${RU(m.unfilled)}` : ""}`;
    const секция = chunk(title, m.slots.map(slotLine));
    const останется = сСлотами.length - напечатано - 1;
    if (parts.length + секция.length + (останется > 0 ? 1 : 0) > MAX_PARTS) break;
    parts.push(...секция);
    напечатано += 1;
  }
  if (напечатано < сСлотами.length) {
    const хвост = `…ещё ${RU(сСлотами.length - напечатано)} автоматов — на листе «План закупа» в панели.`;
    const последняя = parts[parts.length - 1];
    if (parts.length < MAX_PARTS || последняя === undefined || последняя.length + хвост.length + 2 > TG_BUDGET) {
      parts.push(хвост);
    } else {
      parts[parts.length - 1] = `${последняя}\n\n${хвост}`;
    }
  }

  return parts;
}
