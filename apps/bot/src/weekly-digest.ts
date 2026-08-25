import { isoWeekFromKey } from "@mydon/shared";
import type { WeekDelta } from "@mydon/shared";
import {
  PCT,
  ЗНАК,
  capped,
  день,
  изменениеСтрока,
  момент,
  мёртваяСтрока,
  сущ,
  товарСтрока,
} from "./analytics-brief";
import { formatBriefingNotes, type BriefingNote } from "./briefing";
import type { OurvendHealth, PendingNotifications, PersonRow, WeeklyDigest } from "./core-client";
import { RU, TG_BUDGET, chunk } from "./purchase-plan";

/**
 * Недельная сводка снек-контура: понедельник 08:05 по Ташкенту и команда
 * «итоги недели» по требованию (R-P5b-7).
 *
 * Числа считает Core (`GET /vending/weekly-digest`), текст собирается здесь:
 * в Telegram уходит не JSON, а сообщение, и решение «что показать, а что
 * свернуть» принимается там же, где известен предел сообщения.
 *
 * ЧТО ЗДЕСЬ НЕЛЬЗЯ «УПРОСТИТЬ».
 *
 * 1. Сводка приходит САМА. Владелец её не спрашивал, поэтому она обязана
 *    помещаться в три сообщения (`WEEKLY_MAX_PARTS`): двенадцать подряд в
 *    понедельник утром читаются как поломка бота, а не как отчёт.
 *
 * 2. Отмечать доставленными (`ack`) можно ТОЛЬКО напечатанные сигналы —
 *    и только если сводка не обрезана по числу частей. Отметка необратима:
 *    Core больше не отдаст сигнал никогда, и «свернули в хвост, но отметили»
 *    означает потерянное навсегда предупреждение.
 *
 * 3. Пустая неделя — не «выручка ноль». Чаще всего это стоящий сбор OurVend,
 *    поэтому раздел здоровья печатается и на пустой неделе тоже.
 */

/** Роли, которым положена недельная сводка. `admin` в MYDON нет — есть `owner`. */
export const WEEKLY_ROLES: readonly string[] = ["owner", "manager"];

/**
 * Как далеко назад смотрим за сигналами `urgency:"weekly"`.
 *
 * Две недели, а не одна: ключ доставки тратится ДО отправки (как у брифинга,
 * см. `BRIEFING_NOTES_WINDOW_MS`), и если в понедельник Telegram отказал во
 * все чаты, сигнал прошлой недели должен попасть хотя бы в следующую сводку.
 * Повтора не боимся: `/rules/pending` отсекает всё, что уже отмечено.
 */
export const WEEKLY_NOTES_WINDOW_MS = 14 * 24 * 3_600_000;

/** Потолок частей: сводка приходит сама, а не по запросу (см. правило 1 в шапке). */
const WEEKLY_MAX_PARTS = 3;
/** Сколько сигналов правил показываем — столько же, сколько в утреннем брифинге. */
const NOTES_LIMIT = 12;
/** Заголовок блока сигналов: речь о прошедшей неделе, а не о «сегодня». */
const WEEKLY_NOTES_HEADER = "Сигналы за неделю:";
/** Запас на жадную нарезку: часть закрывается, не добрав до предела длину строки. */
const CHUNK_SLACK = 200;
/** Сколько изменений цен показываем на ленту в сводке (полный список — в панели). */
const CHANGES_SHOWN = 10;
/** Сколько позиций мёртвого стока называем поимённо (R-P5b-7: топ-5 по деньгам). */
const DEAD_SHOWN = 5;

// ── Разбор фразы ────────────────────────────────────────────────────────────

/**
 * «итоги недели», «итоги недели 2026-34», «недельная сводка».
 *
 * Строго `итоги недели`, а НЕ префикс `^итоги`: «итоги», «итоги вчера» и
 * «итоги за неделю» — лента действий сотрудников (`isActionsQuery`), которую
 * справка обещает именно этими словами. Перехватив их, сводка подменила бы
 * ответ на совсем другой отчёт — молча.
 */
export function isWeeklyDigestQuery(text: string): boolean {
  return /^итоги\s+недели(\s|:|$)|^недельн/i.test(text.trim());
}

