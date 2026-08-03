import type { NotifyUrgency } from "@mydon/shared";

/**
 * Правила уведомлений (ТЗ FR-2): событие → правило → сообщение.
 *
 * Срочность расставлена по ответам владельца во фронте Ф11:
 * все четыре его тревоги (долги, простой автоматов, новые заявки,
 * сроки договоров) доставляются НЕМЕДЛЕННО, остальное — в брифинге
 * или в недельном обзоре.
 */

export interface RuleContext {
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface Notification {
  ruleId: string;
  urgency: NotifyUrgency;
  text: string;
}

export interface Rule {
  id: string;
  /** Тип события, на который срабатывает правило. */
  eventType: string;
  urgency: NotifyUrgency;
  /** Дополнительное условие. Если не задано — правило срабатывает на любой такой тип. */
  when?: (ctx: RuleContext) => boolean;
  format: (ctx: RuleContext) => string;
}

const str = (v: unknown, fallback = "—"): string =>
  v === undefined || v === null || v === "" ? fallback : String(v);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Сумма в человеческом виде: 1 234 567 UZS.
 * Разделитель приводим к обычному пробелу: ru-RU по умолчанию вставляет
 * неразрывный (U+00A0), который не виден глазом, но ломает поиск и сравнение.
 */
export function formatAmount(value: unknown, currency = "UZS"): string {
  const n = num(value);
  return `${n.toLocaleString("ru-RU").replace(/\u00A0/g, " ")} ${currency}`;
}

export const RULES: Rule[] = [
  // ── Тревога 1: деньги ──
  {
    id: "money.overdue",
    eventType: "money.overdue",
    urgency: "immediate",
    format: (c) =>
      `💸 Просрочен платёж: ${str(c.payload.counterparty)} — ${formatAmount(c.payload.amount)}` +
      (c.payload.daysOverdue ? `, ${num(c.payload.daysOverdue)} дн. просрочки` : ""),
  },
  {
    id: "money.due_soon",
    eventType: "money.due",
    urgency: "briefing",
    when: (c) => num(c.payload.daysLeft) <= 7,
    format: (c) =>
      `📅 Платёж через ${num(c.payload.daysLeft)} дн.: ${str(c.payload.counterparty)} — ${formatAmount(c.payload.amount)}`,
  },
  {
    id: "money.received",
    eventType: "money.received",
    urgency: "briefing",
    format: (c) => `✅ Поступила оплата: ${str(c.payload.counterparty)} — ${formatAmount(c.payload.amount)}`,
  },

  // ── Тревога 2: автоматы ──
  {
    id: "machine.idle",
    eventType: "machine.idle",
    urgency: "immediate",
    when: (c) => num(c.payload.hours) >= 6,
    format: (c) =>
      `☕ Автомат ${str(c.payload.machine)} без продаж ${num(c.payload.hours)} ч.` +
      (c.payload.location ? ` (${str(c.payload.location)})` : ""),
  },
  {
    id: "machine.offline",
    eventType: "machine.offline",
    urgency: "immediate",
    format: (c) => `📴 Автомат ${str(c.payload.machine)} не на связи`,
  },
  {
    id: "machine.low_stock",
    eventType: "machine.low_stock",
    urgency: "briefing",
    format: (c) =>
      `📦 Заканчивается ${str(c.payload.product)} в автомате ${str(c.payload.machine)}` +
      (c.payload.left !== undefined ? ` (осталось ${num(c.payload.left)})` : ""),
  },

  // ── Тревога 3: заявки и клиенты ──
  {
    id: "lead.new",
    eventType: "lead.new",
    urgency: "immediate",
    format: (c) =>
      `🔔 Новая заявка: ${str(c.payload.name)}` +
      (c.payload.channel ? ` (${str(c.payload.channel)})` : ""),
  },
  {
    id: "call.missed",
    eventType: "call.missed",
    urgency: "immediate",
    format: (c) => `📞 Пропущенный звонок: ${str(c.payload.from)}`,
  },

  // ── Тревога 4: сроки договоров и юридическое ──
  {
    id: "contract.expiring",
    eventType: "contract.expiring",
    urgency: "immediate",
    when: (c) => num(c.payload.daysLeft) <= 30,
    format: (c) =>
      `📄 Договор «${str(c.payload.name)}» истекает через ${num(c.payload.daysLeft)} дн.`,
  },
  {
    id: "contract.expired",
    eventType: "contract.expired",
    urgency: "immediate",
    format: (c) => `⛔ Договор «${str(c.payload.name)}» истёк`,
  },
  {
    id: "legal.deadline",
    eventType: "legal.deadline",
    urgency: "immediate",
    format: (c) =>
      `⚖️ Юридический срок: ${str(c.payload.matter)} — ${str(c.payload.dueDate)}`,
  },

  // ── Работа системы ──
  {
    id: "approval.requested",
    eventType: "approval.requested",
    urgency: "immediate",
    format: (c) => `✋ Требует решения: ${str(c.payload.action)} (${str(c.payload.tier)})`,
  },
  {
    id: "agent.failed",
    eventType: "agent.failed",
    urgency: "briefing",
    format: (c) => `⚠️ Агент ${str(c.payload.agent)} не отработал: ${str(c.payload.reason)}`,
  },
  {
    id: "watchdog.down",
    eventType: "watchdog.down",
    urgency: "immediate",
    format: (c) => `🚨 Недоступен ${str(c.payload.target, "сервер")}`,
  },

  // ── Аналитика ──
  {
    id: "fx.changed",
    eventType: "fx.changed",
    urgency: "briefing",
    when: (c) => Math.abs(num(c.payload.changePercent)) >= 1,
    format: (c) =>
      `💱 Курс ${str(c.payload.currency)}: ${str(c.payload.rate)} (${num(c.payload.changePercent) > 0 ? "+" : ""}${num(c.payload.changePercent)}%)`,
  },
  {
    id: "sales.drop",
    eventType: "sales.drop",
    urgency: "weekly",
    format: (c) => `📉 Продажи ниже плана на ${num(c.payload.percent)}%`,
  },

  // ── Инфраструктура ──
  // Сторожа на сервере (диск, здоровье сервисов, бэкапы) сейчас шлют в Telegram
  // каждый сам, своим кодом и своим форматом. Эти правила позволяют им слать
  // событие в MYDON, а решение «срочно или в брифинг» принимается здесь,
  // в одном месте, и попадает в журнал.
  {
    id: "infra.disk",
    eventType: "infra.disk",
    urgency: "immediate",
    when: (c) => num(c.payload.usedPercent) >= 85,
    format: (c) =>
      `🚨 Диск ${str(c.payload.host, "сервера")} заполнен на ${num(c.payload.usedPercent)}%. ` +
      `Скоро остановятся записи и бэкапы.`,
  },
  {
    id: "infra.disk.watch",
    // Тот же тип события, но спокойный диапазон — в утренний брифинг, а не будить.
    eventType: "infra.disk",
    urgency: "briefing",
    when: (c) => {
      const used = num(c.payload.usedPercent);
      return used >= 70 && used < 85;
    },
    format: (c) => `💽 Диск заполнен на ${num(c.payload.usedPercent)}% — стоит присмотреть.`,
  },
  {
    id: "infra.service_down",
    eventType: "infra.service_down",
    urgency: "immediate",
    format: (c) =>
      `🔴 Не отвечает: ${str(c.payload.service)}. ${str(c.payload.detail, "Причина не указана.")}`,
  },
  {
    // Восстановление сообщаем немедленно: получив тревогу, владелец ждёт отбоя.
    // Без него приходится лезть на сервер и проверять руками — а это ровно то,
    // от чего система должна избавлять.
    id: "infra.service_up",
    eventType: "infra.service_up",
    urgency: "immediate",
    format: (c) =>
      `🟢 Снова отвечает: ${str(c.payload.service)}` +
      (num(c.payload.downChecks) > 0
        ? ` (был недоступен ${num(c.payload.downChecks)} проверок)`
        : ""),
  },
  {
    id: "infra.backup_failed",
    eventType: "infra.backup_failed",
    urgency: "immediate",
    format: (c) =>
      `❌ Бэкап не сделан: ${str(c.payload.what, "база")}. ${str(c.payload.detail, "")}`.trim(),
  },
  {
    id: "infra.backup_ok",
    eventType: "infra.backup_ok",
    urgency: "briefing",
    format: (c) => `🗄 Бэкап готов: ${str(c.payload.what, "база")} (${str(c.payload.size, "—")})`,
  },
  {
    // Дамп больше лимита Bot API (50 МБ): бэкап сделан, но offsite-копии НЕТ.
    // Это не «успех с оговоркой», а дыра в защите — говорим немедленно.
    id: "infra.backup_oversize",
    eventType: "infra.backup_oversize",
    urgency: "immediate",
    format: (c) =>
      `⚠️ Бэкап ${str(c.payload.what, "базы")} (${str(c.payload.size)}) больше лимита Telegram — ` +
      `внешней копии нет, файл только на сервере. Пора настроить Storage Box.`,
  },
  {
    id: "task.overdue",
    eventType: "task.overdue",
    urgency: "immediate",
    format: (c) => `⏰ Просрочена задача: ${str(c.payload.title)}`,
  },

  // ── Кофе-бункеры: проактивный мониторинг (порт monitor-stock донора) ──
  // Как и infra.disk: одно и то же событие, два правила по порогу — тяжёлый
  // случай будит немедленно, обычный ждёт до брифинга.
  {
    id: "coffee.underfill.critical",
    eventType: "coffee.underfill",
    urgency: "immediate",
    when: (c) => num(c.payload.fillRatio) < 0.3,
    format: (c) =>
      `☕🔴 Бункер почти пуст: ${str(c.payload.location)}, бункер ${str(c.payload.position)} ` +
      `(${str(c.payload.ingredient)}) — ${num(c.payload.netFillWeight)} г из ${num(c.payload.targetFillWeight)} г эталона.`,
  },
  {
    id: "coffee.underfill.watch",
    eventType: "coffee.underfill",
    urgency: "briefing",
    when: (c) => num(c.payload.fillRatio) >= 0.3,
    format: (c) =>
      `☕🟡 Недолив: ${str(c.payload.location)}, бункер ${str(c.payload.position)} ` +
      `(${str(c.payload.ingredient)}) — ${num(c.payload.netFillWeight)} г из ${num(c.payload.targetFillWeight)} г эталона.`,
  },
  {
    id: "coffee.anomaly.critical",
    eventType: "coffee.anomaly",
    urgency: "immediate",
    when: (c) => Math.abs(num(c.payload.deltaRatio)) >= 0.5,
    format: (c) =>
      `☕🔴 Сильное расхождение расхода: ${str(c.payload.location)} — ${str(c.payload.ingredient)}, ` +
      `факт ${num(c.payload.actualGrams)} г против ожидания ${num(c.payload.expectedGrams)} г.`,
  },
  {
    id: "coffee.anomaly.watch",
    eventType: "coffee.anomaly",
    urgency: "briefing",
    when: (c) => Math.abs(num(c.payload.deltaRatio)) < 0.5,
    format: (c) =>
      `☕🟡 Расхождение расхода: ${str(c.payload.location)} — ${str(c.payload.ingredient)}, ` +
      `факт ${num(c.payload.actualGrams)} г против ожидания ${num(c.payload.expectedGrams)} г.`,
  },
];

/** Подбирает уведомления под событие. Одно событие может дать несколько. */
export function applyRules(ctx: RuleContext, rules: Rule[] = RULES): Notification[] {
  const out: Notification[] = [];
  for (const rule of rules) {
    if (rule.eventType !== ctx.type) continue;
    try {
      if (rule.when && !rule.when(ctx)) continue;
      out.push({ ruleId: rule.id, urgency: rule.urgency, text: rule.format(ctx) });
    } catch {
      // Битое правило не должно ронять доставку остальных уведомлений.
      out.push({
        ruleId: rule.id,
        urgency: rule.urgency,
        text: `⚠️ Событие ${ctx.type} получено, но правило ${rule.id} не смогло его оформить`,
      });
    }
  }
  return out;
}

/** Только то, что владелец просил доставлять немедленно. */
export function immediateOnly(notifications: Notification[]): Notification[] {
  return notifications.filter((n) => n.urgency === "immediate");
}
