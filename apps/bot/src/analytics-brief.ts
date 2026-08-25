import { SALE_PRICE_FACT_DAYS, TZ } from "@mydon/shared";
import type {
  DeadRow,
  DeadStockReport,
  MarginMachine,
  MarginProduct,
  MarginReport,
  PriceChange,
  PriceChangesReport,
  PriceGapReport,
  PriceGapRow,
} from "@mydon/shared";
import type {
  AnalyticsWarning,
  AnalyticsWarningCode,
  BootstrapSalePriceResult,
  BootstrapSkipReason,
  OurvendHealth,
  SetSalePriceResult,
  WithWarnings,
} from "./core-client";
import { isNonPositivePrice, parsePriceCommand } from "./purchase-brief";
import { MAX_PARTS, RU, chunk } from "./purchase-plan";

/**
 * Аналитика снек-контура в Telegram (П5b): маржа, мёртвый сток, изменения цен,
 * разрыв витрины с эталоном, здоровье сбора OurVend.
 *
 * Числа считает Core (`@mydon/shared/vending-reports` — один расчёт на всех,
 * R-P5b-10); здесь только разбор фразы, оформление и нарезка на сообщения.
 *
 * ТРИ ПРАВИЛА, КОТОРЫЕ ЗДЕСЬ НЕЛЬЗЯ «УПРОСТИТЬ».
 *
 * 1. Каждый заголовок называет охват — «снек-автоматы (OurVend)» (R-P5b-9).
 *    Кофейный контур сюда не входит вовсе: `coffee_sale` пуст, и «маржа» без
 *    оговорки читалась бы как маржа всего парка. При этом «нет данных по
 *    кофе» тоже не пишем — это отчёт не про кофе, а не отчёт с дыркой.
 *
 * 2. Пустой отчёт — не «всё хорошо». «Продаж нет», «эталон не задан», «цена
 *    закупки неизвестна», «снимков нет» пишутся словами. Нули вместо них
 *    выглядят как посчитанный результат, хотя не посчитано ничего.
 *
 * 3. Товар без себестоимости называется в КАЖДОЙ витрине маржи. Его выручка
 *    остаётся в отчёте, а cogs нет, значит маржа завышена ровно на неё
 *    (R-P5b-2). Спрятать это в число «маржа 27.6 %» — соврать на всю сумму.
 */

/** Сколько строк товаров показываем в марже: дальше это уже не сводка. */
const PRODUCTS_SHOWN = 10;
/** Сколько позиций мёртвого стока помещается в раздел, не превращая его в простыню. */
const DEAD_ROWS_SHOWN = 40;
/** Сколько изменений цен показываем на ленту. */
const CHANGES_SHOWN = 20;
/** Сколько прогонов сбора называем поимённо. */
const RUNS_SHOWN = 5;
/** Сколько строк разрыва витрины помещается в отчёт (как у прочих списков). */
const GAP_ROWS_SHOWN = 30;

/** Окна по умолчанию и потолки Core (DTO): зажимаем здесь, чтобы не ловить 400. */
export const MARGIN_DAYS_DEFAULT = 30;
export const MARGIN_DAYS_MAX = 90;
export const DEAD_STOCK_DAYS_DEFAULT = 21;
export const DEAD_STOCK_DAYS_MAX = 180;
export const PRICE_CHANGES_DAYS_DEFAULT = 30;
export const PRICE_CHANGES_DAYS_MAX = 180;
export const PRICE_GAP_DAYS_MAX = 90;
/**
 * Окно факта витрины — ОБЩЕЕ с Core (`SALE_PRICE_FACT_DAYS` в `@mydon/shared`).
 *
 * Своей копии (`PRICE_GAP_DAYS_DEFAULT = 14`) здесь больше нет: гейт команды
 * «цена продажи» считает факт по числу Core, а бриф подписывал окно своим —
 * разъехавшись, они дали бы «цена принята» на то самое расхождение, которое
 * отчёт в том же письме называет разрывом.
 */
export { SALE_PRICE_FACT_DAYS };
/**
 * «витрина как факт»: окно то же, что у отчёта, а потолок — СВОЙ.
 * `BootstrapSalePriceDto` допускает 180 суток (в отличие от `PriceGapDto`
 * с его 90), и общий потолок молча срезал бы «витрина как факт за 120 дней»
 * до 90 — эталон встал бы не по тому окну, которое просил владелец.
 */
export const BOOTSTRAP_DAYS_MAX = 180;

// ── Разбор фраз ─────────────────────────────────────────────────────────────

/**
 * «маржа», «маржа за 7 дней», «маржинальность автоматов».
 *
 * Без `\b`: в JS-regex он не срабатывает после кириллицы (не входит в `\w`) —
 * тот же нюанс, что в purchase-plan.ts. Якорь `^` обязателен: «что там с
 * маржой» — это вопрос к ассистенту, а не запрос отчёта.
 */
export function isMarginQuery(text: string): boolean {
  return /^марж(а|е|и|у|ой|инал)/i.test(text.trim());
}

/** «мёртвый сток», «мертвый сток», «мёртвые остатки». Обе буквы «е/ё» — живые. */
export function isDeadStockQuery(text: string): boolean {
  return /^(мёртв|мертв)/i.test(text.trim());
}

/**
 * «цены», «цены за 60 дней», «изменения цен».
 *
 * `цены` и `цена` различаются одной буквой и означают противоположное: первое
 * — отчёт, второе — ПРАВКА закупочной цены. Поэтому здесь строгий хвост
 * `(\s|:|$)`, а не префикс `^цен`.
 */
