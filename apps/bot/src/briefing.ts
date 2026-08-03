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
}

/** Сводка кофе-бункеров для брифинга: сколько сигналов каждого рода сейчас открыто. */
export interface BriefingCoffee {
  underfill: number;
  anomaly: number;
  overdueWash: number;
}

export function formatBriefing(
  b: Briefing,
  approvals: ApprovalRow[] = [],
  purchase?: BriefingPurchase,
  coffee?: BriefingCoffee,
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
    lines.push("", `🛒 К закупу: ${purchase.positions} поз.${tail} — «оформить закуп».`);
  }

  if (coffee && (coffee.underfill > 0 || coffee.anomaly > 0 || coffee.overdueWash > 0)) {
    const parts: string[] = [];
    if (coffee.underfill > 0) parts.push(`недолив ${coffee.underfill}`);
    if (coffee.anomaly > 0) parts.push(`расхождение ${coffee.anomaly}`);
    if (coffee.overdueWash > 0) parts.push(`мойка просрочена ${coffee.overdueWash}`);
    lines.push("", `☕ Кофе-бункеры: ${parts.join(", ")} — вкладка «Сверка».`);
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
  return [
    "✋ Требуется решение",
    "",
    a.action,
    "",
    `Агент: ${a.agent}`,
    `Уровень: ${a.tier}`,
  ].join("\n");
}

export function approvalKeyboard(id: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Одобрить", callback_data: `ap:approved:${id}` },
        { text: "❌ Отклонить", callback_data: `ap:rejected:${id}` },
        { text: "❓ Уточнить", callback_data: `ap:clarify:${id}` },
      ],
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
