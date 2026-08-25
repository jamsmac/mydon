import { TZ, tashkentDay } from "@mydon/shared";
import type { NotifyUrgency } from "@mydon/shared";
import type { ApprovalRow, Briefing, PendingNotifications } from "./core-client";
import { cutAt, TG_BUDGET } from "./purchase-plan";

/**
 * Утренний брифинг 07:30 Asia/Tashkent (ТЗ FR-6).
 * Порядок блоков — по тревогам владельца из фронта Ф11:
 * долги · автоматы · заявки · сроки договоров · что требует решения.
 */
/** Сводка закупа для брифинга: сколько позиций и на сколько (§5.7). */
export interface BriefingPurchase {
  positions: number;
  costRounded: number;
  /**
   * Сколько единиц закроется складом, а не покупкой (П5a). Необязательное:
   * старые вызовы (и Core до П5a) раздачу не считают, и «0» тогда врал бы про
   * пустой склад.
   */
  fromStock?: number;
}

/** Сводка кофе-бункеров для брифинга: сколько сигналов каждого рода сейчас открыто. */
export interface BriefingCoffee {
  underfill: number;
  anomaly: number;
  overdueWash: number;
}

/** Сигналы контуров GLOBERENT (финансы, договоры, склад — перенос PROMACH). */
export interface BriefingGloberent {
  /** Обязательств «нам заплатят» со сроком ≤ 7 дней. */
  dueSoonIn: number;
  /** Обязательств «мы платим» со сроком ≤ 7 дней. */
  dueSoonOut: number;
  /** Действующих договоров без единой оплаты. */
  contractsUnpaid: number;
  /** Открытых сделок без движения дольше 14 дней. */
  dealsStuck: number;
}

/** Завершённые ветки стадий продажи — застрять в них нельзя. */
const STAGES_DONE = new Set(["CLOSED", "LOST"]);

/**
 * Сделки без движения: стадия продажи открыта, а карточку не трогали
 * дольше `days` дней. Отдельной метки «когда сменилась стадия» нет —
 * честная опора на updatedAt (любая правка карточки сбрасывает счётчик).
 */
export function countStuckDeals(
  units: readonly { salesStage: string | null; updatedAt: string }[],
  now: Date,
  days = 14,
): number {
  const cutoff = now.getTime() - days * 86_400_000;
  return units.filter((u) => {
    if (u.salesStage === null || STAGES_DONE.has(u.salesStage)) return false;
    const touched = new Date(u.updatedAt).getTime();
    return Number.isFinite(touched) && touched < cutoff;
  }).length;
}

/**
 * Действующие договоры, по которым не пришло ни сума.
 *
 * Исторические карточки из выгрузки Didox (createdFrom) в счёт не идут:
 * платежей по ним в системе нет вовсе — Didox знает документы, но не деньги,
 * поэтому «без оплаты» у них не факт, а пробел в данных. Сигнал остаётся про
 * договоры, заведённые в системе, где оплату действительно ждут.
 */
export function countUnpaidContracts(
  contracts: readonly { status: string; paidUzs: number; createdFrom?: string | null }[],
): number {
  return contracts.filter(
    (c) => c.status === "active" && !(c.paidUzs > 0) && !(c.createdFrom ?? "").trim(),
  ).length;
}

/** Узкий контракт клиента Core для сбора сигналов GLOBERENT (упрощает тесты). */
export interface GloberentSignalsSource {
  globerentDueSoon(): Promise<{ dueSoonIn: unknown[]; dueSoonOut: unknown[] }>;
  globerentContracts(): Promise<{ status: string; paidUzs: number; createdFrom?: string | null }[]>;
  globerentUnits(): Promise<{ salesStage: string | null; updatedAt: string }[]>;
}

/**
 * Собрать сигналы GLOBERENT для брифинга. Каждый источник читается
 * независимо: упавшие финансы не прячут застрявшие сделки. Все три упали —
 * блока нет вовсе (undefined), а не ложное «всё по нулям».
 */