export function isPriceChangesQuery(text: string): boolean {
  return /^цены(\s|:|$)|^изменени[а-я]*\s+цен/i.test(text.trim());
}

/**
 * «витрина как факт» — разовый бутстрап эталона по факту продаж.
 * Проверяется СТРОГО раньше `isPriceGapQuery`: обе фразы начинаются с
 * «витрина», и отчёт перехватил бы мутацию.
 */
export function isSalePriceBootstrapCommand(text: string): boolean {
  return /^витрина\s+как\s+факт/i.test(text.trim());
}

/** «витрина», «витрина за 30 дней» — отчёт о разрыве с эталоном (кроме бутстрапа). */
export function isPriceGapQuery(text: string): boolean {
  const t = text.trim();
  return /^витрин/i.test(t) && !isSalePriceBootstrapCommand(t);
}

/**
 * «цена продажи TUC 15000» — эталон витрины (R-P5b-6).
 *
 * Ветка обязана стоять СТРОГО раньше закупочной `isPriceCommand`
 * (`/^цена(\s|:|$)/i`): та ловит и эту фразу, и правка ушла бы в закупочную
 * цену — молча, в другую колонку и с другим гейтом.
 */
export function isSalePriceCommand(text: string): boolean {
  return /^цена\s+продажи(\s|:|$)/i.test(text.trim());
}

/** «сверка», «сверься» — здоровье сбора OurVend плюс паритет (R-P5b-8). */
export function isOurvendCheckQuery(text: string): boolean {
  return /^сверк|^свер[ья]/i.test(text.trim());
}

/**
 * Окно из фразы: «маржа за 7 дней» → 7, «маржа 7» → 7, «маржа» → `fallback`.
 *
 * Границы держим здесь, а не надеемся на Core: он отвечает 400 на день вне
 * своего диапазона, а владелец увидел бы «попробуй позже» и стал бы ждать —
 * хотя чинить надо было фразу (та же причина, что у `parseShrinkageDays`).
 */
export function parseDays(text: string, fallback: number, max: number): number {
  const t = text.trim();
  const m = /за\s+(\d{1,4})\s*(?:дн|сут)/i.exec(t) ?? /(?:^|\s)(\d{1,4})\s*$/.exec(t);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), Math.max(1, max));
}

/** Окно отчёта и подсказка, если запрошенное окно пришлось урезать. */
export interface Окно {
  days: number;
  /** `null` — окно взято как есть. Иначе строка для владельца. */
  note: string | null;
}

/**
 * Окно из фразы вместе с объяснением, если оно урезано.
 *
 * «маржа 91» молча превращалась в 90 — владелец видел отчёт, который не
 * просил, и не знал об этом. Потолок держит DTO Core (400 на 91), поэтому
 * зажимать всё равно надо здесь; молчать при этом — нельзя.
 */
export function окно(text: string, fallback: number, max: number): Окно {
  const days = parseDays(text, fallback, max);
  const m = /за\s+(\d{1,4})\s*(?:дн|сут)/i.exec(text.trim()) ?? /(?:^|\s)(\d{1,4})\s*$/.exec(text.trim());
  const просили = m ? Number(m[1]) : null;
  if (просили === null || !Number.isFinite(просили) || просили <= days) return { days, note: null };
  return { days, note: `Максимум ${RU(max)} дн. — показываю за ${RU(days)}.` };
}

/**
 * «цена продажи TUC Sour cream 15 000 точно» → товар, сумма, подтверждение.
 *
 * Число, «к» = ×1000, разделители тысяч и слово «точно» разбирает та же
 * `parsePriceCommand`, что и закупочную цену: второй разбор числа разъехался
 * бы с первым (и «15 000» в одной команде значило бы 15 000, а в другой —
 * 15). `null` → показать формат.
 */
export function parseSalePriceCommand(text: string): { product: string; price: number; confirmed: boolean } | null {
  const rest = хвостЭталона(text);
  return rest === null ? null : parsePriceCommand(`цена ${rest}`);
}

/** Часть фразы после «цена продажи»: `null` — это вообще не та команда. */
function хвостЭталона(text: string): string | null {
  const t = text.trim();
  if (!isSalePriceCommand(t)) return null;
  const rest = t.replace(/^цена\s+продажи\s*:?\s*/i, "").trim();
  return rest === "" ? null : rest;
}

/**
 * «цена продажи TUC -15000» / «цена продажи TUC 0» — цена названа, но такой
 * не бывает (S8). Отдельно от «формат не разобрался»: на подсказку формата
 * владелец ответит той же командой — формат-то у неё верный.
 */
export function isNonPositiveSalePrice(text: string): boolean {
  const rest = хвостЭталона(text);
  return rest !== null && isNonPositivePrice(`цена ${rest}`);
}

/** Подсказка формата, когда «цена продажи …» не разобралась. */
export const SALE_PRICE_HINT =
  "Формат: «цена продажи <товар> <сум за штуку>», например «цена продажи TUC 15000». " +
  "Это ЭТАЛОН витрины, а не закупочная цена (та — «цена TUC 12000»). " +
  "Если эталон расходится с фактом продаж больше чем на 20 % — повтори со словом «точно».";

// ── Оформление ──────────────────────────────────────────────────────────────

/**
 * Деньги: число разрядами и ЕДИНИЦА. «выручка 1 234 567» без «сум» владелец
 * читает как штуки — и первым делом сверяет её со счётчиком автомата.
 *
 * Одна функция на весь бот и одно написание с панелью (`amount()` в
 * `lib/format.ts`): «12 000 сум» здесь и «12 000» там — это про одно число,
 * но выглядит как про разные.
 */
