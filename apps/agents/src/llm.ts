import {
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  inputTokenCeiling,
  type LlmLedger,
  type LlmReservation,
} from "@mydon/shared";
import {
  resolveModelChain,
  type ModelGateway,
  type ModelReasoningEffort,
  type ModelRequest,
  type ModelResult,
} from "./model-gateway";
import type { TaskLlmSession } from "./task-llm-session";
import { systemGuard, wrapUntrusted } from "./untrusted";

/**
 * Единая точка обращения агента к модели.
 *
 * Для metered HTTP бюджет авторизует только Core ledger. Процесс агентов
 * не читает и не суммирует траты сам: перед КАЖДОЙ физической
 * fallback-попыткой он берёт атомарный reserve, после — settle/fail.
 * Явно local HTTP денежный ledger не уменьшает. Subscription CLI
 * заблокирована, пока не умеет доказать отключённый overage до model turn.
 */

export const DEFAULT_MAX_TOKENS = 2_048;

export interface CallModelInput {
  /** Задача для модели (доверенная часть — формулирует навык/агент). */
  prompt: string;
  /** Внешний/производный контент — будет ОБЁРНУТ как недоверенные данные. */
  untrustedContext?: string;
  /** Доп. системная инструкция навыка (кладётся после стража). */
  system?: string;
  /** Потолок токенов ответа; незаданный/битый берёт безопасный default. */
  maxTokens?: number;
  /** Явный reasoning budget для поддерживаемого провайдером model route. */
  reasoningEffort?: ModelReasoningEffort;
  /** Карточка агента даёт Core его индивидуальный cap/strategy. */
  agentName: string;
  /** Навык/функция для финансового следа. */
  feature: string;
  /** Идемпотентная основа вызова; callModel добавит attempt:N. */
  requestKey: string;
  /** Объединяет попытки одной задачи. */
  traceKey?: string;
  /** Durable task lease: проверяется перед КАЖДОЙ fallback-попыткой. */
  assertLease?: () => Promise<void>;
  /** Нужен только metered-шлюзу; его отсутствие закрывает вызов. */
  ledger?: LlmLedger;
  /** Task-mode stores provider grant/result in Core instead of legacy reserve. */
  taskLlm?: TaskLlmSession;
}

export interface CallModelResult {
  ok: boolean;
  text: string;
  model?: string;
  /** Provider-reported cost; отсутствие не означает нуль. */
  costUsd?: number;
  /** Ответ не маскируем, если он уже оплачен, а settle Core не ответил. */
  ledgerWarning?: string;
  /** Человеко-понятная причина — в лог и трейс. */
  reason: string;
}

/** Собирает финальный промпт: недоверенный контент всегда обёрнут. */
export function buildPrompt(input: Pick<CallModelInput, "prompt" | "untrustedContext">): string {
  return input.untrustedContext
    ? `${input.prompt}\n\n${wrapUntrusted(input.untrustedContext)}`
    : input.prompt;
}

function outputCeiling(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_TOKENS;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Provider уже получил запрос: сбой settle не может отменить трату и не
 * должен спрятать полезный ответ. Резерв остаётся exposure и fail-closed
 * защищает следующий reserve; в результат кладём явное warning.
 */
async function accountProviderResult(
  ledger: LlmLedger,
  reservation: LlmReservation,
  result: ModelResult,
  requestedModel: string,
): Promise<string | undefined> {
  try {
    if (!result.ok) {
      await ledger.fail(reservation.id, {
        outcome: "unknown",
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.costUsd !== undefined ? { providerReportedUsd: result.costUsd } : {}),
        reason: result.error ?? `provider error (${requestedModel})`,
      });
      return undefined;
    }

    // Report any successful physical response as success, without inventing
    // fields. Core owns anomaly classification, lower-bound pricing and circuit.
    await ledger.settle(reservation.id, {
      outcome: "success",
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
      ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
      ...(result.costUsd !== undefined ? { providerReportedUsd: result.costUsd } : {}),
    });
    if (!result.resolvedModel) {
      return "provider не сообщил resolvedModel; Core открыл circuit";
    }
    return !result.usage && result.costUsd === undefined
      ? "provider не сообщил usage/cost; Core сохранил резерв"
      : undefined;
  } catch (error) {
    return `LLM-ledger не подтвердил итог: ${message(error)}`;
  }
}

