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
  model?: string;
  /** Потолок токенов: построение таблицы — это код, ему нужен запас. */
  maxTokens?: number;
  /** Таймаут, мс. Документ строится дольше ответа, но висеть вечно нельзя. */
  timeoutMs?: number;
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

  let clientPromise: Promise<Anthropic> | null = null;
  function client(): Promise<Anthropic> {
    if (clientPromise === null) {
      clientPromise = import("@anthropic-ai/sdk").then(
        (m) => new m.default({ apiKey: config.apiKey, timeout, maxRetries: 1 }),
      );
    }
    return clientPromise;
  }

  return async function build(req: DocumentRequest): Promise<GeneratedDocument> {
    const c = await client();

    const parts = [
      `Построй ${KIND_HINT[req.kind]}.`,
      "",
      `Задача: ${req.instruction}`,
    ];
    if (req.data !== undefined) {
      parts.push("", "Данные (только они, ничего не выдумывай):", "```json", JSON.stringify(req.data, null, 2), "```");
    }

    const resp = await c.beta.messages.create({
      model,
      max_tokens: maxTokens,
      betas: ["code-execution-2025-08-25", "skills-2025-10-02"],
      container: { skills: [{ type: "anthropic", skill_id: req.kind, version: "latest" }] },
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
      system: SYSTEM,
      messages: [{ role: "user", content: parts.join("\n") }],
    } as never);

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
