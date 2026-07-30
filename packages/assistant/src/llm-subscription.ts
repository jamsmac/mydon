/**
 * llm-subscription.ts — LLM-слой помощника от ПОДПИСКИ Claude владельца.
 *
 * Зачем: у владельца уже оплачена подписка Claude (ей пользуется Claude Code).
 * Этот путь позволяет помощнику отвечать без отдельного платного API-ключа.
 *
 * Как: официальный Claude Agent SDK — тот же механизм, что у Claude Code.
 * Вход настраивается токеном подписки (CLAUDE_CODE_OAUTH_TOKEN из команды
 * `claude setup-token`); сам токен читает SDK из окружения — мы его не трогаем.
 *
 * Отличия от API-пути (llm.ts):
 *   • структурный ответ форсируется через outputFormat json_schema (схема та же);
 *   • на каждый вопрос запускается отдельный процесс — дольше на ~3–4 секунды,
 *     поэтому модель по умолчанию средняя быстрая (sonnet), а не opus;
 *   • инструменты и настройки Claude Code полностью выключены: только вопрос,
 *     снимок и память — никакого доступа к файлам или сети.
 *
 * Расход идёт в лимиты подписки. Кончился лимит — резолвер бросает ошибку,
 * дальше либо запасной API-путь (withLlmFallback), либо подсказка.
 */

import type { LlmResolver } from "./index";
import { buildUserContent, CLASSIFY_SCHEMA, mapToResolution, SYSTEM } from "./llm";

export interface SubscriptionLlmConfig {
  /** По умолчанию claude-sonnet-5: на живой проверке отвечал за ~4 секунды и,
   *  в отличие от haiku, правильно объединял текущие цифры с памятью. Тяжёлая
   *  opus не нужна — каждый лишний десяток секунд владелец ждёт в чате. */
  model?: string;
  /** Таймаут всего запуска, мс. По умолчанию 60с: запуск процесса + модель. */
  timeoutMs?: number;
}

/**
 * Резолвер через подписку. Возвращает тот же порт (вопрос, снимок) → решение.
 * Ошибки (нет токена, кончился лимит, сеть) пробрасываются — их ловит либо
 * withLlmFallback (переключение на API-ключ), либо answer() (подсказка).
 */
export function createSubscriptionResolver(config: SubscriptionLlmConfig = {}): LlmResolver {
  const model = config.model && config.model.length > 0 ? config.model : "claude-sonnet-5";
  const timeoutMs = config.timeoutMs ?? 60_000;

  return async (question, snapshot) => {
    // Ленивый импорт настоящим ESM-import, а не через require.
    //
    // Пакет — чистый ESM. Наш код компилируется в CommonJS, и обычный
    // `await import(...)` TypeScript превращает в require() — тогда Next.js
    // не может оставить пакет внешним и предупреждает при каждой сборке
    // («Package can't be external», ревизия 2026-07-30), а сам пакет
    // затягивается в бандл вместе с нативным CLI внутри. Обёртка через
    // Function не даёт компилятору тронуть import — в рантайме это честный
    // динамический ESM-импорт.
    const esmImport = new Function("s", "return import(s)") as (
      s: string,
    ) => Promise<typeof import("@anthropic-ai/claude-agent-sdk")>;
    const { query } = await esmImport("@anthropic-ai/claude-agent-sdk");

    // Таймаут: без него зависший процесс держал бы ответ бота бесконечно.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    // Окружение подпроцесса: БЕЗ API-ключа. Проверено на живом CLI: при обоих
    // ключах он предпочитает ANTHROPIC_API_KEY — и «путь подписки» молча платил
    // бы деньгами. Убираем ключ — остаётся только вход по подписке.
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_API_KEY: undefined,
      // Не тянуть проверки обновлений при каждом вопросе — быстрее старт.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };

    try {
      const q = query({
        prompt: buildUserContent(question, snapshot),
        options: {
          systemPrompt: SYSTEM,
          model,
          maxTurns: 1,
          // Никаких инструментов и чужих настроек: помощник отвечает только по
          // снимку и памяти, файлы и сеть ему не положены.
          tools: [],
          settingSources: [],
          thinking: { type: "disabled" },
          outputFormat: { type: "json_schema", schema: CLASSIFY_SCHEMA as Record<string, unknown> },
          abortController: abort,
          // Вопросы владельца не должны оседать в расшифровках на диске сервера.
          persistSession: false,
          env: childEnv,
        },
      });

      for await (const msg of q) {
        if (msg.type === "result") {
          if (msg.subtype !== "success" || msg.is_error) {
            throw new Error(`подписка: запуск завершился с ошибкой (${msg.subtype})`);
          }
          // Успех без структурного ответа — механический сбой, а не «не понял»:
          // бросаем, чтобы сработал запасной путь (withLlmFallback), а не
          // уверенная подсказка.
          if (msg.structured_output === undefined) {
            throw new Error("подписка: успех без структурного ответа");
          }
          // Схема форсирована, но ответ модели всё равно разбираем осторожно —
          // mapToResolution отбрасывает всё непонятное в none.
          return mapToResolution(msg.structured_output);
        }
      }
      throw new Error("подписка: процесс завершился без результата");
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Порядок путей: сначала основной, при любой его ошибке — запасной.
 *
 * Типовая связка: подписка (бесплатно при оплаченном тарифе) → API-ключ.
 * Кончился лимит подписки — владелец не замечает: отвечает API-путь.
 */
export function withLlmFallback(primary: LlmResolver, backup: LlmResolver): LlmResolver {
  return async (question, snapshot) => {
    try {
      return await primary(question, snapshot);
    } catch {
      return backup(question, snapshot);
    }
  };
}