export async function collectGloberentSignals(
  src: GloberentSignalsSource,
  now: Date = new Date(),
): Promise<BriefingGloberent | undefined> {
  const [fin, contracts, units] = await Promise.all([
    src.globerentDueSoon().catch(() => null),
    src.globerentContracts().catch(() => null),
    src.globerentUnits().catch(() => null),
  ]);
  if (fin === null && contracts === null && units === null) return undefined;
  return {
    dueSoonIn: fin?.dueSoonIn.length ?? 0,
    dueSoonOut: fin?.dueSoonOut.length ?? 0,
    contractsUnpaid: contracts !== null ? countUnpaidContracts(contracts) : 0,
    dealsStuck: units !== null ? countStuckDeals(units, now) : 0,
  };
}

/** Уведомление правил, дожидающееся утра (urgency: "briefing"). */
export interface BriefingNote {
  /** Ключ доставки: `<eventId>:<ruleId>`. Отмечается ПОСЛЕ отправки. */
  key: string;
  text: string;
}

/**
 * Сигналы правил нужной срочности из `/rules/pending` — в форму блока.
 *
 * Одна функция на все каналы доставки (утро — `briefing`, понедельник —
 * `weekly`), потому что форма ключа `<eventId>:<ruleId>` обязана совпадать с
 * тем, что ждёт `POST /rules/ack`: вторая копия этой строки рано или поздно
 * отметит доставленным не то событие, а отметка необратима.
 *
 * `/rules/pending` фильтра по срочности не имеет (только `immediate=1`),
 * поэтому фильтруем на стороне бота — и каждый канал забирает ТОЛЬКО свою
 * срочность, иначе один съедал бы сигналы другого.
 */
export function pendingNotes(
  pending: PendingNotifications | null,
  urgency: NotifyUrgency,
): BriefingNote[] {
  return (pending?.notifications ?? [])
    .filter((n) => n.urgency === urgency)
    .map((n) => ({ key: `${n.eventId}:${n.ruleId}`, text: n.text }));
}

/**
 * Готовый блок сигналов и ключи ТОЛЬКО показанных строк.
 *
 * Ключи возвращаются отдельно, потому что отметка о доставке необратима:
 * отметив непоказанное, мы теряем его навсегда (Core больше его не отдаст).
 */
export interface BriefingNotesBlock {
  text: string;
  /** Ключи строк, попавших в сообщение. Остальное остаётся недоставленным. */
  shownKeys: string[];
}

/**
 * Как далеко назад смотрим за несрочными сигналами.
 *
 * Неделя, а не сутки: ключ одноразовости брифинга (`briefing:<дата>`) тратится
 * ДО отправки, и если Telegram отказал во все чаты, второй попытки в эти сутки
 * не будет. При суточном окне вчерашние алерты (крон усушки пишет их в 08:35)
 * в завтрашнюю выборку уже не попали бы — сигнал оставался бы в Core
 * недоставленным вечно. Повтора не боимся: `/rules/pending` отсекает всё, что
 * лежит в `notification_delivery`, поэтому широкое окно даёт ровно то же, что
 * узкое, плюс не потерянные сигналы.
 */
export const BRIEFING_NOTES_WINDOW_MS = 7 * 24 * 3_600_000;

/** Заголовок блока — он же занимает бюджет, поэтому считается вместе со строками. */
const NOTES_HEADER = "Разобраться сегодня:";
/** Предел одной строки: правило с длинным перечислением не должно съесть блок. */
const NOTES_LINE_MAX = 160;
/** Место под хвост «…и ещё N» — резервируем, пока остаток не показан. */
const NOTES_TAIL_ROOM = 16;
/** Два разделителя «\n\n» между брифингом, блоком и строкой действий. */
const NOTES_SEPARATORS = 4;

/**
 * Сколько символов остаётся блоку сигналов в сообщении брифинга.
 *
 * Telegram рвёт связь на 4096 символах ОДНОГО сообщения, а `sendMessage` текст
 * не режет: перевалив предел, падает всё сообщение целиком — и сводка, и
 * согласования, и сами сигналы. Держимся того же порога, что и остальные
 * длинные ответы бота (TG_BUDGET), и отдаём блоку только остаток.
 */
