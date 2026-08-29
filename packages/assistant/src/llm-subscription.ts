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

import {
  assertClaudeSubscriptionAccount,
  assertClaudeSubscriptionInit,
  assertClaudeSubscriptionOverageDisabled,
  isLlmLedgerBlockingError,
  requireClaudeSubscriptionEnv,
} from "@mydon/shared";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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

export interface GatedSubscriptionPrompt {
  prompt: AsyncIterable<SDKUserMessage>;
  allow(): void;
  deny(error: unknown): void;
}

/**
 * The SDK needs one input to finish initialization. A synthetic `shouldQuery:
 * false` message starts it without an assistant turn; the real prompt remains
 * behind the accountInfo gate.
 */
export function createGatedSubscriptionPrompt(content: string): GatedSubscriptionPrompt {
  let allow!: () => void;
  let deny!: (error: unknown) => void;
  let decided = false;
  const gate = new Promise<void>((resolve, reject) => {
    allow = resolve;
    deny = reject;
  });
  // query() может бросить ещё до того, как SDK запросит второй элемент
  // генератора. Обработчик предотвращает unhandled rejection; сам await gate
  // ниже всё равно получает исходную ошибку и не выпускает реальный prompt.
  void gate.catch(() => undefined);
  return {
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        message: { role: "user", content: "subscription auth preflight" },
        parent_tool_use_id: null,
        isSynthetic: true,
        shouldQuery: false,
      };
      await gate;
      yield {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        shouldQuery: true,
      };
    })(),
    allow: () => {
      if (decided) return;
      decided = true;
      allow();
    },
    deny: (error: unknown) => {
      if (decided) return;
      decided = true;
      deny(error);
    },
  };
}

/**
 * Резолвер через подписку. Возвращает тот же порт (вопрос, снимок) → решение.
 * Ошибки (нет токена, кончился лимит, сеть) пробрасываются — их ловит либо
 * withLlmFallback (переключение на API-ключ), либо answer() (подсказка).
 */
export function createSubscriptionResolver(config: SubscriptionLlmConfig = {}): LlmResolver {
  const model = config.model && config.model.length > 0 ? config.model : "claude-sonnet-5";
  const timeoutMs = config.timeoutMs ?? 60_000;
  // Validate before importing/querying the SDK. Persisted ~/.claude auth is not
  // evidence of subscription mode: it may contain paid API/cloud credentials.
  const childEnv: Record<string, string | undefined> = {
    ...requireClaudeSubscriptionEnv(process.env),
    // Не тянуть проверки обновлений при каждом вопросе — быстрее старт.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Не даём команде из prompt включить usage credits. Само
    // состояние overage дополнительно проверяем через usage control API.
    DISABLE_EXTRA_USAGE_COMMAND: "1",
  };

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
    const gatedPrompt = createGatedSubscriptionPrompt(buildUserContent(question, snapshot));

    // Таймаут: без него зависший процесс держал бы ответ бота бесконечно.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    let q: Query | undefined;
    try {
      q = query({
        prompt: gatedPrompt.prompt,
        options: {
          systemPrompt: SYSTEM,
          model,
          maxTurns: 1,
          // Никаких инструментов и чужих настроек: помощник отвечает только по
          // снимку и памяти, файлы и сеть ему не положены.
          tools: [],
          settingSources: [],
          // Вход через AsyncIterable должен быть обычным model prompt,
          // а не локальной slash-командой, способной менять billing.
          extraArgs: { "disable-slash-commands": null },
          thinking: { type: "disabled" },
          outputFormat: { type: "json_schema", schema: CLASSIFY_SCHEMA as Record<string, unknown> },
          abortController: abort,
          // Вопросы владельца не должны оседать в расшифровках на диске сервера.
          persistSession: false,
          env: childEnv,
        },
      });

      // Bootstrap has shouldQuery=false, so initialization and accountInfo can
      // complete without a model turn. Read init from this exact iterator.
      const iterator = q[Symbol.asyncIterator]();
      const [account, first, usage] = await Promise.all([
        q.accountInfo(),
        iterator.next(),
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      ]);
      assertClaudeSubscriptionAccount(account);
      if (first.done) throw new Error("Claude SDK завершился до system/init");
      assertClaudeSubscriptionInit(first.value);
      // Anthropic usage credits are pay-as-you-go at API rates. The real
      // prompt stays behind the gate unless the server explicitly reports
      // that this account has overage disabled. Missing/changed API shape is
      // intentionally fail-closed.
      assertClaudeSubscriptionOverageDisabled(usage);
      gatedPrompt.allow();

      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const msg = next.value;
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
    } catch (error) {
      gatedPrompt.deny(error);
      throw error;
    } finally {
      abort.abort();
      q?.close();
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
  return async (question, snapshot, context) => {
    try {
      return await primary(question, snapshot, context);
    } catch (error) {
      // Денежный отказ — терминальный: платный backup не имеет права
      // обойти исчерпанный бюджет или недоступный fail-closed ledger.
      if (isLlmLedgerBlockingError(error)) throw error;
      return backup(question, snapshot, context);
    }
  };
}