export const сум = (n: number): string => `${RU(n)} сум`;

/**
 * Процент с подписью. `null` — процента НЕТ (нулевая выручка), а не «0 %».
 *
 * Плейсхолдер — голое тире, как в панели (`percent()` в `lib/format.ts`):
 * «— %» читается как «ноль процентов с опечаткой», а не как «считать не из
 * чего».
 */
export const PCT = (p: number | null): string => (p === null ? "—" : `${p} %`);

/** Процент со знаком: «+20 %», «−20 %». Минус — типографский, как в усушке. */
export const ЗНАК = (p: number): string => `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)} %`;

/**
 * «2026-08-18» → «18.08». Голые сутки режем строкой (они уже по Ташкенту),
 * а момент времени переводим в Ташкент: `at` закупочных изменений приходит
 * штампом события, витринных — бизнес-днём.
 */
export const день = (iso: string): string => {
  if (/^\d{4}-\d{2}-\d{2}/.test(iso) && iso.length <= 10) return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" });
};

/** Момент по Ташкенту: «23.08 08:02». Нечитаемый штамп — «?», а не «Invalid Date». */
export const момент = (iso: string | null): string => {
  if (!iso) return "не было";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  // Запятую между датой и временем убираем: «23.08, 08:02» в строке, где
  // рядом стоят другие поля через «·», читается как ещё один разделитель.
  return d
    .toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    .replace(", ", " ");
};

/** Русское склонение по числу: 1 отказ, 2 отказа, 5 отказов. */
export function сущ(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.round(n)) % 100;
  if (a > 10 && a < 20) return many;
  const b = a % 10;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/**
 * Хвост отчёта: почему посчитано не всё (`warnings` от Core, П5b Task 3).
 *
 * Коды, которые отчёт УЖЕ проговорил своими строками, сюда не попадают
 * (`кроме`): владелец не должен читать одно и то же дважды — сначала в теле
 * отчёта, потом в предупреждениях. Именно ради этого у предупреждений есть
 * код, а не только текст.
 *
 * Повторы по тексту гасим, как в усушке: одна и та же причина приходит по
 * каждому автомату, и списком в три десятка одинаковых строк она вытеснила бы
 * сам отчёт.
 */
export function предупреждения(
  warnings: AnalyticsWarning[] | undefined,
  кроме: AnalyticsWarningCode[] = [],
): string[] {
  if (!warnings || warnings.length === 0) return [];
  const видели = new Set<string>();
  const строки: string[] = [];
  for (const w of warnings) {
    if (кроме.includes(w.code) || видели.has(w.message)) continue;
    видели.add(w.message);
    строки.push(`⚠️ ${w.message}`);
  }
  return строки.length === 0 ? [] : ["", "Посчитано не всё:", ...строки];
}

/**
 * Нарезка отчёта на сообщения с потолком частей.
 *
 * Сверх лимита отчёт не досылаем, а честно говорим, где он целиком: три
 * десятка сообщений подряд уносят из видимой части чата первое — то самое, где
 * стоит итог (та же причина, что в `formatShrinkage`).
 *
 * `max` — для недельной сводки (R-P5b-7): её никто не спрашивал, она приходит
 * сама в понедельник утром, и двенадцать сообщений подряд в этом случае
 * читаются как поломка бота, а не как отчёт. `вид` — потому что в панели есть
 * и листы отчётов («Маржа», «Мёртвый сток», «Цены»), и вкладки разделов
 * («Снек»): отправить владельца на несуществующий лист — тот же обман, что
 * промолчать об обрезке.
 */
export function capped(
  title: string,
  lines: string[],
  лист: string,
  max = MAX_PARTS,
  вид: "листе" | "вкладке" = "листе",
): string[] {
  const parts = chunk(title, lines);
  if (parts.length <= max) return parts;
  const kept = parts.slice(0, max - 1);
  kept.push(`…показал ${max - 1} из ${parts.length} частей — остальное на ${вид} «${лист}» в панели.`);
  return kept;
}

/**
 * Что отчёт маржи уже сказал сам: штуки без себестоимости (строка после итога)
 * и продажи не в строю (строка `исключённые`). Повторять их же в хвосте
 * предупреждений значит удлинить отчёт, ничего не добавив.
 */
const ПОКРЫТО_МАРЖОЙ: AnalyticsWarningCode[] = ["unknown_cost", "excluded_sales"];
/** Мёртвый сток сам называет позиции без цены закупки (строка после итога). */
const ПОКРЫТО_СТОКОМ: AnalyticsWarningCode[] = ["unknown_cost"];
/** Витрина сама печатает список «эталон не задан (N): …». */
const ПОКРЫТО_ВИТРИНОЙ: AnalyticsWarningCode[] = ["no_reference"];

/** Строки продаж, выброшенные фильтром «в строю»: названы, а не потеряны (R-P5b-1). */
function исключённые(r: MarginReport): string[] {
  if (r.excluded.length === 0) return [];
  const строки = r.excluded.map((e) => `${e.serial} — ${RU(e.qty)} шт на ${сум(e.amount)}`);
  // «Не в строю» — не единственная причина: серийника может не быть в реестре
  // вовсе (склад «продал», новый автомат без карточки). Утверждать про статус
  // того, чьей карточки нет, значит отправить владельца искать её в списке
  // выведенных из строя.
  return [
    "",
    `⚠️ Не в счёт (карточки автомата нет или он не в строю, ${r.excluded.length}): ${строки.join(" · ")}`,
  ];
}

