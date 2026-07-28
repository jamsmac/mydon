"use server";

import { answer, createLlmResolver, type LlmResolver } from "@mydon/assistant";
import { assistantCore } from "../../lib/assistant-core";

export interface AskResult {
  text: string;
  approvalId?: string;
}

const BASE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";

// LLM-слой включается только при наличии ключа. Нет ключа → помощник работает
// по правилам, непонятые вопросы получают подсказку (без сбоев).
const llm: LlmResolver | undefined = process.env.ANTHROPIC_API_KEY
  ? createLlmResolver({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(process.env.MYDON_ASSISTANT_MODEL ? { model: process.env.MYDON_ASSISTANT_MODEL } : {}),
    })
  : undefined;

/** Запоминаем вопрос как событие — это эпизодическая память помощника. */
async function remember(question: string): Promise<void> {
  try {
    await fetch(`${BASE}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "panel", type: "assistant.asked", payload: { question } }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Память не должна ронять ответ: не записалось — не беда, ответ важнее.
  }
}

export async function ask(question: string): Promise<AskResult> {
  const clean = question.trim();
  if (!clean) return { text: "Спроси что-нибудь — например «брифинг» или «что просрочено»." };

  try {
    const reply = await answer(clean, assistantCore, llm ? { llm } : {});
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