/** Разбор аргумента недели: `ok:false` — ключ есть, но такой недели не бывает. */
export type WeekArg = { ok: true; week?: string } | { ok: false };

/**
 * «итоги недели 2026-34» → ключ ISO-недели; без ключа — прошлая неделя.
 *
 * Ключ проверяется здесь, а не в Core: 53-я неделя есть не в каждом году (в
 * 2026-м есть, в 2025-м нет), и на `2025-53` Core ответил бы 400 — бот сказал
 * бы «попробуй позже», и владелец ждал бы сервер, хотя чинить надо было
 * фразу. Та же причина, что у `parseDays`.
 */
export function parseWeekArg(text: string): WeekArg {
  const m = /(\d{4})\s*-\s*(\d{1,2})(?!\d)/.exec(text.trim());
  if (!m) return { ok: true };
  const key = `${m[1]}-${m[2].padStart(2, "0")}`;
  return isoWeekFromKey(key) ? { ok: true, week: key } : { ok: false };
}

/** Подсказка, когда неделя во фразе не разобралась. */
export const WEEKLY_WEEK_HINT =
  "Неделя задаётся ключом ISO: «итоги недели 2026-34» — год и номер недели. " +
  "Без ключа покажу прошлую неделю.";

// ── Получатели и дедуп ──────────────────────────────────────────────────────

/**
 * Кому уходит сводка: роль `owner`/`manager` и привязанный Telegram.
 *
 * Решает МАССИВ `roles`, а не текстовое `role`: `role` — свободная подсказка
 * владельцу в карточке, права живут в `roles` (тот же урок, что в меню бота).
 * Считать по `role` значило бы раздать деньги парка по описке в карточке.
 *
 * Уволенные (`active != "yes"`) отсекаются здесь же: карточка остаётся в
 * реестре ради истории, но выручка в чат бывшему сотруднику уходить не должна.
 */
export function weeklyRecipients(people: readonly PersonRow[]): PersonRow[] {
  return people.filter(
    (p) =>
      p.active === "yes" &&
      (p.tgChatId ?? "").trim() !== "" &&
      (p.roles ?? []).some((r) => WEEKLY_ROLES.includes(r)),
  );
}

/**
 * Ключ идемпотентности доставки: неделя + человек (R-P5b-7).
 *
 * По ЧЕЛОВЕКУ, а не на всю рассылку: перезапуск бота в понедельник 08:05:30 не
 * должен слать вторую сводку, а сбой чата одного получателя не должен лишать
 * сводки остальных.
 */
export function weeklyDigestKey(week: string, personId: string): string {
  return `weekly-digest:${week}:${personId}`;
}

/**
 * Сигналы правил недельной срочности из `/rules/pending`.
 *
 * Общая для планировщика и команды: фильтр по `urgency` и форма ключа
 * (`<eventId>:<ruleId>`) обязаны совпадать — по этому ключу Core отмечает
 * доставку, и вторая копия правила рано или поздно отметила бы не то.
 */
export function weeklyNotes(pending: PendingNotifications | null): BriefingNote[] {
  return (pending?.notifications ?? [])
    .filter((n) => n.urgency === "weekly")
    .map((n) => ({ key: `${n.eventId}:${n.ruleId}`, text: n.text }));
}

// ── Текст ───────────────────────────────────────────────────────────────────

/** Сводка сообщениями Telegram и ключи сигналов, которые реально напечатаны. */
export interface WeeklyMessage {
  parts: string[];
  /** Ключи показанных сигналов. Пусто — отмечать доставленным нечего. */
  shownKeys: string[];
}

/**
 * Часть строки динамики: процент, а если сравнивать не с чем — абсолютный рост.
 *
 * Прошлая неделя в нуле даёт `pct === null` (см. `weekCompare`): «+100 %» там
 * было бы выдумкой, поэтому печатаем прибавку в единицах и говорим, что
 * сравнивать было не с чем.
 */
function часть(label: string, abs: number, pct: number | null, unit: string): string {
  if (pct !== null) return `${label} ${ЗНАК(pct)}`;
  if (abs === 0) return `${label} без изменений`;
  return `${label} ${abs > 0 ? "+" : "−"}${RU(Math.abs(abs))}${unit} (прошлая неделя в нуле)`;
}