function машинаСтрока(m: MarginMachine): string {
  const тревога = m.low ? " ⚠️" : "";
  return (
    `• ${m.name}: выручка ${сум(m.revenue)}, маржа ${сум(m.margin)} (${PCT(m.pct)})${тревога} · ${RU(m.qty)} шт` +
    (m.unknownUnits > 0 ? ` · без себестоимости ${RU(m.unknownUnits)} шт` : "")
  );
}

/**
 * Строка товара. Хвост «без себестоимости N шт» обязателен ровно так же, как у
 * автомата (R-P5b-2): без него товар, у которого цены закупки нет, печатается
 * как «маржа 60 000 (100 %)» — лучшая строка списка, хотя затрат по ней просто
 * не посчитали.
 */
export function товарСтрока(p: MarginProduct): string {
  const тревога = p.low ? " ⚠️" : "";
  return (
    `• ${p.product}: маржа ${сум(p.margin)} (${PCT(p.pct)})${тревога} · ${RU(p.qty)} шт · выручка ${сум(p.revenue)}` +
    (p.unknownUnits > 0 ? ` · без себестоимости ${RU(p.unknownUnits)} шт` : "")
  );
}

/** Маржа снек-автоматов сообщениями Telegram. */
export function formatMargin(r: MarginReport & WithWarnings): string[] {
  const title = `💰 Маржа снек-автоматов (OurVend) за ${r.days} дн. (${день(r.from)} — ${день(r.to)})`;
  const lines: string[] = [];

  // Пусто — это НЕ «маржа ноль»: чаще всего это сбой сбора продаж. Нули
  // прочитались бы как посчитанный результат.
  if (r.machines.length === 0 || r.totals.revenue === 0) {
    lines.push(`Считать нечего — продаж за ${r.days} дн. нет.`);
    lines.push(...исключённые(r));
    lines.push(...предупреждения(r.warnings, ПОКРЫТО_МАРЖОЙ));
    return capped(title, lines, "Маржа");
  }

  const t = r.totals;
  lines.push(`Итого: выручка ${сум(t.revenue)}, маржа ${сум(t.margin)} (${PCT(t.pct)}) · ${RU(t.qty)} шт`);
  // Строка обязательна при любом unknownUnits: без неё завышение маржи
  // невидимо, а именно оно и есть цена этого отчёта (R-P5b-2).
  if (t.unknownUnits > 0) {
    const имена = r.unknownProducts.length > 0 ? `: ${r.unknownProducts.join(", ")}` : "";
    lines.push(
      `⚠️ ${RU(t.unknownUnits)} шт без себестоимости — на их выручку маржа завышена${имена}`,
    );
  }

  lines.push("", "Автоматы (по деньгам):");
  for (const m of r.machines) lines.push(машинаСтрока(m));

  if (r.products.length > 0) {
    lines.push("", `Товары (топ ${Math.min(PRODUCTS_SHOWN, r.products.length)} по марже):`);
    for (const p of r.products.slice(0, PRODUCTS_SHOWN)) lines.push(товарСтрока(p));
    // Убыточные и низкомаржинальные — отдельно и с конца списка: в топе их не
    // видно, а решение владельца принимается именно по ним.
    // …и только те, что НЕ попали в топ: на коротком каталоге (34 SKU на
    // проде, а в окне бывает и три) оба списка совпадали строка в строку, и
    // отчёт печатал один и тот же товар дважды под разными заголовками.
    const показаны = new Set(r.products.slice(0, PRODUCTS_SHOWN));
    const слабые = r.products.filter((p) => p.low && !показаны.has(p)).slice(-PRODUCTS_SHOWN);
    if (слабые.length > 0) {
      lines.push("", `Ниже ${r.lowPct} % или в минус (${слабые.length}, кроме показанных выше):`);
      for (const p of слабые) lines.push(товарСтрока(p));
    }
  }

  lines.push(...исключённые(r));
  lines.push(...предупреждения(r.warnings, ПОКРЫТО_МАРЖОЙ));
  return capped(title, lines, "Маржа");
}

/** Строка мёртвой позиции: где лежит, сколько и на сколько денег. */
export function мёртваяСтрока(d: DeadRow): string {
  const где = d.machineName ? `${d.machineName} · ` : d.serial ? `${d.serial} · ` : "";
  // «Цены нет» — не «ноль сум»: складывать такие нули как деньги нельзя.
  const деньги = d.noPrice ? "цена закупки неизвестна" : `≈ ${сум(d.value)}`;
  return `• ${где}${d.product} ${RU(d.qty)} шт — ${деньги}`;
}

/**
 * Раздел мёртвого стока: дорогие позиции сверху, хвост назван числом.
 *
 * Обрезанный список обязан сказать, что он обрезан, И где лежит целиком:
 * молчаливый хвост читается как «это всё», и владелец считает, что мёртвого
 * стока ровно на показанную сумму.
 */
function мёртвыйРаздел(title: string, rows: DeadRow[], lines: string[]): void {
  if (rows.length === 0) return;
  lines.push("", `${title} (${RU(rows.length)}):`);
  for (const d of rows.slice(0, DEAD_ROWS_SHOWN)) lines.push(мёртваяСтрока(d));
  if (rows.length > DEAD_ROWS_SHOWN) {
    lines.push(`…и ещё ${RU(rows.length - DEAD_ROWS_SHOWN)} поз. — весь список на листе «Мёртвый сток» в панели.`);
  }
}

