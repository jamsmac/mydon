/**
 * llm.ts — LLM-слой помощника (FR-4): понимание вопросов вне готовых правил.
 *
 * Перенесено из прототипа mydon_1 (правило проекта: готовое переносить, не
 * переписывать):
 *   • обёртка Anthropic SDK          — src/lib/agents/anthropic.ts
 *   • классификатор через tool_use   — src/lib/orchestrator/planner.ts + catalog.ts
 *   • системный промпт-диспетчер      — agents/registrar/ROLE.md + skills/dispatch.md
 * Адаптировано под порт LlmResolver и 7 намерений MYDON.
 *
 * Ключевой приём: модель не отвечает свободным текстом, а ВЫЗЫВАЕТ инструмент
 * classify_question с enum-действием. Мы читаем структурный `input`, а не парсим
 * прозу — предсказуемо и без «фантазий». Ответ словами разрешён только по снимку.
 *
 * SDK грузится ленивым динамическим импортом: сам пакет @mydon/assistant
 * импортируется без сети, а Anthropic подтягивается лишь при первом вопросе.
 */

// import type — стирается на сборке: типы есть, рантайм-импорта нет (SDK ленив).
import type Anthropic from "@anthropic-ai/sdk";
import type { Message, Tool, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import {
  DOMAINS,
  inputTokenCeiling,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  type Domain,
  type LlmCallContext,
  type LlmLedger,
  type LlmLedgerConsumer,
  type LlmTokenUsage,
} from "@mydon/shared";
import type { LlmResolution, LlmResolver, LlmSnapshot } from "./index";

type LlmAnthropicClient = Pick<Anthropic, "messages">;

export interface LlmConfig {
  apiKey: string;
  /** Единый денежный ledger. Платный API без него не вызывается. */
  ledger: LlmLedger;
  /** Кто создаёт трату: bot, cc и т. д. */
  consumer: LlmLedgerConsumer;
  /** Стабильное имя сценария в ledger. */
  feature: string;
  /** По умолчанию claude-opus-5. */
  model?: string;
  /** Потолок токенов на ответ (не расход — только ограничение). */
  maxTokens?: number;
  /** Таймаут запроса, мс. По умолчанию 20с — чтобы сетевой сбой не подвешивал
   *  панель/бота (у SDK по умолчанию ~10 минут). */
  timeoutMs?: number;
  /** Тестовый seam: production всегда использует ленивый SDK-клиент. */
  clientFactory?: () => Promise<LlmAnthropicClient>;
}

/** Действия, которые может выбрать модель: 7 намерений + «ответить»/«не понял». */
const ACTIONS = [
  "briefing",
  "approvals",
  "overdue",
  "machines",
  "obligations",
  "search",
  "recent",
  "answer",
  "none",
] as const;

/** Схема решения. Общая для обоих путей: API (инструмент) и подписка (json_schema). */
export const CLASSIFY_SCHEMA: Tool["input_schema"] = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description:
        "briefing — сводка/как дела/что нового; approvals — очередь на решение владельца; " +
        "overdue — просроченные платежи и долги (без привязки к направлению); " +
        "machines — простаивающие кофе-автоматы; obligations — обязательства по направлению (заполни domain); " +
        "search — найти запись по имени (заполни query); recent — память, «что было / что я делал»; " +
        "answer — короткий фактический ответ ТОЛЬКО по снимку системы; none — не понял или данных нет.",
    },
    domain: {
      type: "string",
      enum: [...DOMAINS],
      description: "Направление для obligations/search, если оно ясно из вопроса.",
    },
    query: {
      type: "string",
      description: "Для action=search — что искать: имя контрагента, автомата или фрагмент.",
    },
    answer: {
      type: "string",
      description:
        "Для action=answer — короткий ответ по-русски, опираясь ТОЛЬКО на факты из снимка " +
        "и на прошлые разговоры/знания, если они приложены. " +
        "Нет ни фактов, ни выдержек — не пиши сюда, ставь action=none.",
    },
  },
  required: ["action"],
};

