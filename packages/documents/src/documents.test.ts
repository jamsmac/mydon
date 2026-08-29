import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LlmBudgetDeniedError,
  LlmReplayBlockedError,
  type LlmBudgetSnapshot,
  type LlmLedger,
  type LlmSettlementRequest,
} from "@mydon/shared";
import { createDocumentBuilder, findFileId } from "./index";

const budget: LlmBudgetSnapshot = {
  day: "2026-08-29",
  globalCapUsd: 5,
  globalExposureUsd: 0,
  remainingUsd: 5,
};

function fakeLedger(overrides: Partial<LlmLedger> = {}): LlmLedger {
  return {
    reserve: async (request) => ({
      id: "reservation-doc-1",
      requestKey: request.requestKey,
      day: budget.day,
      reservedUsd: 1,
      replay: false,
      budget,
    }),
    settle: async () => undefined,
    fail: async () => undefined,
    release: async () => undefined,
    ...overrides,
  };
}

/**
 * Проверяем разбор ответа — самое хрупкое место: форма блоков результата
 * исполнения кода менялась между версиями API, и жёсткая привязка к одной
 * форме означала бы «файл не получился» на первом же обновлении.
 */
describe("Поиск готового файла в ответе", () => {
  it("находит file_id в блоке результата кода", () => {
    const resp = {
      content: [
        { type: "text", text: "Готово" },
        {
          type: "bash_code_execution_tool_result",
          content: {
            type: "bash_code_execution_result",
            content: [{ type: "bash_code_execution_output", file_id: "file_abc123" }],
          },
        },
      ],
    };
    assert.equal(findFileId(resp), "file_abc123");
  });

  it("находит file_id и в другой форме ответа (иначе ломались бы обновления API)", () => {
    const resp = { content: [{ type: "container_upload", file_id: "file_xyz" }] };
    assert.equal(findFileId(resp), "file_xyz");
  });

  it("нет файла — честно null, а не пустая строка", () => {
    assert.equal(findFileId({ content: [{ type: "text", text: "не смог" }] }), null);
    assert.equal(findFileId({}), null);
    assert.equal(findFileId(null), null);
  });

  it("не зацикливается на кольцевых ссылках", () => {
    const a: Record<string, unknown> = { type: "x" };
    a.self = a; // ответ SDK может содержать ссылки на себя
    assert.equal(findFileId(a), null);
  });
});