/** Мёртвый сток снек-контура сообщениями Telegram. */
export function formatDeadStock(r: DeadStockReport & WithWarnings): string[] {
  const title = `🪦 Мёртвый сток снек-автоматов (OurVend) за ${r.days} дн.`;
  const всего = r.warehouse.length + r.machines.length;
  const lines: string[] = [];

  if (всего === 0) {
    // «Двигалось всё» — утверждение о ДВИЖЕНИИ, и оно ложно, когда продаж не
    // приехало вовсе: тогда двигаться было нечему. Разницу называет Core
    // кодом `no_sales`, и хвост предупреждений тут обязателен.
    lines.push(`Мёртвых позиций нет: за ${r.days} дн. двигалось всё, что лежит на складе и в автоматах.`);
    lines.push(...предупреждения(r.warnings, ПОКРЫТО_СТОКОМ));
    return capped(title, lines, "Мёртвый сток");
  }

  lines.push(
    `Склад и автоматы: нет движения ${r.days} дн., ${RU(всего)} поз., оценка ≈ ${сум(r.totalValue)} ` +
      `(считаем с ${день(r.since)}).`,
  );
  if (r.noPriceCount > 0) {
    lines.push(`⚠️ У ${RU(r.noPriceCount)} поз. цена закупки неизвестна — в оценку они не вошли.`);
  }

  мёртвыйРаздел("📦 На складе", r.warehouse, lines);
  мёртвыйРаздел("🎰 В автоматах", r.machines, lines);
  lines.push(...предупреждения(r.warnings, ПОКРЫТО_СТОКОМ));
  return capped(title, lines, "Мёртвый сток");
}

export const изменениеСтрока = (c: PriceChange): string =>
  `• ${c.product}: ${RU(c.from)} → ${сум(c.to)} (${ЗНАК(c.pct)}) · ${день(c.at)}`;

function лентаЦен(title: string, rows: PriceChange[], lines: string[]): void {
  if (rows.length === 0) return;
  lines.push("", `${title} (${rows.length}):`);
  for (const c of rows.slice(0, CHANGES_SHOWN)) lines.push(изменениеСтрока(c));
  if (rows.length > CHANGES_SHOWN) {
    lines.push(`…и ещё ${rows.length - CHANGES_SHOWN} изменений — весь список на листе «Цены» в панели.`);
  }
}

/** Изменения цен: закупочные и витринные, свежие сверху. */
export function formatPriceChanges(r: PriceChangesReport & WithWarnings): string[] {
  const title = `📈 Цены снек-автоматов (OurVend) за ${r.days} дн. · порог ${r.pct} %`;
  const lines: string[] = [];
  if (r.purchase.length === 0 && r.retail.length === 0) {
    // «Изменений нет» и «продаж не приехало» — разные новости: витринная лента
    // строится из продаж, и без них она пуста независимо от цен.
    lines.push(`Заметных изменений цен за ${r.days} дн. нет (порог ${r.pct} %).`);
    lines.push(...предупреждения(r.warnings));
    return capped(title, lines, "Цены");
  }
  лентаЦен("🛒 Закупочные (что платим)", r.purchase, lines);
  лентаЦен("🏷 Витринные (что берём в автомате)", r.retail, lines);
  lines.push(...предупреждения(r.warnings));
  return capped(title, lines, "Цены");
}

/** Строка разрыва: факт против эталона и что с этим делать. */
function разрывСтрока(g: PriceGapRow): string {
  const сторона = g.gap > 0 ? "ниже" : "выше";
  const хвост =
    g.lost > 0
      ? `недобор ≈ ${сум(g.lost)}`
      : `продали дороже эталона на ≈ ${сум(-g.lost)} — проверь эталон`;
  return (
    `• ${g.product}: факт ${сум(g.fact)} · эталон ${сум(g.reference)} · ${сторона} на ${Math.abs(g.gapPct)} % · ` +
    `${RU(g.qty)} шт → ${хвост}`
  );
}

/** Витрина против эталона владельца (R-P5b-6). */
export function formatPriceGap(r: PriceGapReport & WithWarnings): string[] {
  const title = `🏷 Витрина снек-автоматов (OurVend) за ${r.days} дн. · порог ${r.pct} %`;
  const lines: string[] = [];
  const недобор = r.rows.filter((g) => g.lost > 0);
  const дороже = r.rows.filter((g) => g.lost <= 0);

  if (r.rows.length === 0) {
    lines.push(
      r.noReference.length > 0
        ? `Там, где эталон задан, витрина сходится: расхождений больше ${r.pct} % нет.`
        : `Витрина сходится с эталоном: расхождений больше ${r.pct} % нет.`,
    );
  } else {
    // Сумма — ТОЛЬКО по недобору: «продали дороже» не выручка, которой можно
    // закрыть недобор, а повод перепроверить сам эталон (R-P5b-6).
    lines.push(`Σ недобор ≈ ${сум(r.lostTotal)} по ${недобор.length} поз. за ${r.days} дн.`);
    if (дороже.length > 0) {
      lines.push(`Продаём дороже эталона: ${дороже.length} поз. — в сумму недобора не входят.`);
    }
    lines.push("");
    const строки = [...недобор, ...дороже];
    for (const g of строки.slice(0, GAP_ROWS_SHOWN)) lines.push(разрывСтрока(g));
    if (строки.length > GAP_ROWS_SHOWN) {
      lines.push(
        `…и ещё ${RU(строки.length - GAP_ROWS_SHOWN)} поз. — весь список на листе «Цены» в панели.`,
      );
    }
  }

  // Товары без эталона — отдельным списком: нулевая строка выглядела бы как
  // «эталон ноль» и дала бы разрыв в 100 %.
  if (r.noReference.length > 0) {
    lines.push(
      "",
      `эталон не задан (${r.noReference.length}): ${r.noReference.join(", ")}`,
      "«цена продажи <товар> <сум>» — задать вручную, «витрина как факт» — проставить по факту продаж.",
    );
  }
  lines.push(...предупреждения(r.warnings, ПОКРЫТО_ВИТРИНОЙ));
  return capped(title, lines, "Цены");
}