const CLASSIFY_TOOL = {
  name: "classify_question",
  description:
    "Понять вопрос владельца MYDON и выбрать РОВНО ОДНО действие. " +
    "Никогда не придумывай данные. Всегда вызывай этот инструмент, не отвечай прозой.",
  input_schema: CLASSIFY_SCHEMA,
} satisfies Tool;

/** Системный промпт-диспетчер. Общий для API-пути и пути подписки. */
export const SYSTEM = [
  "Ты — секретарь-диспетчер владельца MYDON. Владелец пишет по-русски, он не программист.",
  "Твоя задача: понять суть вопроса и выбрать одно действие инструментом classify_question.",
  "",
  "Принципы:",
  "• Пойми намерение, не переспрашивай. Отвечать словами (action=answer) можно ТОЛЬКО по фактам из снимка.",
  "• Ничего не выдумывай. Если подходящего действия нет или данных нет — action=none.",
  "• Снимок — только ключевые метрики, не вся система. НЕ заверяй, что «всё в порядке».",
  "  Если «договоров без распознанной даты» больше 0 — часть данных не распознана, скажи это, а не «всё хорошо».",
  "  Про полноту/«всё ли ок» лучше action=briefing (сводка), чем обещание, что проблем нет.",
  "• «Как дела / что нового / что по делам» → briefing. «Что было / что я делал» → recent.",
  "",
  "Прошлые разговоры и знания (если приложены):",
  "• Это ПАМЯТЬ, а не текущие показатели. Владелец мог уже решить вопрос — не предлагай решённое заново.",
  "• Опираться можно: «мы договорились…», «в прошлый раз решили…». Ссылайся на источник словами.",
  "• Цифры из памяти могли устареть. Текущие цифры бери только из снимка.",
  "• Выдержки не отвечают на вопрос — это не повод выдумывать: action=none.",
  "• Долги и просрочки без направления → overdue; по конкретному направлению → obligations с domain.",
  "• Поиск записи по названию → search с query.",
  "",
  "Направления MYDON: globerent (погрузчики HELI), vendhub (кофе-автоматы), personal (личное).",
].join("\n");

/** exported для тестов: как факты снимка ложатся в запрос модели. */
export function buildUserContent(question: string, s: LlmSnapshot): string {
  const facts = [
    `- просрочено платежей: ${s.briefing.overdueMoney}`,
    `- автоматы простаивают: ${s.briefing.idleMachines}`,
    `- договоры на исходе: ${s.briefing.contractsDueSoon}`,
    `- договоров без распознанной даты (данные требуют проверки): ${s.briefing.contractsBadDate ?? 0}`,
    `- просроченных задач: ${s.briefing.overdueTasks ?? 0}`,
    `- ждут решения: ${s.pendingApprovals}`,
    `- последнее в системе: ${s.recentLabels.length > 0 ? s.recentLabels.join("; ") : "—"}`,
    ...(s.coffee
      ? [
          `- расход кофе-ингредиентов за 30 дней (по возвратам наборов): ${s.coffee.totalGrams} г` +
            (s.coffee.totalCost !== null
              ? `, себестоимость ${Math.round(s.coffee.totalCost)} сум`
              : ", цены не заведены") +
            (s.coffee.topLocation !== null ? `, больше всего — ${s.coffee.topLocation}` : ""),
        ]
      : []),
  ].join("\n");

  // Выдержки из истории и заметок. Нумеруем и подписываем источник: модель должна
  // говорить «в разговоре про X мы решили…», а не выдавать память за текущие данные.
  // Ограничиваем 6 штуками — контекст не резиновый, а качество падает от шума.
  const hits = (s.context ?? []).slice(0, 6);
  const memory =
    hits.length === 0
      ? []
      : [
          ``,
          `Прошлые разговоры и знания по этому вопросу (память, НЕ текущие показатели):`,
          ...hits.map((h, i) => `${i + 1}. [${h.kind} · ${h.where}] ${h.text}`),
        ];

  return [
    `Вопрос владельца:`,
    `"${question}"`,
    ``,
    `Снимок системы (текущие цифры):`,
    facts,
    ...memory,
    ``,
    `Направления: ${s.domains}.`,
  ].join("\n");
}

