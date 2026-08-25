import type { ShrinkMachine, ShrinkReport } from "./core-client";
import { chunk, MAX_PARTS } from "./purchase-plan";

/**
 * Усушка автоматов в Telegram (П4, R-P4-3): владелец спрашивает «усушка» —
 * получает, где и на сколько товар не сходится с продажами.
 *
 * Числа считает Core (GET /vending/shrinkage, дни с заливкой из расчёта
 * выкинуты целиком); здесь только оформление и нарезка на сообщения.
 *
 * Порядок внутри автомата — по деньгам: первым читается то, что дороже стоит.
 * Дни заливок идут следом отдельной строкой, потому что отвечают на другой
 * вопрос: не «сколько потеряли», а «почему в эти сутки не считали».
 */

/**
 * Число разрядами. Неразрывный пробел (U+00A0), который ставит ru-RU, меняем на
 * обычный: сумму из отчёта копируют и ищут, а с U+00A0 она не находится и не
 * сходится при сравнении (та же правка, что у formatAmount в правилах Core).
 */
const RU = (n: number): string =>
  Math.round(n).toLocaleString("ru-RU").replace(/[\u00A0\u202F]/g, " ");

/** «2026-08-18» → «18.08». Строкой, а не через Date: даты уже по Ташкенту. */
const day = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/** Сколько позиций показываем по автомату: дальше это уже не сводка. */
const ITEMS_PER_MACHINE = 8;
/** Сколько дней заливок помещается в строку, не превращая её в простыню. */
const REFILL_DAYS_SHOWN = 6;

/** Окно по умолчанию — то же, что у Core (SHRINK_DAYS_DEFAULT). */
export const SHRINK_DAYS_DEFAULT = 14;
/** Потолок Core: за 60 сутками отчёта нет, есть разовая выгрузка. */
const SHRINK_DAYS_MAX = 60;

/**
 * «усушка», «усушка за 30 дней», «потери в автоматах».
 *
 * Без `\b`: в JS-regex он не срабатывает после кириллицы — тот же нюанс, что
 * в purchase-plan.ts. Якорь `^` обязателен: «потеря» в середине фразы про
 * что угодно ещё не должна открывать отчёт по автоматам.
 */
export function isShrinkageQuery(text: string): boolean {
  return /^усушк|^потер[ия]\s*(в\s*)?автомат/i.test(text.trim());
}

/**
 * Окно из фразы: «усушка за 30 дней» → 30.
 *
 * Границы держим здесь, а не надеемся на Core: он отвечает 400 на день вне
 * 1..60, а владелец увидел бы «попробуй позже» и стал бы ждать — хотя чинить
 * надо было фразу.
 */
export function parseShrinkageDays(text: string, fallback = SHRINK_DAYS_DEFAULT): number {
  const m = /за\s+(\d{1,4})\s*(дн|сут)/i.exec(text);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, SHRINK_DAYS_MAX);
}

/** Длина периода в сутках включительно. 0 — если даты не разобрались. */
function periodDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Строка позиции: штуки и деньги. Без цены — так и говорим. */
function itemText(i: ShrinkMachine["summary"]["items"][number]): string {
  const деньги = i.noPrice ? "(цены нет)" : `≈ ${RU(i.lossValue)} сум`;
  return `${i.product} −${i.lossUnits} шт ${деньги}${i.alert ? " ⚠️" : ""}`;
}

