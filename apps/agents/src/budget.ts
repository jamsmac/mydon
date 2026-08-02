/**
 * Денежный бюджет агентов (шаг дорожной карты #4).
 *
 * В прототипе agent-os дневной денежный потолок был; в монорепо не переносился.
 * Ставим его ДО того, как он понадобится — как и потолок действий (`limits.ts`):
 * в тот момент, когда включится метрируемый LLM (шаг #3), непокрытый ключ уже
 * не сможет тратить без предела.
 *
 * Сейчас работаем через подписку — метрируемых трат нет. Поэтому по умолчанию
 * режим `subscription`: бюджет-страховка СПИТ (spent считаем нулём, действие
 * всегда проходит). Он оживает при `AGENT_BILLING_MODE=metered` — тогда потолок
 * $5/день начинает реально гейтить.
 *
 * Решение по бюджету — чистые функции без сети: их легко проверить, а сумму
 * трат подставит вызывающий (при metered — из журнала Core, как в `limits.ts`).
 */

/** Стратегия при исчерпании бюджета (паспорт: `budget.on_exceeded`). */
export type BudgetStrategy = "pause" | "downgrade" | "ask";

/** Режим биллинга. На подписке метрируемых трат нет — бюджет спит. */
export type BillingMode = "subscription" | "metered";

export interface BudgetDecision {
  /** Можно ли выполнять платное действие (на подписке — всегда true). */
  allowed: boolean;
  /** Что делать: выполнять или применить стратегию при исчерпании. */
  action: "run" | BudgetStrategy;
  /** Учтённые траты, против которых принято решение. */
  spentUsd: number;
  /** Потолок, с которым сравнивали. */
  capUsd: number;
  /** Режим, в котором принято решение. */
  billing: BillingMode;
  /** Человеко-понятное объяснение — в лог и владельцу. */
  reason: string;
}

/** Режим биллинга из окружения. По умолчанию — подписка (метрируемых трат нет). */
export function billingMode(raw: string | undefined = process.env.AGENT_BILLING_MODE): BillingMode {
  return (raw ?? "").trim().toLowerCase() === "metered" ? "metered" : "subscription";
}

/** Неотрицательное число из окружения или запасной дефолт.
 *  Пустая строка/не задано → дефолт: `Number("")` даёт 0, а не NaN, и без этой
 *  проверки незаданный env молча превратил бы бюджет в ноль. */
function envUsd(raw: string | undefined, fallback: number): number {
  const s = (raw ?? "").trim();
  if (s === "") return fallback;
  const v = Number(s);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Безопасный дневной потолок на агента, когда в паспорте не задан `per_day_usd`.
 * Никогда не «безлимит»: по умолчанию $5 (решение владельца).
 * Переопределяется `AGENT_DAILY_BUDGET_USD`.
 */
export function defaultDailyUsd(raw: string | undefined = process.env.AGENT_DAILY_BUDGET_USD): number {
  return envUsd(raw, 5);
}

/**
 * Глобальный дневной потолок на ВСЕ агенты — общая экспозиция владельца за сутки.
 * По умолчанию $5. Переопределяется `AGENT_GLOBAL_BUDGET_USD`.
 */
export function globalDailyUsd(raw: string | undefined = process.env.AGENT_GLOBAL_BUDGET_USD): number {
  return envUsd(raw, 5);
}

/** Эффективный потолок агента: явный `per_day_usd` или безопасный дефолт. */
export function effectiveDailyCap(perDayUsd?: number, fallback: number = defaultDailyUsd()): number {
  return typeof perDayUsd === "number" && perDayUsd >= 0 ? perDayUsd : fallback;
}

/** Стратегия из паспорта. Неизвестное → `pause` (самое безопасное). */
export function asBudgetStrategy(value: unknown): BudgetStrategy {
  const raw = typeof value === "string" ? value.split("#")[0].trim().toLowerCase() : "";
  return raw === "downgrade" || raw === "ask" ? raw : "pause";
}

/**
 * Решение по бюджету перед платным действием.
 *
 * Подписка → всегда `run` (метрируемых трат нет, бюджет спит).
 * Metered → сначала ГЛОБАЛЬНЫЙ потолок (общая экспозиция владельца), затем
 * потолок агента. Исчерпан агентский — применяем стратегию (pause/downgrade/ask);
 * исчерпан глобальный — всегда pause (это жёсткий предел владельца).
 */
export function resolveBudget(input: {
  agentSpentUsd: number;
  globalSpentUsd: number;
  perDayUsd?: number;
  strategy?: BudgetStrategy;
  billing?: BillingMode;
}): BudgetDecision {
  const billing = input.billing ?? billingMode();
  const cap = effectiveDailyCap(input.perDayUsd);

  if (billing === "subscription") {
    return {
      allowed: true,
      action: "run",
      spentUsd: 0,
      capUsd: cap,
      billing,
      reason: `подписка: метрируемых трат нет, бюджет $${cap}/день — страховка на будущее`,
    };
  }

  const gcap = globalDailyUsd();
  if (input.globalSpentUsd >= gcap) {
    return {
      allowed: false,
      action: "pause",
      spentUsd: input.globalSpentUsd,
      capUsd: gcap,
      billing,
      reason: `глобальный потолок исчерпан: $${input.globalSpentUsd.toFixed(2)} из $${gcap} — стоп всем агентам`,
    };
  }

  const strategy = input.strategy ?? "pause";
  if (input.agentSpentUsd >= cap) {
    return {
      allowed: false,
      action: strategy,
      spentUsd: input.agentSpentUsd,
      capUsd: cap,
      billing,
      reason: `бюджет агента исчерпан: $${input.agentSpentUsd.toFixed(2)} из $${cap} → ${strategy}`,
    };
  }

  return {
    allowed: true,
    action: "run",
    spentUsd: input.agentSpentUsd,
    capUsd: cap,
    billing,
    reason: `в бюджете: $${input.agentSpentUsd.toFixed(2)} из $${cap}`,
  };
}

/** Строка для стартового лога: какой бюджет и режим действуют сейчас. */
export function budgetPosture(): string {
  const mode = billingMode();
  const perAgent = defaultDailyUsd();
  const global = globalDailyUsd();
  return mode === "subscription"
    ? `бюджет $${perAgent}/день на агента, глобально $${global}, режим: подписка (метрируемых трат нет — страховка спит)`
    : `бюджет $${perAgent}/день на агента, глобально $${global}, режим: metered (потолок активен)`;
}
