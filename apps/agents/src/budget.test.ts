import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  asBudgetStrategy,
  billingMode,
  budgetPosture,
  defaultDailyUsd,
  effectiveDailyCap,
  globalDailyUsd,
  resolveBudget,
} from "./budget";

/** Сохранить и восстановить env вокруг теста, чтобы прогоны не влияли друг на друга. */
const KEYS = ["AGENT_BILLING_MODE", "AGENT_DAILY_BUDGET_USD", "AGENT_GLOBAL_BUDGET_USD"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
// Каждый тест стартует с чистого окружения — дефолты не зависят от среды прогона.
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("Дефолты бюджета", () => {
  it("дневной потолок по умолчанию — $5 (решение владельца)", () => {
    assert.equal(defaultDailyUsd(undefined), 5);
    assert.equal(globalDailyUsd(undefined), 5);
  });

  it("env переопределяет, мусор и отрицательное — падают в дефолт", () => {
    assert.equal(defaultDailyUsd("2.5"), 2.5);
    assert.equal(defaultDailyUsd("много"), 5);
    assert.equal(defaultDailyUsd("-1"), 5);
    assert.equal(defaultDailyUsd("0"), 0, "явный ноль — это ноль, а не дефолт");
  });

  it("эффективный потолок: паспортный per_day_usd или дефолт", () => {
    assert.equal(effectiveDailyCap(3), 3);
    assert.equal(effectiveDailyCap(undefined), 5);
    assert.equal(effectiveDailyCap(-2), 5, "мусор в паспорте не даёт безлимит");
  });
});

describe("Режим биллинга", () => {
  it("по умолчанию — подписка", () => {
    assert.equal(billingMode(undefined), "subscription");
    assert.equal(billingMode(""), "subscription");
    assert.equal(billingMode("что-то"), "subscription");
  });
  it("metered включается явно", () => {
    assert.equal(billingMode("metered"), "metered");
    assert.equal(billingMode(" Metered "), "metered");
  });
});

describe("asBudgetStrategy — неизвестное падает в pause", () => {
  it("распознаёт валидные и режет комментарий", () => {
    assert.equal(asBudgetStrategy("pause"), "pause");
    assert.equal(asBudgetStrategy("downgrade"), "downgrade");
    assert.equal(asBudgetStrategy("ask   # комментарий"), "ask");
  });
  it("мусор и пусто → pause", () => {
    assert.equal(asBudgetStrategy("свобода"), "pause");
    assert.equal(asBudgetStrategy(undefined), "pause");
  });
});

describe("resolveBudget", () => {
  it("подписка — всегда run, бюджет спит (spent игнорируется)", () => {
    const d = resolveBudget({ agentSpentUsd: 999, globalSpentUsd: 999, perDayUsd: 3, billing: "subscription" });
    assert.equal(d.allowed, true);
    assert.equal(d.action, "run");
    assert.equal(d.spentUsd, 0);
    assert.match(d.reason, /подписка/);
  });

  it("metered в пределах потолка — run", () => {
    const d = resolveBudget({ agentSpentUsd: 1, globalSpentUsd: 1, perDayUsd: 3, billing: "metered" });
    assert.equal(d.allowed, true);
    assert.equal(d.action, "run");
  });

  it("metered: агентский потолок исчерпан — применяем стратегию агента", () => {
    const d = resolveBudget({ agentSpentUsd: 3, globalSpentUsd: 3, perDayUsd: 3, strategy: "downgrade", billing: "metered" });
    assert.equal(d.allowed, false);
    assert.equal(d.action, "downgrade");
    assert.match(d.reason, /бюджет агента исчерпан/);
  });

  it("metered: стратегия по умолчанию — pause", () => {
    const d = resolveBudget({ agentSpentUsd: 5, globalSpentUsd: 5, perDayUsd: 5, billing: "metered" });
    assert.equal(d.action, "pause");
  });

  it("metered: глобальный потолок бьёт первым и всегда pause", () => {
    process.env.AGENT_GLOBAL_BUDGET_USD = "5";
    // Агентский потолок ещё не исчерпан ($1 из $3), но общий по владельцу — да ($5 из $5).
    const d = resolveBudget({ agentSpentUsd: 1, globalSpentUsd: 5, perDayUsd: 3, strategy: "ask", billing: "metered" });
    assert.equal(d.allowed, false);
    assert.equal(d.action, "pause", "глобальный предел — жёсткий стоп, не стратегия агента");
    assert.match(d.reason, /глобальный потолок/);
  });

  it("metered без явного per_day_usd — берёт безопасный дефолт $5, не безлимит", () => {
    const d = resolveBudget({ agentSpentUsd: 5, globalSpentUsd: 5, billing: "metered" });
    assert.equal(d.allowed, false, "$5 из дефолта $5 — исчерпано");
    assert.equal(d.capUsd, 5);
  });
});

describe("budgetPosture", () => {
  it("подписка — говорит, что страховка спит", () => {
    process.env.AGENT_BILLING_MODE = "subscription";
    assert.match(budgetPosture(), /подписка.*спит/);
    assert.match(budgetPosture(), /\$5\/день/);
  });
  it("metered — говорит, что потолок активен", () => {
    process.env.AGENT_BILLING_MODE = "metered";
    assert.match(budgetPosture(), /активен/);
  });
});