/** Блок одного автомата: одна строка разбора плюс строка заливок. */
function machineLines(m: ShrinkMachine, days: number): string[] {
  // Ни одних посчитанных суток — расчёта НЕ БЫЛО (R-FW-7). Проверка стоит
  // первой, до «без потерь»: у такого автомата и позиций нет, и он уходил бы в
  // «без потерь», то есть в утверждение, которого никто не считал. Ровно так
  // контроль усушки обходится источником, шумящим приходом каждые сутки.
  if (m.summary.daysCounted === 0) {
    const всего = days > 0 ? days : m.summary.daysSkipped;
    return [`• ${m.name}: не считали — все ${всего} дн. периода были заливкой/пропущены`];
  }

  // «Без потерь» — одной строкой: у тихого автомата нечего разбирать, а
  // повторять ему полный заголовок значит утопить в нём те, где потери есть.
  if (m.summary.items.length === 0 && m.refillDays.length === 0) {
    return [`• ${m.name} — без потерь`];
  }

  const потери = m.summary.items
    .filter((i) => i.lossUnits > 0)
    .sort((a, b) => b.lossValue - a.lossValue || b.lossUnits - a.lossUnits);
  const излишки = m.summary.items.filter((i) => i.surplusUnits > 0);

  const части: string[] = [];
  части.push(
    `📉 ${m.name}${days > 0 ? ` за ${days} дн` : ""} ` +
      // «не в счёт из-за заливки», а не «с заливкой»: daysSkipped — сутки,
      // ИСКЛЮЧЁННЫЕ из daysCounted, а не их часть. Та же формулировка стоит на
      // листе «Усушка» — одно число не должно называться на двух экранах
      // владельца по-разному.
      `(дней посчитано ${m.summary.daysCounted}, не в счёт из-за заливки ${m.summary.daysSkipped}):`,
  );
  if (потери.length === 0) {
    части.push(" недостач нет");
  } else {
    части.push(` ${потери.slice(0, ITEMS_PER_MACHINE).map(itemText).join(" · ")}`);
    if (потери.length > ITEMS_PER_MACHINE) {
      части.push(` · …и ещё ${потери.length - ITEMS_PER_MACHINE} поз.`);
    }
    if (m.summary.lossValue > 0) части.push(` · Итого ≈ ${RU(m.summary.lossValue)} сум`);
  }
  // Излишки названы, но в сумму не входят (R-P4-3): зачесть их значит спрятать
  // недостачу за пересортицей, которой на самом деле могло не быть.
  if (излишки.length > 0) {
    части.push(` · излишки: ${излишки.map((i) => `${i.product} +${i.surplusUnits}`).join(", ")}`);
  }

  const lines = [части.join("")];
  if (m.refillDays.length > 0) {
    const дни = m.refillDays
      .slice(0, REFILL_DAYS_SHOWN)
      .map((d) => `${day(d.date)} +${d.detectedUnits} (записано ${d.recordedUnits})`);
    const хвост = m.refillDays.length > дни.length ? `, …ещё ${m.refillDays.length - дни.length}` : "";
    lines.push(`Заливки по снимкам: ${дни.join(", ")}${хвост}`);
  }
  return lines;
}

/** Отчёт об усушке сообщениями Telegram: первое — заголовок и автоматы. */
export function formatShrinkage(r: ShrinkReport): string[] {
  const days = periodDays(r.from, r.to);
  const заголовок =
    `📉 Усушка${days > 0 ? ` за ${days} дн` : ""} (${day(r.from)} — ${day(r.to)})` +
    ` · порог ${RU(r.threshold)} сум`;

  const lines: string[] = [];
  if (r.machines.length === 0) {
    // Пустой отчёт — не «всё хорошо»: чаще это значит, что снимков нет или
    // автоматы выпали из расчёта. Молчать об этом нельзя.
    lines.push("Считать не по чему — ни одного автомата в отчёте.");
  } else {
    // Автоматы по деньгам: первым читается то, где теряют больше.
    const порядок = [...r.machines].sort((a, b) => b.summary.lossValue - a.summary.lossValue);
    порядок.forEach((m, i) => {
      if (i > 0) lines.push("");
      lines.push(...machineLines(m, days));
    });
  }

  // Предупреждения — в конце и без повторов: один и тот же пропуск снимков
  // приходит по каждому автомату, и списком в три десятка одинаковых строк он
  // вытеснил бы сам отчёт.
  const видели = new Set<string>();
  const warns = r.warnings.filter((w) => {
    if (видели.has(w.message)) return false;
    видели.add(w.message);
    return true;
  });
  if (warns.length > 0) {
    lines.push("", "Посчитано не всё:");
    for (const w of warns) lines.push(`⚠️ ${w.message}`);
  }

  const parts = chunk(заголовок, lines);
  if (parts.length <= MAX_PARTS) return parts;
  // Сверх лимита отчёт не досылаем, а честно говорим, где он целиком: три
  // десятка сообщений подряд уносят из видимой части чата первое — то самое,
  // где стоят самые дорогие потери.
  const kept = parts.slice(0, MAX_PARTS - 1);
  kept.push(`…показал ${MAX_PARTS - 1} из ${parts.length} частей — остальное на листе «Усушка» в панели.`);
  return kept;
}
