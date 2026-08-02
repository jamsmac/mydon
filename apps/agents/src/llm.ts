import { resolveBudget, type BudgetStrategy } from "./budget";
import { resolveModelChain, type ModelGateway, type ModelResult } from "./model-gateway";
import { systemGuard, wrapUntrusted } from "./untrusted";

/**
 * Единая точка обращения агента к модели (шаг дорожной карты #3).
 *
 * Порядок — это и есть безопасность:
 *   1. БЮДЖЕТ до вызова. На подписке спит (трат нет); при metered исчерпание
 *      останавливает вызов ещё до траты (см. budget.ts).
 *   2. ЗАЩИТА ОТ ИНЪЕКЦИЙ. Внешний контент всегда оборачивается, а системный
 *      страж запрещает модели исполнять инструкции из данных.
 *   3. МАРШРУТИЗАЦИЯ С FALLBACK. Пробуем модели по цепочке; первая ответившая
 *      даёт результат. Никакой модели в цепочке — путь честно выключен.
 *
 * Стоимость берём из ответа шлюза (если он её сообщил), а не выдумываем.
 */

export interface CallModelInput {
  /** Задача для модели (доверенная часть — формулирует навык/агент). */
  prompt: string;
  /** Внешний/производный контент — будет ОБЁРНУТ как недоверенные данные. */
  untrustedContext?: string;
  /** Доп. системная инструкция навыка (кладётся после стража). */
  system?: string;
  /** Потолок токенов ответа. */
  maxTokens?: number;
  // ── Бюджет ──
  /** Дневной потолок агента из паспорта ($). Не задан → безопасный дефолт $5. */
  perDayUsd?: number;
  /** Стратегия при исчерпании (паспорт on_exceeded). */
  strategy?: BudgetStrategy;
  /** Траты агента за сутки (при metered — из журнала Core; на подписке 0). */
  agentSpentUsd?: number;
  /** Траты всех агентов за сутки (глобальный потолок). */
  globalSpentUsd?: number;
}

export interface CallModelResult {
  ok: boolean;
  text: string;
  model?: string;
  costUsd: number;
  /** Человеко-понятная причина — в лог и трейс. */
  reason: string;
}

/** Собирает финальный промпт: недоверенный контент всегда обёрнут. */
export function buildPrompt(input: Pick<CallModelInput, "prompt" | "untrustedContext">): string {
  return input.untrustedContext
    ? `${input.prompt}\n\n${wrapUntrusted(input.untrustedContext)}`
    : input.prompt;
}

export async function callModel(
  gateway: ModelGateway,
  input: CallModelInput,
  chain: string[] = resolveModelChain(),
): Promise<CallModelResult> {
  // 1. Бюджет ДО вызова.
  const budget = resolveBudget({
    agentSpentUsd: input.agentSpentUsd ?? 0,
    globalSpentUsd: input.globalSpentUsd ?? 0,
    perDayUsd: input.perDayUsd,
    strategy: input.strategy,
  });
  if (!budget.allowed) {
    return { ok: false, text: "", costUsd: 0, reason: `бюджет (${budget.action}): ${budget.reason}` };
  }

  if (chain.length === 0) {
    return { ok: false, text: "", costUsd: 0, reason: "модель не настроена (LLM_MODEL пуст) — LLM-путь выключен" };
  }

  // 2. Защита от инъекций: страж в system, недоверенный контент обёрнут.
  const system = [systemGuard(), input.system].filter(Boolean).join("\n\n");
  const prompt = buildPrompt(input);

  // 3. Маршрутизация с fallback.
  let last: ModelResult | null = null;
  for (const model of chain) {
    last = await gateway.call(model, { system, prompt, maxTokens: input.maxTokens });
    if (last.ok) {
      return { ok: true, text: last.text, model: last.model, costUsd: last.costUsd, reason: `ответ модели ${last.model}` };
    }
  }
  return {
    ok: false,
    text: "",
    ...(last?.model !== undefined ? { model: last.model } : {}),
    costUsd: last?.costUsd ?? 0,
    reason: `все модели цепочки не ответили: ${last?.error ?? "нет причины"}`,
  };
}