function isDomain(x: unknown): x is Domain {
  return typeof x === "string" && (DOMAINS as readonly string[]).includes(x);
}

/** Структурный ввод инструмента → решение для answer(). Всё лишнее отбрасываем.
 * exported для тестов: это самое рисковое место — разбор ответа модели. */
export function mapToResolution(input: unknown): LlmResolution {
  const o = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const action = typeof o.action === "string" ? o.action : "none";
  const domain = isDomain(o.domain) ? o.domain : undefined;
  const query = typeof o.query === "string" ? o.query.trim() : "";
  const ans = typeof o.answer === "string" ? o.answer.trim() : "";

  switch (action) {
    case "briefing":
      return { kind: "intent", intent: { kind: "briefing" } };
    case "approvals":
      return { kind: "intent", intent: { kind: "approvals" } };
    case "overdue":
      return { kind: "intent", intent: { kind: "overdue" } };
    case "machines":
      return { kind: "intent", intent: { kind: "machines" } };
    case "recent":
      return { kind: "intent", intent: { kind: "recent" } };
    case "obligations":
      // Без домена нельзя честно ответить: ремап на «просрочки» отвечал бы на
      // ДРУГОЙ вопрос (общий долг вместо обязательств направления). Лучше подсказка.
      return domain
        ? { kind: "intent", intent: { kind: "obligations", domain } }
        : { kind: "none" };
    case "search":
      return query.length >= 2
        ? { kind: "intent", intent: { kind: "search", query, ...(domain ? { domain } : {}) } }
        : { kind: "none" };
    case "answer":
      return ans.length > 0 ? { kind: "answer", text: ans } : { kind: "none" };
    default:
      return { kind: "none" };
  }
}

/**
 * Резолвер на Claude API. Возвращает функцию-порт (вопрос, снимок) → решение.
 * Ошибки (нет ключа, сеть, лимит) пробрасываются — answer() ловит и даёт подсказку.
 */
