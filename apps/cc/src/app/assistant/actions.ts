"use server";

import {
  answer,
  createContextSearch,
  createLlmResolver,
  createSubscriptionResolver,
  withLlmFallback,
  type LlmResolver,
} from "@mydon/assistant";
import { assistantCore } from "../../lib/assistant-core";
import { coreWriteHeaders } from "../../lib/core";

export interface AskResult {
  text: string;
  approvalId?: string;
}

const BASE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";

// LLM-слой. Два пути входа, включаются тем, что задано в окружении:
//   • подписка Claude владельца (CLAUDE_CODE_OAUTH_TOKEN) — без платного ключа;
//   • API-ключ (ANTHROPIC_API_KEY).
// Заданы оба — сначала подписка, при её сбое (кончился лимит) отвечает API.
// Не задано ничего → помощник работает по правилам, непонятое — подсказка.
const modelOverride = process.env.MYDON_ASSISTANT_MODEL
  ? { model: process.env.MYDON_ASSISTANT_MODEL }
  : {};
const apiLlm: LlmResolver | undefined = process.env.ANTHROPIC_API_KEY
  ? createLlmResolver({ apiKey: process.env.ANTHROPIC_API_KEY, ...modelOverride })
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

export async function ask(question: string): Promise<AskResult> {
  const clean = question.trim();
  if (!clean) return { text: "Спроси что-нибудь — например «брифинг» или «что просрочено»." };

  try {
    const reply = await answer(clean, assistantCore, llm ? { llm, context } : {});
    void remember(clean);
    return reply.approvalId ? { text: reply.text, approvalId: reply.approvalId } : { text: reply.text };
  } catch (err) {
    return {
      text:
        "Не удалось получить данные из MYDON Core. " +
        (err instanceof Error ? err.message : "Попробуй ещё раз чуть позже."),
    };
  }
}