/** Строка динамики к прошлой неделе. `null` — сравнивать не с чем вовсе. */
function динамика(d: WeekDelta, previousWeek: string): string | null {
  const пусто = d.qty === 0 && d.revenue === 0 && d.margin === 0;
  if (пусто && d.revenuePct === null) return null;
  return [
    `${часть("Выручка:", d.revenue, d.revenuePct, " сум")} к прошлой неделе (${previousWeek})`,
    часть("маржа", d.margin, d.marginPct, " сум"),
    часть("штуки", d.qty, d.qtyPct, " шт"),
  ].join(" · ");
}

/** Одна строка автомата недели: деньги, маржа, штуки. */
function машина(m: WeeklyDigest["machines"][number]): string {
  return `• ${m.name}: выручка ${RU(m.revenue)} · маржа ${RU(m.margin)} (${PCT(m.pct)}) · ${RU(m.qty)} шт`;
}

/** Здоровье сбора одной строкой: подробности — по команде «сверка» (R-P5b-8). */
function здоровье(h: OurvendHealth): string[] {
  const свежесть = h.slotsLagMin === null ? "снимков нет" : `${RU(h.slotsLagMin)} мин`;
  const состояние =
    h.failedStreak > 0
      ? `❌ ${RU(h.failedStreak)} ${сущ(h.failedStreak, "отказ", "отказа", "отказов")} подряд`
      : "✅ отказов подряд нет";
  return [
    "",
    `🩺 Сбор OurVend: ${состояние} · последний успех ${момент(h.lastSuccessAt)} · слоты ${свежесть}`,
    `Паритет за ${h.parity.days} дн.: ${h.parity.ok ? "✅ сходится" : `❌ расхождений ${RU(h.parity.mismatches)}`}` +
      ` · остатки ${h.parity.stockOk ? "✅" : "❌"}${h.parity.note ? ` · ${h.parity.note}` : ""}`,
  ];
}

/** Раздел изменений цен: свежие сверху, хвост назван числом, а не отброшен молча. */
function цены(title: string, rows: WeeklyDigest["priceChanges"]["purchase"], lines: string[]): void {
  if (rows.length === 0) return;
  lines.push(`${title} (${rows.length}):`);
  for (const c of rows.slice(0, CHANGES_SHOWN)) lines.push(изменениеСтрока(c));
  if (rows.length > CHANGES_SHOWN) {
    lines.push(`…и ещё ${rows.length - CHANGES_SHOWN} — весь список на листе «Цены» в панели.`);
  }
}

