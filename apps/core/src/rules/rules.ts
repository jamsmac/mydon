import { tashkentInstant, TZ, type NotifyUrgency } from "@mydon/shared";

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

/**
 * Час и минута события по Ташкенту. В брифинге важно «когда сегодня», а не
 * полная дата: UTC из payload владелец читал бы со сдвигом на пять часов и
 * решил бы, что заливка была ночью.
 */
function времяТашкента(value: unknown): string {
  // Разбор — общим `tashkentInstant`, а не `Date.parse`: строка БЕЗ зоны
  // («2026-08-24 09:00:00») читается часами ПРОЦЕССА, и в контейнере с TZ=UTC
  // брифинг уехал бы на пять часов. Донор VendCash на этом уже погорел.
  const at = tashkentInstant(String(value));
  if (!at) return "—";
  return at.toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

/**
 * Счётная форма русского существительного: «3 раза», «12 раз», «21 раз».
 * Без неё правило печатало бы «3 раз подряд» — мелочь, которую владелец читает
 * каждый раз, когда что-то сломалось.
 */
function счёт(n: number, один: string, два: string, много: string): string {
  const десятки = Math.abs(Math.trunc(n)) % 100;
  const единицы = десятки % 10;
  if (десятки > 10 && десятки < 20) return много;
  if (единицы === 1) return один;
  if (единицы >= 2 && единицы <= 4) return два;
  return много;
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
    // Автодеплой шлёт это событие при сбое (deploy/auto-deploy.sh). Без
    // правила ingest молча клал событие в таблицу, notify считал алерт
    // доставленным, и владелец не узнавал, что прод застрял на старом коде.
    id: "infra.deploy_failed",
    eventType: "infra.deploy_failed",
    urgency: "immediate",
    format: (c) =>
      `❌ Автодеплой упал на ${str(c.payload.commit, "?")}. ${str(c.payload.detail, "")}`.trim(),
  },
  {
    // Отбой после сбоя: владелец, получивший «упал», ждёт «восстановился».
    id: "infra.deploy_ok",
    eventType: "infra.deploy_ok",
    urgency: "immediate",
    format: (c) => `✅ Автодеплой восстановился: ${str(c.payload.commit, "?")} задеплоен.`,
  },
  {
    // Гейт П2 поглощения: ежедневный вердикт сверки собственного снапшота
    // OurVend со stock-дорожкой. 7 зелёных подряд = можно переключать источник.
    id: "ourvend.parity",
    eventType: "ourvend.parity",
    urgency: "briefing",
    format: (c) =>
      c.payload.ok === true
        ? `✅ Паритет OurVend: сходится (пар ${str(c.payload.сверено_пар, "?")})`
        : `⚠️ Паритет OurVend: расхождений ${str(c.payload.расхождений, "?")} из ${str(c.payload.сверено_пар, "?")} пар — переключать источник рано`,
  },
  {
    // Мусорные числа в снапшоте не вливаются нулём — но и молчать о них нельзя.
    id: "ourvend.snapshot_quarantine",
    eventType: "ourvend.snapshot_quarantine",
    urgency: "immediate",
    format: (c) =>
      `⚠️ Снапшот OurVend: ${str(c.payload.count, "?")} строк с нечисловыми значениями отложено в карантин`,
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

  // ── Снек-автоматы: полевой контур (П4) ────────────────────────────────────
  {
    // Усушка за порогом (`SHRINK_ALERT_UZS`, по позиции за период). В брифинг,
    // не немедленно: недостача за неделю — повод разобраться утром, а не
    // ночью, и дедуп в `ShrinkageService` даёт её один раз в сутки.
    id: "vending.shrinkage_alert",
    eventType: "vending.shrinkage_alert",
    urgency: "briefing",
    format: (c) =>
      `📉 Усушка ${str(c.payload.name)}: ${str(c.payload.product)} −${num(c.payload.lossUnits)} шт ` +
      `≈ ${formatAmount(c.payload.lossValue, "сум")} за ${num(c.payload.days)} дн.`,
  },
  {
    // Детектор увидел приход, а оператор его не записал. Это НЕ тревога о
    // воровстве: факт заливки мы всё равно знаем из снимков. Это напоминание
    // оформить её в боте — иначе склад не спишется и разойдётся с автоматом.
    id: "vending.refill_detected",
    eventType: "vending.refill_detected",
    urgency: "briefing",
    when: (c) => c.payload.recorded === false,
    format: (c) =>
      `🍫 Заливка без записи: ${str(c.payload.name)} +${num(c.payload.units)} шт ${времяТашкента(c.payload.windowTo)} — ` +
      `оформи в боте «Заполнил автомат»`,
  },

  // ── Снек-автоматы: аналитика и здоровье сбора (П5b) ───────────────────────
  {
    // Сбор падает молча: на 25.08 двенадцать отказов подряд с 24.08 не заметил
    // никто — слоты писались, продажи нет. Немедленно, а не в брифинге:
    // каждый пропущенный день — дыра в деньгах, которую потом не восстановить.
    // Порог (≥3) и дедуп (раз в ташкентские сутки) стоят у эмитента, в
    // `finishSyncRun`: правило не знает истории и решать «часто ли» не может.
    id: "ourvend.sync_failed_streak",
    eventType: "ourvend.sync_failed_streak",
    urgency: "immediate",
    format: (c) =>
      `🛑 Сбор OurVend падает ${num(c.payload.streak)} ` +
      `${счёт(num(c.payload.streak), "раз", "раза", "раз")} подряд с ${времяТашкента(c.payload.since)}: ` +
      `${str(c.payload.lastError)} — продажи и остатки за эти сутки не приедут`,
  },

  // ── Обслуживание оборудования ─────────────────────────────────────────────
  //
  // Правила адресуются владельцу — контракт Notification не менялся.
  // Сотрудник узнаёт о работе через ЗАДАЧУ, а не через уведомление: у
  // Notification нет получателя, доставка идёт по allowlist владельца.
  {
    // Технический осмотр — регуляторная обязанность, а не «помыть попозже».
    // Просрочка тут стоит дороже остальных, поэтому отдельное немедленное
    // правило с первого дня, а не с третьего.
    id: "maintenance.inspection.overdue",
    eventType: "maintenance.overdue",
    urgency: "immediate",
    when: (c) =>
      (c.payload.kind === "inspection" || c.payload.kind === "calibration") &&
      num(c.payload.daysOverdue) >= 1,
    format: (c) =>
      `📋🔴 Просрочен ${str(c.payload.kindLabel).toLowerCase()}: ${str(c.payload.targetName)} — ` +
      `срок был ${str(c.payload.dueDate)} (${num(c.payload.daysOverdue)} дн. назад).`,
  },
  {
    id: "maintenance.overdue.hard",
    eventType: "maintenance.overdue",
    urgency: "immediate",
    when: (c) =>
      c.payload.kind !== "inspection" &&
      c.payload.kind !== "calibration" &&
      num(c.payload.daysOverdue) >= 7,
    format: (c) =>
      `🔧🔴 Неделю не сделано: ${str(c.payload.kindLabel)} — ${str(c.payload.targetName)}` +
      `${c.payload.partLabel ? ` (${str(c.payload.partLabel)})` : ""}, срок был ${str(c.payload.dueDate)}.`,
  },
  {
    id: "maintenance.overdue.watch",
    eventType: "maintenance.overdue",
    urgency: "briefing",
    when: (c) =>
      c.payload.kind !== "inspection" &&
      c.payload.kind !== "calibration" &&
      num(c.payload.daysOverdue) < 7,
    format: (c) =>
      `🔧🟡 Просрочено ${num(c.payload.daysOverdue)} дн.: ${str(c.payload.kindLabel)} — ` +
      `${str(c.payload.targetName)}.`,
  },
  {
    // Свободная задача со сроком сегодня, которую никто не взял. Проблема
    // не в отсутствии исполнителя при создании — это норма при общем пуле.
    id: "maintenance.unclaimed",
    eventType: "maintenance.unclaimed",
    urgency: "briefing",
    format: (c) =>
      `🙋 Никто не взял: ${str(c.payload.kindLabel)} — ${str(c.payload.targetName)}, ` +
      `срок сегодня (${str(c.payload.dueDate)}).`,
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
