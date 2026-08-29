/**
 * Стратегия карточки агента при денежном отказе.
 *
 * Само решение о деньгах здесь намеренно отсутствует: reserve, глобальная
 * экспозиция и per-agent cap атомарно считаются единым LLM-ledger в Core.
 */

/** Стратегия при исчерпании бюджета (паспорт: `budget.on_exceeded`). */
export type BudgetStrategy = "pause" | "downgrade" | "ask";

/** Стратегия из паспорта. Неизвестное → `pause` (самое безопасное). */
export function asBudgetStrategy(value: unknown): BudgetStrategy {
  const raw = typeof value === "string" ? value.split("#")[0].trim().toLowerCase() : "";
  return raw === "downgrade" || raw === "ask" ? raw : "pause";
}