/** Ответ на «цена продажи …»: успех, гейт по факту витрины или «не найден». */
export function formatSalePriceResult(r: SetSalePriceResult): string {
  if (r.ok) {
    const было = r.oldPrice === null || r.oldPrice === undefined ? "не была задана" : сум(r.oldPrice);
    return [
      `🏷 Эталон витрины «${r.product}»: ${было} → ${сум(r.newPrice ?? 0)}.`,
      "",
      "«витрина» — посмотреть, где факт продаж разошёлся с эталоном.",
    ].join("\n");
  }
  if (r.reason === "spike") {
    const факт = r.factPrice === null || r.factPrice === undefined ? "неизвестен" : сум(r.factPrice);
    return [
      `⚠️ Эталон ${сум(r.newPrice ?? 0)} отличается от ФАКТА витрины ${факт} на ${r.deviationPct} %.`,
      "",
      `Факт — средняя цена продаж за ${SALE_PRICE_FACT_DAYS} дн. (деньги ÷ штуки), эталон — твоя цена, ` +
        "по которой должно продаваться.",
      `Если так и задумано — повтори со словом «точно»: «цена продажи ${r.product} ${r.newPrice} точно».`,
    ].join("\n");
  }
  // Цену отверг сам Core (не число, не положительная): печатаем ЕГО причину.
  // «Товар не найден» на живой товар с кривой ценой отправил бы владельца
  // искать несуществующую проблему в прайсе (S9).
  if (r.reason === "invalid_price") {
    return [
      `⚠️ ${r.message ?? "Цена должна быть больше нуля."}`,
      "",
      `Назови цену числом: «цена продажи ${r.product ?? "<товар>"} 15000».`,
    ].join("\n");
  }
  return `Товар «${r.product ?? "?"}» не найден в прайсе вендинга. Имя должно совпадать с карточкой товара или её алиасом.`;
}

/** Ответ на «витрина как факт»: что проставили и что пропустили — с причинами. */
export function formatSalePriceBootstrap(r: BootstrapSalePriceResult): string[] {
  const title = `🏷 Витрина как факт — эталон снек-автоматов (OurVend) по продажам за ${r.days} дн.`;
  const безПродаж = r.skipped.filter((s) => s.reason === "no_sales");
  const lines: string[] = [];

  if (r.set.length === 0) {
    lines.push(`Проставлять нечего: ${разбивкаПропуска(r.skipped)}.`);
    return capped(title, lines, "Цены");
  }

  lines.push(`Проставлено ${r.set.length} поз. — теперь это ЭТАЛОН, а не факт: дальше он не двигается сам.`);
  lines.push("");
  for (const s of r.set) lines.push(`• ${s.product} — ${сум(s.price)} (по ${RU(s.qty)} шт продаж)`);
  if (r.skipped.length > 0) {
    lines.push("", `Пропущено ${r.skipped.length}: ${разбивкаПропуска(r.skipped)}.`);
    if (безПродаж.length > 0) {
      lines.push(`Без продаж: ${безПродаж.map((s) => s.product).join(", ")} — задай вручную «цена продажи …».`);
    }
  }
  return capped(title, lines, "Цены");
}

/**
 * Причины пропуска бутстрапа — ВСЕ и с числами, которые сходятся с итогом.
 *
 * «Пропущено 5: эталон уже задан 1, нет продаж 1» — это три потерянных
 * товара: владелец считает, что эталон им проставлен, и разрыв витрины по ним
 * не всплывёт никогда (S9). Хвост «прочее» держит арифметику и на причине,
 * которую Core завёл позже бота.
 */
function разбивкаПропуска(skipped: BootstrapSalePriceResult["skipped"]): string {
  const счёт = (r: BootstrapSkipReason): number => skipped.filter((s) => s.reason === r).length;
  const части: string[] = [];
  const названо = [
    ["already_set", (n: number) => `эталон уже задан ${RU(n)}`],
    ["no_sales", (n: number) => `нет продаж ${RU(n)}`],
    ["no_fact", (n: number) => `продажи есть, а цены из них нет ${RU(n)}`],
    ["inactive", (n: number) => `снят с продажи ${RU(n)}`],
  ] as const;
  let учтено = 0;
  for (const [code, текст] of названо) {
    const n = счёт(code);
    учтено += n;
    if (n > 0) части.push(текст(n));
  }
  if (skipped.length - учтено > 0) части.push(`по прочим причинам ${RU(skipped.length - учтено)}`);
  return части.length === 0 ? "пропущенных нет" : части.join(", ");
}

/**
 * Возраст снимка. `null` — снимков НЕТ вовсе, а это не «свежо».
 *
 * Проверка нестрогая (`== null`) намеренно: поле может не приехать вовсе
 * (старый Core, форма без `productSaleLagH`), и строгое `=== null` печатало бы
 * владельцу «витрина (product_sale) — не число ч» — то есть отчёт о свежести,
 * который сам себя не понял.
 */