export function notesBudget(briefingText: string, staffLine: string | null): number {
  return Math.max(0, TG_BUDGET - briefingText.length - (staffLine?.length ?? 0) - NOTES_SEPARATORS);
}

/**
 * Длинную строку режем по символам: перенос целиком выбросил бы её из блока.
 *
 * Именно по СИМВОЛАМ (cutAt), а не по единицам UTF-16: эмодзи из имени товара,
 * попавший на границу, оставался бы половиной пары — и Telegram отвечал бы 400
 * на весь брифинг, а не на одну строку.
 */
function cutLine(text: string, max = NOTES_LINE_MAX): string {
  return text.length <= max ? text : `${cutAt(text, max - 1).trimEnd()}…`;
}

/**
 * Блок несрочных сигналов правил.
 *
 * Правила делят уведомления на срочные («звони сейчас») и брифинговые
 * («разберись утром»). Срочные бот опрашивает раз в минуту, а брифинговые не
 * забирал НИКТО: усушка за порогом и заливка без записи копились в Core и не
 * доходили до владельца ни разу. Утро — их единственный канал.
 *
 * Дедуп по тексту: одно и то же правило срабатывает по каждому автомату, и
 * тридцать одинаковых строк вытеснили бы сам брифинг. Склеенные события всё
 * равно считаются показанными — их содержимое на экране; не отметь мы их, они
 * возвращались бы каждое утро и склеивались снова, вечно.
 *
 * Лимит строк и бюджет длины — разные ограничения: первый бережёт внимание
 * владельца, второй не даёт сообщению превысить предел Telegram. Всё, что не
 * влезло, сворачивается в «…и ещё N» и остаётся НЕДОСТАВЛЕННЫМ.
 *
 * `header` — единственное, чем отличается недельный блок (`urgency:"weekly"`,
 * R-P5b-7): «разобраться сегодня» в понедельничной сводке за прошлую неделю
 * звучит про сегодня, а речь о прошедшей неделе. Своей копии функции ради
 * одной строки заголовка не заводим: разъехавшись, копии разъедутся не по
 * заголовку, а по бюджету и по тому, какие ключи считаются показанными, —
 * а цена ошибки здесь необратима (см. `notesToAck`).
 */
export function formatBriefingNotes(
  notes: readonly BriefingNote[],
  limit = 12,
  budget = Number.POSITIVE_INFINITY,
  header = NOTES_HEADER,
): BriefingNotesBlock | null {
  const поТексту = new Map<string, { line: string; keys: string[] }>();
  for (const n of notes) {
    const text = n.text.trim();
    if (text === "") continue;
    const прежний = поТексту.get(text);
    if (прежний) {
      прежний.keys.push(n.key);
      continue;
    }
    поТексту.set(text, { line: cutLine(text), keys: [n.key] });
  }
  const все = [...поТексту.values()];
  if (все.length === 0) return null;

  const lines: string[] = [];
  const shownKeys: string[] = [];
  let занято = header.length;
  let i = 0;
  for (; i < все.length && lines.length < limit; i++) {
    const надо = все[i].line.length + 1;
    // Пока остаётся непоказанное, держим место под хвост: иначе последняя
    // строка вытеснила бы «…и ещё N» за границу бюджета.
    const резерв = i + 1 < все.length ? NOTES_TAIL_ROOM : 0;
    if (занято + надо + резерв > budget) break;
    lines.push(все[i].line);
    shownKeys.push(...все[i].keys);
    занято += надо;
  }
  // Ни одной строки не влезло — блока нет вовсе: пустой заголовок занял бы
  // место и при этом ничего не сказал, а ключи остались бы неотмеченными.
  if (lines.length === 0) return null;

  const остаток = все.length - i;
  const out = [header, ...lines];
  if (остаток > 0) out.push(`…и ещё ${остаток}`);
  return { text: out.join("\n"), shownKeys };
}

