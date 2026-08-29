/**
 * Документы MYDON: Excel, Word, PowerPoint, PDF.
 *
 * Используются ГОТОВЫЕ навыки Anthropic (xlsx/docx/pptx/pdf) — писать свою
 * генерацию файлов незачем. Работает это не «моделью, печатающей файл»:
 * модель запускает код в изолированном контейнере Anthropic, где уже стоят
 * нужные библиотеки, и возвращает готовый файл. Поэтому нужны два признака
 * сразу: навык (что уметь) и исполнение кода (где это делать).
 *
 * Зачем владельцу: агент должен отдавать не текст «вот дебиторка», а файл,
 * который можно открыть, отправить бухгалтеру и подшить.
 *
 * Ключ не задан → генерация недоступна, но система работает дальше: вызывающий
 * получает понятную причину, а не сбой.
 */

// import type стирается на сборке: SDK грузится лениво, при первом документе.
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  inputTokenCeiling,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  type LlmCallContext,
  type LlmLedger,
  type LlmTokenUsage,
} from "@mydon/shared";

type DocumentsAnthropicClient = Pick<Anthropic, "beta">;

/** Что умеем делать. Названия — как у навыков Anthropic. */
export type DocumentKind = "xlsx" | "docx" | "pptx" | "pdf";

export interface DocumentRequest {
  kind: DocumentKind;
  /** Что построить — обычными словами, как объяснил бы человеку. */
  instruction: string;
  /** Данные, на которых строить. Модель не выдумывает цифры, а берёт эти. */
  data?: unknown;
  /** Имя файла без расширения; расширение добавляется по типу. */
  filename?: string;
}

export interface GeneratedDocument {
  filename: string;
  /** Содержимое файла — его можно отправить в Telegram или сохранить. */
  content: Buffer;
  /** Что модель написала словами: короткое пояснение к файлу. */
  summary: string;
}

export interface DocumentsConfig {
  apiKey: string;
  /** Единый денежный ledger. Без reserve платный API не вызывается. */
  ledger: LlmLedger;
  /** Стабильное имя сценария, например bot.report. */
  feature: string;
  model?: string;
  /** Потолок токенов: построение таблицы — это код, ему нужен запас. */
  maxTokens?: number;
  /** Таймаут, мс. Документ строится дольше ответа, но висеть вечно нельзя. */
  timeoutMs?: number;
  /** Тестовый seam: production использует ленивый SDK-клиент. */
  clientFactory?: () => Promise<DocumentsAnthropicClient>;
}

const EXT: Record<DocumentKind, string> = {
  xlsx: "xlsx",
  docx: "docx",
  pptx: "pptx",
  pdf: "pdf",
};

const KIND_HINT: Record<DocumentKind, string> = {
  xlsx: "таблицу Excel с заголовками, форматированием чисел и итогами",
  docx: "документ Word с заголовками и абзацами",
  pptx: "презентацию PowerPoint",
  pdf: "документ PDF",
};

const SYSTEM = [
  "Ты готовишь деловые документы для владельца бизнеса в Узбекистане.",
  "",
  "Правила:",
  "• Всё по-русски. Валюта — UZS, суммы с разделением разрядов.",
  "• Используй ТОЛЬКО переданные данные. Ничего не додумывай и не дорисовывай.",
  "• Данных не хватает — так и напиши в документе, а не подставляй правдоподобное.",
  "• Документ должен быть готов к отправке: понятные заголовки, итоги, даты.",
  "• Сохрани файл в /mnt/outputs/ — оттуда его заберут.",
].join("\n");

/** Ошибка с человеческой причиной: её увидит владелец, а не разработчик. */
export class DocumentError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Построение документа. Возвращает готовый файл.
 *
 * Ошибки (нет ключа, сеть, лимит) — понятной фразой: вызывающий покажет её
 * владельцу и продолжит работу, а не упадёт.
 */