/** Тело сводки без сигналов правил: разделы в порядке R-P5b-7. */
function разделы(d: WeeklyDigest): string[] {
  const lines: string[] = [];
  const t = d.totals;

  // Пустая неделя — это НЕ «выручка ноль»: чаще всего стоит сбор. Нули
  // прочитались бы как посчитанный результат (R-P5b-7, §7 спеки).
  if (d.machines.length === 0 || t.revenue === 0) {
    lines.push("Считать нечего — продаж за неделю нет.");
  } else {
    lines.push(
      `Итого: выручка ${RU(t.revenue)} сум · маржа ${RU(t.margin)} (${PCT(t.pct)}) · ${RU(t.qty)} шт`,
    );
    if (t.unknownUnits > 0) {
      lines.push(`⚠️ ${RU(t.unknownUnits)} шт без себестоимости — на их выручку маржа завышена`);
    }
  }

  const δ = динамика(d.delta, d.previousWeek);
  if (δ) lines.push(δ);

  if (d.machines.length > 0) {
    lines.push("", "🎰 Автоматы:");
    for (const m of d.machines) lines.push(машина(m));
  }

  if (d.topProducts.length > 0) {
    lines.push("", `🏆 Лучшие по марже (${d.topProducts.length}):`);
    for (const p of d.topProducts) lines.push(товарСтрока(p));
  }
  if (d.worstProducts.length > 0) {
    lines.push("", `🔻 Худшие по марже (${d.worstProducts.length}):`);
    for (const p of d.worstProducts) lines.push(товарСтрока(p));
  }

  lines.push("", "📦 Работа за неделю:");
  const r = d.refills;
  if (r.events === 0) {
    lines.push("Заливок за неделю не было.");
  } else {
    // Снимки OurVend и запись мастера — два независимых источника. Разошлись
    // — говорим об этом: молчаливая разница и есть та дыра, из-за которой
    // усушка потом «появляется ниоткуда».
    const разрыв = r.detectedUnits !== r.recordedUnits ? " ⚠️ записано не всё" : "";
    lines.push(
      `Заливки: ${RU(r.events)} ${сущ(r.events, "событие", "события", "событий")}, ` +
        `${RU(r.detectedUnits)} ед по снимкам (записано ${RU(r.recordedUnits)})${разрыв}`,
    );
  }
  const i = d.intake;
  lines.push(
    i.orders === 0
      ? "Приходов за неделю не было."
      : `Приходы: ${RU(i.orders)} ${сущ(i.orders, "накладная", "накладные", "накладных")}, ` +
        `${RU(i.units)} ед на ${RU(i.amount)} сум`,
  );
  const s = d.stocktakes;
  lines.push(
    s.positions === 0
      ? "Инвентаризаций склада за неделю не было."
      : `Инвентаризации склада: ${RU(s.positions)} поз., последняя ${момент(s.lastCountedAt)}`,
  );

  if (d.deadStock.rows.length > 0) {
    lines.push("", `🪦 Мёртвый сток — всего ≈ ${RU(d.deadStock.totalValue)} сум, дороже прочих:`);
    for (const row of d.deadStock.rows.slice(0, DEAD_SHOWN)) lines.push(мёртваяСтрока(row));
    if (d.deadStock.rows.length > DEAD_SHOWN) {
      lines.push(
        `…и ещё ${RU(d.deadStock.rows.length - DEAD_SHOWN)} поз. — «мёртвый сток» покажет целиком.`,
      );
    }
  }

  const p = d.priceChanges;
  if (p.purchase.length > 0 || p.retail.length > 0) {
    lines.push("", "📈 Цены за неделю:");
    // Заголовки короче, чем в отчёте «цены»: там пояснение в скобках нужно
    // (отчёт спрашивают редко), здесь оно съедало бы строку каждую неделю.
    цены("🛒 Закупочные", p.purchase, lines);
    цены("🏷 Витринные", p.retail, lines);
  }

  lines.push(...здоровье(d.health));
  return lines;
}

/**
 * Сводка недели плюс подмешанные сигналы правил `urgency:"weekly"`.
 *
 * Сигналы идут ПОСЛЕДНИМИ и с бюджетом на остаток: если сводка всё-таки не
 * влезла в `WEEKLY_MAX_PARTS`, срезается именно их хвост — и тогда ключи не
 * возвращаются вовсе (правило 2 в шапке: отметить недоставленное = потерять
 * его навсегда).
 */
export function formatWeeklyDigest(d: WeeklyDigest, notes: readonly BriefingNote[]): WeeklyMessage {
  const title = `📅 Итоги недели ${день(d.from)} — ${день(d.to)} · снек-автоматы (OurVend)`;
  const lines = разделы(d);

  // Сколько места остаётся сигналам во ВСЕХ разрешённых частях: блок считает
  // бюджет одним числом, а сообщений у сводки несколько.
  const room = Math.max(1, TG_BUDGET - title.length - " (продолжение)".length - 2);
  const занято = lines.reduce((n, l) => n + l.length + 1, 0);
  const budget = Math.max(0, WEEKLY_MAX_PARTS * room - занято - CHUNK_SLACK);
  const block = formatBriefingNotes(notes, NOTES_LIMIT, budget, WEEKLY_NOTES_HEADER);
  if (block) lines.push("", ...block.text.split("\n"));

  const parts = chunk(title, lines);
  if (parts.length <= WEEKLY_MAX_PARTS) return { parts, shownKeys: block?.shownKeys ?? [] };
  // Не влезло: печатаем обрезанную сводку и НЕ отмечаем ни одного сигнала —
  // срезан именно их хвост, а отметка необратима.
  return { parts: capped(title, lines, "Снек", WEEKLY_MAX_PARTS), shownKeys: [] };
}