describe("Конструирование строителя документов", () => {
  it("возвращает функцию и не тянет SDK при создании", () => {
    const before = Object.keys(require.cache).some((p) => p.includes("@anthropic-ai"));
    const build = createDocumentBuilder({
      apiKey: "sk-ant-нет-сети",
      ledger: fakeLedger(),
      feature: "bot.report",
    });
    assert.equal(typeof build, "function");
    const after = Object.keys(require.cache).some((p) => p.includes("@anthropic-ai"));
    // SDK ленив: пакет импортируется даже там, где документы не нужны.
    assert.equal(before, after);
  });

  it("ledger отказал — Anthropic не вызывается", async () => {
    let providerCreated = false;
    const build = createDocumentBuilder({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        reserve: async () => {
          throw new LlmBudgetDeniedError("pause", "дневной лимит исчерпан", budget);
        },
      }),
      feature: "bot.report",
      clientFactory: async () => {
        providerCreated = true;
        return {} as never;
      },
    });

    await assert.rejects(
      () => build({ kind: "xlsx", instruction: "таблица" }, { requestKey: "telegram:update:42" }),
      LlmBudgetDeniedError,
    );
    assert.equal(providerCreated, false);
  });

  it("replay того же requestKey не запускает вторую платную генерацию", async () => {
    let providerCreated = false;
    const ledger = fakeLedger();
    const originalReserve = ledger.reserve;
    ledger.reserve = async (request) => ({
      ...(await originalReserve(request)),
      replay: true,
    });
    const build = createDocumentBuilder({
      apiKey: "sk-ant-test",
      ledger,
      feature: "bot.report",
      clientFactory: async () => {
        providerCreated = true;
        return {} as never;
      },
    });

    await assert.rejects(
      () => build({ kind: "xlsx", instruction: "таблица" }, { requestKey: "telegram:update:42" }),
      LlmReplayBlockedError,
    );
    assert.equal(providerCreated, false);
  });

  it("сбой создания клиента до отправки освобождает резерв", async () => {
    let released: { id: string; reason: string } | null = null;
    const build = createDocumentBuilder({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        release: async (id, reason) => {
          released = { id, reason };
        },
      }),
      feature: "bot.report",
      clientFactory: async () => Promise.reject(new Error("SDK не загрузился")),
    });

    await assert.rejects(
      () =>
        build(
          { kind: "xlsx", instruction: "таблица" },
          { requestKey: "telegram:update:init-fail" },
        ),
      /SDK не загрузился/,
    );
    assert.deepEqual(released, {
      id: "reservation-doc-1",
      reason: "anthropic_client_init_failed_before_send",
    });
  });

  it("после временного сбоя инициализации создаёт клиент заново", async () => {
    let factoryCalls = 0;
    const providerError = new Error("вторая попытка дошла до Anthropic");
    const build = createDocumentBuilder({
      apiKey: "sk-ant-test",
      ledger: fakeLedger(),
      feature: "bot.report",
      clientFactory: async () => {
        factoryCalls += 1;
        if (factoryCalls === 1) throw new Error("временный сбой SDK");
        return {
          beta: {
            messages: { create: async () => Promise.reject(providerError) },
            files: {},
          },
        } as never;
      },
    });

    await assert.rejects(
      () =>
        build(
          { kind: "xlsx", instruction: "первый документ" },
          { requestKey: "telegram:update:init-1" },
        ),
      /временный сбой SDK/,
    );
    await assert.rejects(
      () =>
        build(
          { kind: "xlsx", instruction: "второй документ" },
          { requestKey: "telegram:update:init-2" },
        ),
      (error) => error === providerError,
    );
    assert.equal(factoryCalls, 2);
  });

  it("settle происходит до поиска файла и download", async () => {
    const events: string[] = [];
    let settlement: LlmSettlementRequest | null = null;
    const response = {
      id: "msg_doc_1",
      model: "claude-opus-5-resolved",
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: 7,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 4,
        },
        server_tool_use: { code_execution_requests: 2 },
      },
      content: [
        { type: "text", text: "Готово" },
        { type: "server_tool_use", id: "tool-1", name: "code_execution", input: {} },
        { type: "server_tool_use", id: "tool-2", name: "code_execution", input: {} },
        { type: "container_upload", file_id: "file_1" },
      ],
    };
    const build = createDocumentBuilder({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        settle: async (_id, request) => {
          events.push("settle");
          settlement = request;
        },
      }),
      feature: "bot.report",
      clientFactory: async () =>
        ({
          beta: {
            messages: {
              create: async () => {
                events.push("provider");
                return response;
              },
            },
            files: {
              download: async () => {
                events.push("download");
                return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
              },
            },
          },
        }) as never,
    });

    const doc = await build(
      { kind: "xlsx", instruction: "сделай таблицу", filename: "Отчёт" },
      { requestKey: "telegram:update:43" },
    );
    assert.equal(doc.filename, "Отчёт.xlsx");
    assert.deepEqual(events, ["provider", "settle", "download"]);
    assert.deepEqual(settlement, {
      outcome: "success",
      providerRequestId: "msg_doc_1",
      resolvedModel: "claude-opus-5-resolved",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 7,
        cacheCreation5mInputTokens: 3,
        cacheCreation1hInputTokens: 4,
        codeExecutionRequests: 2,
      },
    });
  });

  it("если модель не вернула файл, usage всё равно уже settled", async () => {
    let settled = false;
    const build = createDocumentBuilder({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        settle: async () => {
          settled = true;
        },
      }),
      feature: "bot.report",
      clientFactory: async () =>
        ({
          beta: {
            messages: {
              create: async () => ({
                id: "msg_no_file",
                model: "claude-opus-5",
                usage: {
                  input_tokens: 3,
                  output_tokens: 2,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
                content: [{ type: "text", text: "файл не получился" }],
              }),
            },
            files: {
              download: async () => {
                throw new Error("download не должен вызываться");
              },
            },
          },
        }) as never,
    });

    await assert.rejects(
      () => build({ kind: "docx", instruction: "документ" }, { requestKey: "telegram:update:44" }),
      /Файл не получился/,
    );
    assert.equal(settled, true);
  });

  it("сбой settle не выбрасывает уже оплаченный файл", async () => {
    const previousWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const build = createDocumentBuilder({
        apiKey: "sk-ant-test",
        ledger: fakeLedger({
          settle: async () => Promise.reject(new Error("Core недоступен")),
        }),
        feature: "bot.report",
        clientFactory: async () =>
          ({
            beta: {
              messages: {
                create: async () => ({
                  id: "msg_paid_doc",
                  model: "claude-opus-5",
                  usage: { input_tokens: 3, output_tokens: 2 },
                  content: [{ type: "container_upload", file_id: "file_paid" }],
                }),
              },
              files: {
                download: async () => ({
                  arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer,
                }),
              },
            },
          }) as never,
      });

      const doc = await build(
        { kind: "xlsx", instruction: "таблица", filename: "Оплачено" },
        { requestKey: "telegram:update:settle-down" },
      );
      assert.equal(doc.filename, "Оплачено.xlsx");
      assert.deepEqual([...doc.content], [4, 5, 6]);
      assert.match(String(warnings[0]?.[1]), /Core недоступен/);
    } finally {
      console.warn = previousWarn;
    }
  });

  it("ошибка провайдера оставляет failed exposure", async () => {
    let failed: LlmSettlementRequest | null = null;
    const providerError = new Error("таймаут Anthropic");
    const build = createDocumentBuilder({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        fail: async (_id, request) => {
          failed = { ...request, outcome: request.outcome ?? "unknown" };
          throw new Error("Core не принял fail");
        },
      }),
      feature: "bot.report",
      clientFactory: async () =>
        ({
          beta: {
            messages: { create: async () => Promise.reject(providerError) },
            files: {},
          },
        }) as never,
    });

    await assert.rejects(
      () => build({ kind: "xlsx", instruction: "таблица" }, { requestKey: "telegram:update:45" }),
      (error) => error === providerError,
    );
    assert.deepEqual(failed, { outcome: "unknown", reason: "таймаут Anthropic" });
  });
});