/**
 * Какие ключи отмечать доставленными.
 *
 * Ровно показанные и ровно при доставке хотя бы в один чат. Отдельной функцией,
 * потому что это решение с необратимой ценой: `ack` — единственное место, после
 * которого Core сигнал больше не отдаст.
 */
export function notesToAck(block: BriefingNotesBlock | null, delivered: boolean): string[] {
  return delivered && block ? block.shownKeys : [];
}

export function formatBriefing(
  b: Briefing,
  approvals: ApprovalRow[] = [],
  purchase?: BriefingPurchase,
  coffee?: BriefingCoffee,
  globerent?: BriefingGloberent,
): string {
  const when = new Date(b.generatedAt).toLocaleString("ru-RU", {
    timeZone: TZ,
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines: string[] = [`☀️ Утренний брифинг — ${when}`, ""];

  const rows: [string, number, string][] = [
    ["Просрочено платежей", b.overdueMoney, "💸"],
    ["Автоматы простаивают", b.idleMachines, "☕"],
    ["Договоры на исходе", b.contractsDueSoon, "📄"],
    ["Ждут твоего решения", b.pendingApprovals, "✋"],
  ];

  const alarms = rows.filter(([, n]) => n > 0);
  if (alarms.length === 0) {
    lines.push("Тревог нет: просрочек, простоев и незакрытых согласований не найдено.");
  } else {
    for (const [label, n, icon] of alarms) {
      lines.push(`${icon} ${label}: ${n}`);
    }
  }

  const calm = rows.filter(([, n]) => n === 0).map(([label]) => label);
  if (alarms.length > 0 && calm.length > 0) {
    lines.push("", `Спокойно: ${calm.join(", ").toLowerCase()}.`);
  }

  if (purchase && purchase.positions > 0) {
    const sum = Math.round(purchase.costRounded).toLocaleString("ru-RU");
    const tail = purchase.costRounded > 0 ? ` на ~${sum} сум` : "";
    const stock = purchase.fromStock ? ` · со склада ${purchase.fromStock}` : "";
    lines.push("", `🛒 К закупу: ${purchase.positions} поз.${tail}${stock} — «оформить закуп».`);
  }

  if (coffee && (coffee.underfill > 0 || coffee.anomaly > 0 || coffee.overdueWash > 0)) {
    const parts: string[] = [];
    if (coffee.underfill > 0) parts.push(`недолив ${coffee.underfill}`);
    if (coffee.anomaly > 0) parts.push(`расхождение ${coffee.anomaly}`);
    if (coffee.overdueWash > 0) parts.push(`мойка просрочена ${coffee.overdueWash}`);
    // Срез F снял мёртвую вкладку «Сверка» (она строилась на двух пустых
    // таблицах и всегда показывала «неизвестно»). Брифинг уходит владельцу
    // каждое утро в 07:30 — адрес в нём обязан существовать, иначе указание
    // «посмотри там» превращается в тупик.
    lines.push("", `☕ Кофе-бункеры: ${parts.join(", ")} — вкладка «Норма и факт».`);
  }

  if (
    globerent &&
    (globerent.dueSoonIn > 0 ||
      globerent.dueSoonOut > 0 ||
      globerent.contractsUnpaid > 0 ||
      globerent.dealsStuck > 0)
  ) {
    const parts: string[] = [];
    if (globerent.dueSoonIn > 0) parts.push(`получить в ≤7 дней: ${globerent.dueSoonIn}`);
    if (globerent.dueSoonOut > 0) parts.push(`заплатить в ≤7 дней: ${globerent.dueSoonOut}`);
    if (globerent.contractsUnpaid > 0)
      parts.push(`договоры без оплаты: ${globerent.contractsUnpaid}`);
    if (globerent.dealsStuck > 0)
      parts.push(`сделки без движения >14 дней: ${globerent.dealsStuck}`);
    lines.push("", `🏗 GLOBERENT: ${parts.join(", ")} — вкладки «Финансы» и «Склад».`);
  }

  if (approvals.length > 0) {
    lines.push("", "Требует решения сегодня:");
    for (const a of approvals.slice(0, 5)) {
      lines.push(`• ${a.action} — ${a.agent} (${a.tier})`);
    }
    if (approvals.length > 5) lines.push(`…и ещё ${approvals.length - 5}`);
  }

  return lines.join("\n");
}

/** Карточка согласования с кнопками (ТЗ FR-3). */
export function formatApproval(a: ApprovalRow): string {
  // Карточка от полевого сотрудника — человеческий текст, а не «Агент: staff:<uuid>».
  const p = (a.payload ?? {}) as { entityApprove?: unknown; name?: string; type?: string; byName?: string | null };
  if (p.entityApprove) {
    return [
      "🆕 Новая карточка от сотрудника",
      "",
      `${p.name ?? a.action} (${p.type ?? "?"})`,
      ...(p.byName ? [`Завёл: ${p.byName}`] : []),
      "",
      "Утвердить? Отклонённая останется черновиком в панели.",
    ].join("\n");
  }
  return ["✋ Требуется решение", "", a.action, "", `Агент: ${a.agent}`, `Уровень: ${a.tier}`].join(
    "\n",
  );
}

export function approvalKeyboard(id: string) {
  // Три ряда, а не один: решение необратимо пишется одним нажатием, и
  // «Одобрить» с «Отклонить» вплотную в ряду из трёх — это промах пальцем
  // ценой в исполненное действие агента (стандарт проекта из coffee-fix:
  // противоположные действия — разные ряды). «Уточнить» — буфером между ними.
  return {
    inline_keyboard: [
      [{ text: "✅ Одобрить", callback_data: `ap:approved:${id}` }],
      [{ text: "❓ Уточнить", callback_data: `ap:clarify:${id}` }],
      [{ text: "❌ Отклонить", callback_data: `ap:rejected:${id}` }],
    ],
  };
}

/**
 * Сколько миллисекунд до ближайших 07:30 по Ташкенту.
 * Считаем через смещение пояса, чтобы не зависеть от TZ машины.
 */
export function msUntilBriefing(now: Date = new Date(), hour = 7, minute = 30): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const nowSec = get("hour") * 3600 + get("minute") * 60 + get("second");
  const targetSec = hour * 3600 + minute * 60;
  const deltaSec = targetSec > nowSec ? targetSec - nowSec : 24 * 3600 - nowSec + targetSec;
  return deltaSec * 1000;
}

/**
 * Сколько миллисекунд до ближайшего `weekday` (1 = понедельник) `hour:minute`
 * по Ташкенту — расписание недельной сводки (R-P5b-7).
 *
 * Считается ПОВЕРХ `msUntilBriefing`, а не вторым разбором времени: время
 * суток у обоих планировщиков одно и то же, и вторая копия арифметики зоны
 * разъехалась бы с первой ровно в тот день, когда это заметно (донор VendCash
 * уехал так на пять часов). Здесь добавляются только сутки до нужного дня
 * недели: в Ташкенте нет перехода на летнее время, поэтому сутки ровно
 * 24 часа и целые дни складываются без поправок.
 *
 * День недели берём из ташкентских суток момента срабатывания (а не «сегодня»
 * процесса): в 23:30 воскресенья по Ташкенту ближайшие 08:05 — уже
 * понедельник, и ждать неделю было бы ошибкой на семь суток.
 */
export function msUntilWeekly(now: Date = new Date(), weekday = 1, hour = 8, minute = 5): number {
  const ms = msUntilBriefing(now, hour, minute);
  // Сутки срабатывания по Ташкенту → номер дня недели по ISO (Пн = 1, Вс = 7).
  const day = tashkentDay(new Date(now.getTime() + ms));
  const iso = ((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7) + 1;
  const ahead = (((weekday - iso) % 7) + 7) % 7;
  return ms + ahead * 86_400_000;
}
