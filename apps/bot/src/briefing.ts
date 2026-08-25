import { TZ } from "@mydon/shared";
import type { ApprovalRow, Briefing } from "./core-client";

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
 * Блок несрочных сигналов правил.
 *
 * Правила делят уведомления на срочные («звони сейчас») и брифинговые
 * («разберись утром»). Срочные бот опрашивает раз в минуту, а брифинговые не
 * забирал НИКТО: усушка за порогом и заливка без записи копились в Core и не
 * доходили до владельца ни разу. Утро — их единственный канал.
 *
 * Дедуп по тексту: одно и то же правило срабатывает по каждому автомату, и
 * тридцать одинаковых строк вытеснили бы сам брифинг. Лимит — по той же
 * причине: сводка, которую не дочитывают, не сводка.
 */
export function formatBriefingNotes(notes: readonly BriefingNote[], limit = 12): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const n of notes) {
    if (n.text.trim() === "" || seen.has(n.text)) continue;
    seen.add(n.text);
    lines.push(n.text);
  }
  if (lines.length === 0) return null;
  const shown = lines.slice(0, limit);
  if (lines.length > shown.length) shown.push(`…и ещё ${lines.length - shown.length}`);
  return ["Разобраться сегодня:", ...shown].join("\n");
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