export async function callModel(
  gateway: ModelGateway,
  input: CallModelInput,
  chain: string[] = resolveModelChain(),
): Promise<CallModelResult> {
  // Защита от инъекций: страж в system, недоверенный контент обёрнут.
  const system = [systemGuard(), input.system].filter(Boolean).join("\n\n");
  const prompt = buildPrompt(input);
  const maxTokens = outputCeiling(input.maxTokens);
  const request: ModelRequest = {
    system,
    prompt,
    maxTokens,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  };
  const metered = gateway.billingMode === "metered";
  const effectiveChain = input.taskLlm
    ? input.taskLlm.modelsForChat(input.feature, gateway, chain)
    : chain;
  if (effectiveChain.length === 0) {
    return {
      ok: false,
      text: "",
      reason: "модель не настроена (LLM_MODEL пуст) — LLM-путь выключен",
    };
  }
  if (metered && input.ledger === undefined && input.taskLlm === undefined) {
    throw new LlmLedgerUnavailableError("Metered LLM не получил клиент Core ledger");
  }

  let last: ModelResult | null = null;
  let lastLedgerWarning: string | undefined;
  for (let i = 0; i < effectiveChain.length; i += 1) {
    const model = effectiveChain[i];
    // Не разрешаем stale worker ни reserve, ни прямой local/subscription dispatch.
    await input.assertLease?.();
    if (metered) {
      if (input.taskLlm) {
        last = await input.taskLlm.callChat(
          gateway,
          input.feature,
          model,
          i + 1,
          request,
          inputTokenCeiling(`${system}\n\n${prompt}`),
          maxTokens,
        );
        lastLedgerWarning = last.ok
          ? !last.resolvedModel
            ? "provider не сообщил resolvedModel; Core открыл circuit"
            : !last.usage && last.costUsd === undefined
              ? "provider не сообщил usage/cost; Core сохранил резерв"
              : undefined
          : undefined;
      } else {
        // input.ledger проверен выше; локальная константа убирает optional из типа.
        const ledger = input.ledger!;
        const reservation = await ledger.reserve({
          consumer: "agents",
          feature: input.feature,
          agentName: input.agentName,
          provider: gateway.provider,
          model,
          requestKey: `${input.requestKey}:attempt:${i + 1}`,
          traceKey: input.traceKey ?? input.requestKey,
          inputTokenCeiling: inputTokenCeiling(`${system}\n\n${prompt}`),
          outputTokenCeiling: maxTokens,
          metadata: { attempt: i + 1, chainLength: effectiveChain.length },
        });

        // Core вернул существующую резервацию для того же requestKey. Без
        // idempotency key на provider API нельзя понять, был ли запрос уже
        // отправлен предыдущим процессом, поэтому повторный dispatch запрещён.
        if (reservation.replay) {
          throw new LlmReplayBlockedError(
            reservation.requestKey,
            `LLM-ledger вернул replay для ${reservation.requestKey}; повторный provider call запрещён`,
          );
        }

        try {
          last = await gateway.call(model, request);
        } catch (error) {
          last = { text: "", model, ok: false, error: message(error) };
        }
        lastLedgerWarning = await accountProviderResult(ledger, reservation, last, model);
      }
    } else {
      try {
        last = await gateway.call(model, request);
      } catch (error) {
        last = { text: "", model, ok: false, error: message(error) };
      }
    }

    if (last.ok) {
      return {
        ok: true,
        text: last.text,
        model: last.resolvedModel ?? last.model,
        ...(last.costUsd !== undefined ? { costUsd: last.costUsd } : {}),
        ...(lastLedgerWarning ? { ledgerWarning: lastLedgerWarning } : {}),
        reason: `ответ модели ${last.resolvedModel ?? last.model}`,
      };
    }
  }
  return {
    ok: false,
    text: "",
    ...(last?.model !== undefined ? { model: last.model } : {}),
    ...(last?.costUsd !== undefined ? { costUsd: last.costUsd } : {}),
    ...(lastLedgerWarning ? { ledgerWarning: lastLedgerWarning } : {}),
    reason: `все модели цепочки не ответили: ${last?.error ?? "нет причины"}`,
  };
}