export function createLlmResolver(config: LlmConfig): LlmResolver {
  const model = config.model && config.model.length > 0 ? config.model : "claude-opus-5";
  // thinking выключен → нужен лишь маленький JSON-вызов инструмента, 512 хватает.
  const maxTokens = config.maxTokens ?? 512;
  const timeout = config.timeoutMs ?? 20_000;

  // Клиент и SDK создаются один раз, лениво — при первом вопросе.
  // timeout даёт быстрый отказ; SDK-retry выключен, чтобы один
  // reservation соответствовал ровно одной физической попытке провайдера.
  let clientPromise: Promise<LlmAnthropicClient> | null = null;
  function client(): Promise<LlmAnthropicClient> {
    if (clientPromise === null) {
      clientPromise = config.clientFactory
        ? config.clientFactory()
        : import("@anthropic-ai/sdk").then(
            // Скрытый retry нельзя отдельно зарезервировать и учесть.
            (m) => new m.default({ apiKey: config.apiKey, timeout, maxRetries: 0 }),
          );
    }
    return clientPromise;
  }

  return async (question, snapshot, context) => {
    const attempt = paidAttempt(context, "anthropic-api");
    const userContent = buildUserContent(question, snapshot);
    const reservation = await config.ledger.reserve({
      ...attempt,
      consumer: config.consumer,
      feature: config.feature,
      provider: "anthropic",
      model,
      inputTokenCeiling: inputTokenCeiling(
        [SYSTEM, userContent, JSON.stringify(CLASSIFY_SCHEMA)].join("\n"),
      ),
      outputTokenCeiling: maxTokens,
    });

    // Core возвращает replay для уже существующего requestKey. Результат
    // провайдера ledger не хранит, поэтому повторный Anthropic-вызов
    // списал бы деньги второй раз под одной резервацией.
    if (reservation.replay) {
      throw new LlmReplayBlockedError(
        reservation.requestKey,
        "Этот платный LLM-запрос уже был принят; повторный вызов заблокирован",
      );
    }

    let c: LlmAnthropicClient;
    try {
      c = await client();
    } catch (error) {
      // SDK ещё не получил запрос: это единственная ветка, где reservation
      // можно честно освободить. Сбой release не маскирует исходную ошибку —
      // незакрытая строка всё равно останется консервативным exposure.
      await config.ledger
        .release(reservation.id, "anthropic_client_init_failed_before_send")
        .catch(() => undefined);
      throw error;
    }

    let resp: Message;
    try {
      resp = await c.messages.create({
        model,
        max_tokens: maxTokens,
        // Маршрутизации размышление не нужно, а форс tool_choice ГАРАНТИРУЕТ вызов
        // инструмента: модель не уйдёт в прозу (иначе понятный вопрос терялся бы в
        // none→подсказку). На Opus 5 форс совместим только с выключенным thinking —
        // это же снимает риск, что adaptive-размышление съест бюджет max_tokens.
        thinking: { type: "disabled" },
        tool_choice: { type: "tool", name: "classify_question" },
        system: SYSTEM,
        messages: [{ role: "user", content: userContent }],
        tools: [CLASSIFY_TOOL as Tool],
      });
    } catch (error) {
      // После reserve нельзя доказать, успел ли провайдер принять запрос.
      // Резерв остаётся exposure, а не освобождается как будто траты не было.
      await config.ledger.fail(reservation.id, {
        outcome: "unknown",
        reason: errorMessage(error),
      });
      throw error;
    }

    // Деньги уже потрачены: фиксируем usage ДО любого разбора content.
    try {
      await config.ledger.settle(reservation.id, {
        outcome: "success",
        providerRequestId: resp.id,
        resolvedModel: String(resp.model),
        usage: anthropicUsage(resp.usage),
      });
    } catch (error) {
      // Ответ уже оплачен: сбой учёта не должен выбросить полезный результат.
      // Незакрытый reservation останется полной exposure и fail-closed
      // защитит следующий вызов; оператор увидит причину в логе.
      console.warn("LLM-ledger не подтвердил оплаченный ответ Assistant:", errorMessage(error));
    }

    // Как в planner.ts: ищем блок вызова нашего инструмента и читаем его input.
    const toolCall = resp.content.find(
      (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "classify_question",
    );
    if (toolCall === undefined) return { kind: "none" };
    return mapToResolution(toolCall.input);
  };
}

function paidAttempt(context: LlmCallContext | undefined, suffix: string): LlmCallContext {
  if (!context || context.requestKey.trim() === "") {
    throw new LlmLedgerUnavailableError("Платный LLM-вызов не получил идемпотентный requestKey");
  }
  return {
    requestKey: `${context.requestKey}:${suffix}`,
    traceKey: context.traceKey ?? context.requestKey,
    ...(context.metadata ? { metadata: context.metadata } : {}),
  };
}

function anthropicUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}): LlmTokenUsage {
  const cacheCreation = usage.cache_creation;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    ...(usage.cache_creation_input_tokens !== undefined &&
    usage.cache_creation_input_tokens !== null
      ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
      : {}),
    ...(cacheCreation?.ephemeral_5m_input_tokens !== undefined &&
    cacheCreation.ephemeral_5m_input_tokens !== null
      ? { cacheCreation5mInputTokens: cacheCreation.ephemeral_5m_input_tokens }
      : {}),
    ...(cacheCreation?.ephemeral_1h_input_tokens !== undefined &&
    cacheCreation.ephemeral_1h_input_tokens !== null
      ? { cacheCreation1hInputTokens: cacheCreation.ephemeral_1h_input_tokens }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