export function createDocumentBuilder(config: DocumentsConfig) {
  const model = config.model && config.model.length > 0 ? config.model : "claude-opus-5";
  const maxTokens = config.maxTokens ?? 16000;
  const timeout = config.timeoutMs ?? 180_000; // построение файла дольше ответа

  let clientPromise: Promise<DocumentsAnthropicClient> | null = null;
  function client(): Promise<DocumentsAnthropicClient> {
    if (clientPromise === null) {
      const pending = config.clientFactory
        ? config.clientFactory()
        : import("@anthropic-ai/sdk").then(
            // Один reservation — одна физическая попытка; скрытые retry запрещены.
            (m) => new m.default({ apiKey: config.apiKey, timeout, maxRetries: 0 }),
          );
      clientPromise = pending.catch((error) => {
        // Не кэшируем rejected Promise навсегда: импорт/инициализация
        // могут восстановиться к следующей независимой попытке.
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  }

  return async function build(
    req: DocumentRequest,
    context?: LlmCallContext,
  ): Promise<GeneratedDocument> {
    const parts = [`Построй ${KIND_HINT[req.kind]}.`, "", `Задача: ${req.instruction}`];
    if (req.data !== undefined) {
      parts.push(
        "",
        "Данные (только они, ничего не выдумывай):",
        "```json",
        JSON.stringify(req.data, null, 2),
        "```",
      );
    }

    const userContent = parts.join("\n");
    const attempt = paidAttempt(context, "anthropic-documents");
    const reservation = await config.ledger.reserve({
      ...attempt,
      consumer: "documents",
      feature: config.feature,
      provider: "anthropic",
      model,
      inputTokenCeiling: inputTokenCeiling([SYSTEM, userContent, req.kind].join("\n")),
      outputTokenCeiling: maxTokens,
    });

    // Ledger идемпотентен по requestKey, но не хранит готовый файл.
    // Без provider-side idempotency replay мог бы повторно списать деньги.
    if (reservation.replay) {
      throw new LlmReplayBlockedError(
        reservation.requestKey,
        "Эта платная генерация документа уже была принята; повторный вызов заблокирован",
      );
    }

    let c: DocumentsAnthropicClient;
    try {
      c = await client();
    } catch (error) {
      // До messages.create провайдер точно ничего не получил — release здесь
      // допустим. Если сам release недоступен, строка останется exposure.
      await config.ledger
        .release(reservation.id, "anthropic_client_init_failed_before_send")
        .catch(() => undefined);
      throw error;
    }

    let resp: BetaMessage;
    try {
      resp = await c.beta.messages.create({
        model,
        max_tokens: maxTokens,
        betas: ["code-execution-2025-08-25", "skills-2025-10-02"],
        container: { skills: [{ type: "anthropic", skill_id: req.kind, version: "latest" }] },
        tools: [{ type: "code_execution_20260521", name: "code_execution" }],
        system: SYSTEM,
        messages: [{ role: "user", content: userContent }],
      } as never);
    } catch (error) {
      // Запрос мог дойти до провайдера, поэтому release здесь небезопасен.
      // Сбой Core не должен подменить исходную ошибку провайдера.
      await config.ledger
        .fail(reservation.id, {
          outcome: "unknown",
          reason: errorMessage(error),
        })
        .catch(() => undefined);
      throw error;
    }

    // Ответ уже оплачен. Фиксируем его до поиска file_id и до download.
    try {
      await config.ledger.settle(reservation.id, {
        outcome: "success",
        providerRequestId: resp.id,
        resolvedModel: String(resp.model),
        usage: anthropicUsage(resp),
      });
    } catch (error) {
      // Файл уже создан и оплачен. Не теряем его из-за отдельного сбоя учёта:
      // reservation останется exposure, а следующий reserve закроется
      // fail-closed до восстановления Core.
      console.warn("LLM-ledger не подтвердил оплаченный ответ Documents:", errorMessage(error));
    }

    // Пояснение модели словами — пойдёт вместе с файлом.
    const summary = (resp as { content: { type: string; text?: string }[] }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();

    const fileId = findFileId(resp);
    if (fileId === null) {
      throw new DocumentError(
        summary.length > 0
          ? `Файл не получился. Модель ответила: ${summary.slice(0, 300)}`
          : "Файл не получился — модель не вернула документ.",
      );
    }

    const downloaded = await c.beta.files.download(fileId, {
      betas: ["files-api-2025-04-14"],
    } as never);
    const content = Buffer.from(await (downloaded as unknown as Response).arrayBuffer());

    const base = (req.filename ?? "mydon-документ").replace(/[^\p{L}\p{N} _.-]/gu, "").trim();
    return {
      filename: `${base || "mydon-документ"}.${EXT[req.kind]}`,
      content,
      summary,
    };
  };
}

function paidAttempt(context: LlmCallContext | undefined, suffix: string): LlmCallContext {
  if (!context || context.requestKey.trim() === "") {
    throw new LlmLedgerUnavailableError(
      "Платная генерация документа не получила идемпотентный requestKey",
    );
  }
  return {
    requestKey: `${context.requestKey}:${suffix}`,
    traceKey: context.traceKey ?? context.requestKey,
    ...(context.metadata ? { metadata: context.metadata } : {}),
  };
}

function anthropicUsage(resp: BetaMessage): LlmTokenUsage {
  const usage = resp.usage as typeof resp.usage & {
    cache_creation?: {
      ephemeral_5m_input_tokens?: number | null;
      ephemeral_1h_input_tokens?: number | null;
    } | null;
    server_tool_use?: { code_execution_requests?: number | null } | null;
  };
  const contentCodeExecutionRequests = resp.content.filter(
    (block) =>
      block.type === "server_tool_use" &&
      (block.name === "code_execution" ||
        block.name === "bash_code_execution" ||
        block.name === "text_editor_code_execution"),
  ).length;
  const reportedCodeExecutionRequests = usage.server_tool_use?.code_execution_requests;
  const codeExecutionRequests =
    typeof reportedCodeExecutionRequests === "number" &&
    Number.isFinite(reportedCodeExecutionRequests) &&
    reportedCodeExecutionRequests >= 0
      ? Math.floor(reportedCodeExecutionRequests)
      : contentCodeExecutionRequests;
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
    codeExecutionRequests,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Поиск id готового файла в ответе.
 *
 * Форма блоков результата исполнения кода менялась между версиями API, поэтому
 * ищем file_id по всей структуре: жёсткая привязка к одной форме ломалась бы
 * на первом же обновлении, а владелец увидел бы «файл не получился».
 */
export function findFileId(response: unknown): string | null {
  let found: string | null = null;
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (found !== null || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const id = obj.file_id;
    if (typeof id === "string" && id.length > 0) {
      found = id;
      return;
    }
    for (const value of Object.values(obj)) walk(value);
  };

  walk(response);
  return found;
}