/**
 * Со скольких часов снимок считается протухшим.
 *
 * То же число, что красит пилюлю в панели (`HEALTH_LAG_HOURS` в
 * `ourvend-health-view.tsx`): сбор ходит раз в 3 часа, и шесть часов — это
 * ровно два пропущенных прогона. Разойдись пороги — тревога зависела бы от
 * того, куда владелец смотрит, а не от состояния сбора.
 *
 * ЭТО ПРО СВЕЖЕСТЬ СНИМКОВ (`слоты`/`продажи`/`продажи по товарам`), А НЕ ПРО
 * ЗАСТОЙ САМОГО СБОРА (R-P8a-6) — за застой отвечает `h.staleThresholdH` из
 * ответа Core (настройка `SYNC_STALE_HOURS`), см. `строкаЗастоя` ниже.
 * Совпадение чисел (сейчас оба 6) случайно: снимок может быть свежим, пока
 * коллектор уже час как не запускается, и наоборот.
 */
const LAG_ALERT_H = 6;

/** Метка протухшего снимка: та же тревога, что красная пилюля в панели (U10). */
const протух = (часы: number): string => (часы > LAG_ALERT_H ? " ⚠️" : "");

const лагМин = (v: number | null | undefined): string =>
  v == null ? "снимков нет" : v < 90 ? `${RU(v)} мин${протух(v / 60)}` : `${RU(v / 60)} ч${протух(v / 60)}`;
const лагЧ = (v: number | null | undefined): string => (v == null ? "снимков нет" : `${RU(v)} ч${протух(v)}`);

/**
 * Состояние сбора одной фразой: пусто / серия отказов / отказов нет.
 *
 * НИ ОДНОГО ПРОГОНА — ЭТО НЕ «ЗДОРОВ». Зелёная галка над «последний успех: не
 * было» — ровно те «нули как всё хорошо», против которых §7: серия отказов
 * равна нулю просто потому, что сбор ни разу не запускался.
 *
 * Экспортируется ради недельной сводки (R-P5b-7): вторая формулировка того же
 * состояния разошлась бы с этой ровно на пустых прогонах — там, где ошибка и
 * стоит дороже всего (пустая неделя чаще всего и означает стоящий сбор).
 */
export function состояниеСбора(h: OurvendHealth): string {
  if (h.runs.length === 0) {
    return "❓ Прогонов сбора за период нет — здоровье не оценить: сбор не запускался или журнал прогонов пуст";
  }
  if (h.failedStreak > 0) {
    return (
      `❌ ${RU(h.failedStreak)} ${сущ(h.failedStreak, "отказ", "отказа", "отказов")} подряд — ` +
      "сбор стоит, свежих данных нет"
    );
  }
  // ПОСЛЕДНИЙ ПРОГОН УСПЕШЕН — ЭТО НЕ «ВСЁ ХОРОШО». На проде 25.08 один успех
  // в 16:00 закрыл собой 12 отказов подряд с 24.08: `failedStreak` обнулился,
  // и зелёная строка встала над журналом, где упало 12 прогонов из 20.
  const отказов = h.runs.filter((r) => r.status === "failed").length;
  if (отказов > 0) {
    return (
      `✅ Сейчас собирается, но ${RU(отказов)} ${сущ(отказов, "отказ", "отказа", "отказов")} ` +
      `среди последних ${RU(h.runs.length)} ${сущ(h.runs.length, "прогона", "прогонов", "прогонов")}`
    );
  }
  // ЗАСТОЙ (R-P8a-6) — та же ловушка «нули как всё хорошо», только с другой
  // стороны: `failedStreak: 0` держится вечно, если крон вообще перестал
  // ЗАПУСКАТЬСЯ (не падает — МОЛЧИТ), а последний ЗАПИСАННЫЙ прогон был
  // успешным сто лет назад. Строка застоя уже стоит первой в отчёте
  // (`строкаЗастоя`, `formatOurvendHealth`/`здоровье()`) — вторая зелёная
  // галка сразу под ней читалась бы как «на самом деле всё хорошо».
  if (h.staleHours === null || h.staleHours >= h.staleThresholdH) {
    return "❓ Отказов подряд нет, но сбор стоит (см. выше)";
  }
  return "✅ Отказов подряд нет";
}

/**
 * «⛔ сбор стоит N ч» — застой самого коллектора (R-P8a-6), а не протухший
 * снимок. Порог — `h.staleThresholdH` из ответа Core, НЕ `LAG_ALERT_H`: тот
 * порог про снимки, этот — про то, бежит ли сбор вообще (см. комментарий у
 * `LAG_ALERT_H`). `staleHours === null` значит «успешных прогонов не было ни
 * разу» — тревожнее любого числа часов, поэтому тоже застой, а не «нет
 * данных». `null`, когда сбор в норме: пустой строки в отчёте, а не «застоя
 * нет», — молчание и есть сигнал «всё хорошо».
 *
 * ПУСТОЙ ЖУРНАЛ — НЕ ЗАСТОЙ, А «НЕ ИЗМЕРЯЛИ». `runs: []` (никогда не
 * запускался, или `health()` в Core упал и сводка получила
 * `ЗДОРОВЬЕ_НЕИЗВЕСТНО`) даёт `staleHours: null` из тех же соображений, что
 * и настоящий застой, — но здесь это означает «нечего мерить», а не «сто лет
 * без успеха». Печатать «⛔ … успешных прогонов не было» о том, чего не
 * измеряли, — то же враньё, что и зелёная галка на пустых нулях (§7), только
 * с другим знаком. `состояниеСбора` уже говорит «здоровье не оценить» для
 * этого случая, панель (`ourvend-health-view.tsx`) уже гасит свой бейдж на
 * `runs.length === 0` — бот обязан согласиться с обоими.
 */
