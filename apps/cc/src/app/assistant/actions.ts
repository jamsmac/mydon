"use server";

import {
  answer,
  createContextSearch,
  createLlmResolver,
  createSubscriptionResolver,
  llmLedgerErrorText,
  withLlmFallback,
  type LlmResolver,
} from "@mydon/assistant";
import { DurableLlmLedger, FileLlmSettlementOutbox } from "@mydon/llm-ledger-outbox";
import { CoreLlmLedgerClient, type LlmCallContext } from "@mydon/shared";
import { assistantCore } from "../../lib/assistant-core";
import { coreWriteHeaders } from "../../lib/core";

export interface AskResult {
  text: string;
  approvalId?: string;
}

const BASE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
const anthropicApiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
const llmLedger = anthropicApiKey
  ? new DurableLlmLedger(
      new CoreLlmLedgerClient({
        baseUrl: BASE,
        serviceToken: process.env.SERVICE_TOKEN ?? "",
      }),
      new FileLlmSettlementOutbox({
        rootDir: (process.env.LLM_LEDGER_OUTBOX_ROOT ?? "").trim(),
        producer: "cc",
      }),
    )
  : undefined;

// LLM-слой. Два пути входа, включаются тем, что задано в окружении:
//   • подписка Claude владельца (CLAUDE_CODE_OAUTH_TOKEN) — без платного ключа;
//   • API-ключ (ANTHROPIC_API_KEY).
// Заданы оба — сначала подписка, при её сбое (кончился лимит) отвечает API.
// Не задано ничего → помощник работает по правилам, непонятое — подсказка.
const modelOverride = process.env.MYDON_ASSISTANT_MODEL
  ? { model: process.env.MYDON_ASSISTANT_MODEL }
  : {};
const apiLlm: LlmResolver | undefined = anthropicApiKey && llmLedger
  ? createLlmResolver({
      apiKey: anthropicApiKey,
      ledger: llmLedger,
      consumer: "cc",
      feature: "assistant",
      ...modelOverride,
    })
  : undefined;
const subLlm: LlmResolver | undefined = process.env.CLAUDE_CODE_OAUTH_TOKEN
  ? createSubscriptionResolver(modelOverride)
  : undefined;
const llm: LlmResolver | undefined =
  subLlm && apiLlm ? withLlmFallback(subLlm, apiLlm) : (subLlm ?? apiLlm);

// Память помощника: перед ответом ищем в заметках и прошлых разговорах через Core.
// Оба источника необязательны — не нашлось, ответ будет прежним.
const context = createContextSearch({ baseUrl: BASE });

/** Запоминаем вопрос как событие — это эпизодическая память помощника. */
async function remember(question: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/events`, {
      method: "POST",
      headers: coreWriteHeaders(),
      body: JSON.stringify({ source: "panel", type: "assistant.asked", payload: { question } }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    // Ответ важнее памяти, поэтому отказ не бросаем — но и не глотаем молча:
    // без этой строки протухший SERVICE_TOKEN выключил бы эпизодическую память
    // насовсем, и снаружи это выглядело бы как «помощник просто не помнит».
    if (!res.ok) console.warn(`Память помощника: Core ответил ${res.status} на POST /events`);
  } catch {
    // Память не должна ронять ответ: не записалось — не беда, ответ важнее.
  }
}

export async function ask(question: string, requestId: string): Promise<AskResult> {
  const clean = question.trim();
  if (!clean) return { text: "Спроси что-нибудь — например «брифинг» или «что просрочено»." };
  const cleanRequestId = requestId.trim();
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(cleanRequestId)) {
    return {
      text: "Не удалось безопасно идентифицировать платный ИИ-запрос. Обнови страницу и попробуй ещё раз.",
    };
  }
  const requestKey = `cc:request:${cleanRequestId}`;
  const llmContext: LlmCallContext = { requestKey, traceKey: requestKey };

  try {
    const reply = await answer(clean, assistantCore, llm ? { llm, context, llmContext } : {});
    void remember(clean);
    return reply.approvalId
      ? { text: reply.text, approvalId: reply.approvalId }
      : { text: reply.text };
  } catch (err) {
    const ledgerText = llmLedgerErrorText(err);
    if (ledgerText !== null) return { text: ledgerText };
    return {
      text:
        "Не удалось получить данные из MYDON Core. " +
        (err instanceof Error ? err.message : "Попробуй ещё раз чуть позже."),
    };
  }
}