export function строкаЗастоя(h: OurvendHealth): string | null {
  if (h.runs.length === 0) return null;
  if (h.staleHours === null) return "⛔ сбор стоит — успешных прогонов не было";
  if (h.staleHours >= h.staleThresholdH) {
    return `⛔ сбор стоит ${RU(h.staleHours)} ч — последний успешный прогон ${момент(h.lastSuccessAt)}`;
  }
  return null;
}

/** Счёт прогонов. `null` — журнал пуст: «Прогоны (0)» читалось бы как результат. */
export function прогоныСтрока(runs: OurvendHealth["runs"]): string | null {
  if (runs.length === 0) return null;
  const успешных = runs.filter((r) => r.status === "success").length;
  const частичных = runs.filter((r) => r.status === "partial").length;
  const отказов = runs.filter((r) => r.status === "failed").length;
  return `Прогоны (${runs.length}): успешных ${успешных} · частичных ${частичных} · с отказом ${отказов}`;
}

/** Свежесть снимков: слоты, продажи, витрина. Отсутствующий лаг — «снимков нет». */
export function свежестьСтрока(h: OurvendHealth): string {
  // «product_sale» — имя таблицы кабинета, а не слово владельца. В отчёте, где
  // всё остальное сказано по-русски, оно читается как ошибка (U5).
  return (
    `Свежесть: слоты — ${лагМин(h.slotsLagMin)} · продажи — ${лагЧ(h.salesLagH)} · ` +
    `продажи по товарам (кабинет) — ${лагЧ(h.productSaleLagH)}`
  );
}

/**
 * Паритет с дорожкой OurVend одной строкой.
 *
 * Общая для «сверки» и недельной сводки: посимвольная копия этой строки в
 * двух местах разъехалась бы не по виду, а по смыслу — «✅ сходится» в одном
 * отчёте и «расхождений 3» в другом об одних и тех же сутках.
 */
export function паритетСтрока(p: OurvendHealth["parity"]): string {
  // Вердикт — ПО ПОЛОВИНАМ, а не по общему `ok`. Общий флаг гасит обе
  // половины разом: на проде 25.08 продажи сходились 1-в-1, а снимков
  // остатков за закрытые сутки не было вовсе — и строка печатала
  // «❌ расхождений 0», отчёт, противоречащий сам себе на первом же прогоне.
  //
  // НОЛЬ РАСХОЖДЕНИЙ БЕЗ СВЕРКИ — НЕ «СХОДИТСЯ». Если сверять было не с чем,
  // это говорится словами: зелёная галка над несравнёнными сутками — ровно те
  // «нули как всё хорошо», которые этот отчёт и должен ловить.
  const части = (p.note ?? "").split("; ").filter((ч) => ч !== "");
  const заметкаОстатков = (ч: string): boolean => ч.startsWith("остатки:");
  const продажНет = p.checked === 0;
  const продажи = продажНет
    ? "продажи: сверять нечего"
    : p.mismatches > 0
      ? `продажи ❌ расхождений ${RU(p.mismatches)}`
      : "продажи ✅ сходятся";

  const снимковНет = !p.stockOk && p.stockChecked === 0;
  const остатки = p.stockOk
    ? "остатки ✅"
    : снимковНет
      ? "остатки: снимков за период нет — сверять не по чему"
      : "остатки ❌";

  // Причину, уже сказанную своей половиной, не повторяем: тот же текст вторым
  // разом читается как второй отказ.
  const хвост = части.filter((ч) => (заметкаОстатков(ч) ? !снимковНет : !продажНет));
  return `Паритет за ${p.days} дн.: ${продажи} · ${остатки}${хвост.length > 0 ? ` · ${хвост.join("; ")}` : ""}`;
}

/**
 * «сверка» — здоровье сбора OurVend и паритет одним сообщением (R-P5b-8).
 *
 * Живого запроса к OurVend из бота нет (коннектор живёт в агентах по крону),
 * и делать вид, что «сверка» ходит в кабинет, нельзя. Ответ честный: когда
 * сбор работал в последний раз, насколько свежи снимки и сходятся ли наши
 * числа со stock-дорожкой.
 */
export function formatOurvendHealth(h: OurvendHealth): string[] {
  const title = "🩺 Здоровье сбора снек-автоматов (OurVend) и паритет";
  const lines: string[] = [];
  // Застой сбора — первой строкой, ДО состояния и последнего успеха: владелец,
  // открывший «сверку», обязан увидеть «сбор стоит» раньше всего остального,
  // а не третьей строкой под таблицей прогонов (R-P8a-6).
  const застой = строкаЗастоя(h);
  if (застой) lines.push(застой);
  lines.push(`${состояниеСбора(h)}. Последний успех: ${момент(h.lastSuccessAt)}.`);

  const прогоны = прогоныСтрока(h.runs);
  if (прогоны) lines.push(прогоны);
  lines.push(свежестьСтрока(h), паритетСтрока(h.parity));

  const проблемные = h.runs.filter((r) => r.status !== "success" && r.error).slice(0, RUNS_SHOWN);
  if (проблемные.length > 0) {
    lines.push("", "Последние отказы:");
    for (const r of проблемные) {
      lines.push(`• ${момент(r.startedAt)} — ${r.status}, автоматов ${r.machinesOk}/${r.machinesTotal}: ${r.error}`);
    }
  }
  return capped(title, lines, "Снек · Здоровье сбора");
}
