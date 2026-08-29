import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LlmBudgetDeniedError,
  LlmReplayBlockedError,
  type LlmBudgetSnapshot,
  type LlmLedger,
  type LlmSettlementRequest,
} from "@mydon/shared";
import { buildUserContent, createLlmResolver, mapToResolution } from "./llm";
import type { LlmSnapshot } from "./index";

// Тестируем самое рисковое место LLM-слоя — разбор ответа модели в намерение.
// Сам вызов Claude тонкий (SDK) и проверяется вживую после ввода ключа.

const budget: LlmBudgetSnapshot = {
  day: "2026-08-29",
  globalCapUsd: 5,
  globalExposureUsd: 0,
  remainingUsd: 5,
};

function fakeLedger(overrides: Partial<LlmLedger> = {}): LlmLedger {
  return {
    reserve: async (request) => ({
      id: "reservation-1",
      requestKey: request.requestKey,
      day: budget.day,
      reservedUsd: 0.1,
      replay: false,
      budget,
    }),
    settle: async () => undefined,
    fail: async () => undefined,
    release: async () => undefined,
    ...overrides,
  };
}

const paidSnapshot: LlmSnapshot = {
  briefing: { overdueMoney: 0, idleMachines: 0, pendingApprovals: 0, contractsDueSoon: 0 },
  pendingApprovals: 0,
  recentLabels: [],
  domains: "globerent, vendhub, personal",
};

describe("LLM: разбор ответа модели в намерение", () => {
  it("простые действия → одноимённые намерения", () => {
    for (const action of ["briefing", "approvals", "overdue", "machines", "recent"] as const) {
      const r = mapToResolution({ action });
      assert.equal(r.kind, "intent");
      if (r.kind === "intent") assert.equal(r.intent.kind, action);
    }
  });

  it("obligations с направлением → obligations, без направления → none (не отвечаем на другой вопрос)", () => {
    const withDomain = mapToResolution({ action: "obligations", domain: "vendhub" });
    assert.deepEqual(withDomain, {
      kind: "intent",
      intent: { kind: "obligations", domain: "vendhub" },
    });
    const noDomain = mapToResolution({ action: "obligations" });
    assert.equal(noDomain.kind, "none");
  });

  it("несуществующее направление → none, ничего не выдумываем и не подменяем вопрос", () => {
    const r = mapToResolution({ action: "obligations", domain: "марс" });
    assert.equal(r.kind, "none");
  });

  it("search: с запросом → поиск, пустой/короткий запрос → none", () => {
    const ok = mapToResolution({ action: "search", query: "Olma" });
    assert.deepEqual(ok, { kind: "intent", intent: { kind: "search", query: "Olma" } });
    assert.equal(mapToResolution({ action: "search", query: "" }).kind, "none");
    assert.equal(mapToResolution({ action: "search", query: "x" }).kind, "none");
  });

  it("search переносит направление, если модель его дала", () => {
    const r = mapToResolution({ action: "search", query: "CPCD30", domain: "globerent" });
    assert.deepEqual(r, {
      kind: "intent",
      intent: { kind: "search", query: "CPCD30", domain: "globerent" },
    });
  });

  it("answer с текстом → ответ словами, пустой ответ → none", () => {
    const ok = mapToResolution({ action: "answer", answer: "Тревог нет." });
    assert.deepEqual(ok, { kind: "answer", text: "Тревог нет." });
    assert.equal(mapToResolution({ action: "answer", answer: "   " }).kind, "none");
    assert.equal(mapToResolution({ action: "answer" }).kind, "none");
  });

  it("мусор и неизвестное действие → none (честно, без фантазий)", () => {
    assert.equal(mapToResolution({ action: "none" }).kind, "none");
    assert.equal(mapToResolution({ action: "выдумка" }).kind, "none");
    assert.equal(mapToResolution(null).kind, "none");
    assert.equal(mapToResolution("строка").kind, "none");
    assert.equal(mapToResolution({}).kind, "none");
  });
});

describe("LLM: заземление запроса", () => {
  const snapshot: LlmSnapshot = {
    briefing: {
      overdueMoney: 5,
      idleMachines: 2,
      pendingApprovals: 0,
      contractsDueSoon: 1,
      contractsBadDate: 2,
      overdueTasks: 3,
    },
    pendingApprovals: 4,
    recentLabels: ["ты одобрил", "агент попросил разрешения"],
    domains: "globerent, vendhub, personal",
  };

  it("вопрос и факты снимка попадают в запрос к модели", () => {
    const content = buildUserContent("когда мне платить?", snapshot);
    assert.match(content, /когда мне платить/);
    assert.match(content, /просрочено платежей: 5/);
    assert.match(content, /ждут решения: 4/);
    assert.match(content, /просроченных задач: 3/);
    assert.match(content, /ты одобрил; агент попросил разрешения/);
    assert.match(content, /globerent, vendhub/);
  });

  it("нераспознанные данные (contractsBadDate) видны модели — чтобы не заверяла «всё ок»", () => {
    const content = buildUserContent("всё в порядке с договорами?", snapshot);
    assert.match(content, /без распознанной даты.*: 2/);
  });

  it("пустой журнал показывается как «—», а не пусто", () => {
    const content = buildUserContent("что там", { ...snapshot, recentLabels: [] });
    assert.match(content, /последнее в системе: —/);
  });

  it("кофе-факты попадают в снимок: граммы, себестоимость, топ-точка", () => {
    const content = buildUserContent("сколько кофе ушло?", {
      ...snapshot,
      coffee: { totalGrams: 20500, totalCost: 1640000, topLocation: "American Hospital" },
    });
    assert.match(content, /расход кофе-ингредиентов за 30 дней.*20500 г/);
    assert.match(content, /себестоимость 1640000 сум/);
    assert.match(content, /больше всего — American Hospital/);
  });

  it("кофе без цен: «цены не заведены», а не 0 сум; без кофе — строки нет вовсе", () => {
    const noPrices = buildUserContent("расход?", {
      ...snapshot,
      coffee: { totalGrams: 100, totalCost: null, topLocation: null },
    });
    assert.match(noPrices, /цены не заведены/);
    const noCoffee = buildUserContent("расход?", snapshot);
    assert.doesNotMatch(noCoffee, /расход кофе/);
  });
});

describe("LLM: конструирование резолвера", () => {
  it("createLlmResolver возвращает функцию и не грузит SDK при вызове конструктора", () => {
    const before = Object.keys(require.cache).some((p) => p.includes("@anthropic-ai"));
    const resolver = createLlmResolver({
      apiKey: "sk-ant-нет-сети",
      ledger: fakeLedger(),
      consumer: "bot",
      feature: "assistant",
    });
    assert.equal(typeof resolver, "function");
    const after = Object.keys(require.cache).some((p) => p.includes("@anthropic-ai"));
    // SDK ленив: конструктор резолвера его не тянет (важно для импорта без ключа).
    assert.equal(before, after);
  });

  it("ledger отказал — Anthropic не вызывается", async () => {
    let providerCreated = false;
    const resolver = createLlmResolver({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        reserve: async () => {
          throw new LlmBudgetDeniedError("pause", "дневной лимит исчерпан", budget);
        },
      }),
      consumer: "bot",
      feature: "assistant",
      clientFactory: async () => {
        providerCreated = true;
        return {} as never;
      },
    });

    await assert.rejects(
      () => resolver("непонятный вопрос", paidSnapshot, { requestKey: "telegram:update:42" }),
      LlmBudgetDeniedError,
    );
    assert.equal(providerCreated, false, "клиент провайдера даже не должен создаваться");
  });

  it("replay того же requestKey блокирует повторную трату", async () => {
    let providerCreated = false;
    const ledger = fakeLedger();
    const originalReserve = ledger.reserve;
    ledger.reserve = async (request) => ({
      ...(await originalReserve(request)),
      replay: true,
    });
    const resolver = createLlmResolver({
      apiKey: "sk-ant-test",
      ledger,
      consumer: "bot",
      feature: "assistant",
      clientFactory: async () => {
        providerCreated = true;
        return {} as never;
      },
    });

    await assert.rejects(
      () => resolver("вопрос", paidSnapshot, { requestKey: "telegram:update:42" }),
      LlmReplayBlockedError,
    );
    assert.equal(providerCreated, false);
  });

  it("сбой создания клиента до отправки освобождает резерв", async () => {
    let released: { id: string; reason: string } | null = null;
    const resolver = createLlmResolver({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        release: async (id, reason) => {
          released = { id, reason };
        },
      }),
      consumer: "bot",
      feature: "assistant",
      clientFactory: async () => Promise.reject(new Error("SDK не загрузился")),
    });

    await assert.rejects(
      () => resolver("вопрос", paidSnapshot, { requestKey: "telegram:update:init-fail" }),
      /SDK не загрузился/,
    );
    assert.deepEqual(released, {
      id: "reservation-1",
      reason: "anthropic_client_init_failed_before_send",
    });
  });

  it("settle пишет usage до разбора content", async () => {
    const events: string[] = [];
    let settlement: LlmSettlementRequest | null = null;
    const response = {
      id: "msg_123",
      model: "claude-opus-5-resolved",
      usage: {
        input_tokens: 17,
        output_tokens: 4,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: 3,
        cache_creation: {
          ephemeral_5m_input_tokens: 2,
          ephemeral_1h_input_tokens: 1,
        },
      },
      get content() {
        events.push("parse");
        return [];
      },
    };
    const resolver = createLlmResolver({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        settle: async (_id, request) => {
          events.push("settle");
          settlement = request;
        },
      }),
      consumer: "cc",
      feature: "assistant",
      clientFactory: async () =>
        ({
          messages: {
            create: async () => {
              events.push("provider");
              return response;
            },
          },
        }) as never,
    });

    const result = await resolver("непонятный вопрос", paidSnapshot, {
      requestKey: "cc:request:abc",
    });
    assert.deepEqual(result, { kind: "none" });
    assert.deepEqual(events, ["provider", "settle", "parse"]);
    assert.deepEqual(settlement, {
      outcome: "success",
      providerRequestId: "msg_123",
      resolvedModel: "claude-opus-5-resolved",
      usage: {
        inputTokens: 17,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 3,
        cacheCreation5mInputTokens: 2,
        cacheCreation1hInputTokens: 1,
      },
    });
  });

  it("сбой settle не выбрасывает уже оплаченный ответ", async () => {
    const previousWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const resolver = createLlmResolver({
        apiKey: "sk-ant-test",
        ledger: fakeLedger({
          settle: async () => Promise.reject(new Error("Core недоступен")),
        }),
        consumer: "bot",
        feature: "assistant",
        clientFactory: async () =>
          ({
            messages: {
              create: async () => ({
                id: "msg_paid",
                model: "claude-opus-5",
                usage: { input_tokens: 2, output_tokens: 1 },
                content: [
                  {
                    type: "tool_use",
                    name: "classify_question",
                    input: { action: "answer", answer: "Оплаченный ответ" },
                  },
                ],
              }),
            },
          }) as never,
      });

      assert.deepEqual(
        await resolver("вопрос", paidSnapshot, { requestKey: "telegram:update:settle-down" }),
        { kind: "answer", text: "Оплаченный ответ" },
      );
      assert.match(String(warnings[0]?.[1]), /Core недоступен/);
    } finally {
      console.warn = previousWarn;
    }
  });

  it("неизвестная ошибка провайдера оставляет failed exposure", async () => {
    let failed: LlmSettlementRequest | null = null;
    const resolver = createLlmResolver({
      apiKey: "sk-ant-test",
      ledger: fakeLedger({
        fail: async (_id, request) => {
          failed = { ...request, outcome: request.outcome ?? "unknown" };
        },
      }),
      consumer: "bot",
      feature: "assistant",
      clientFactory: async () =>
        ({
          messages: { create: async () => Promise.reject(new Error("сетевой исход неизвестен")) },
        }) as never,
    });

    await assert.rejects(
      () => resolver("вопрос", paidSnapshot, { requestKey: "telegram:update:43" }),
      /сетевой исход/,
    );
    assert.deepEqual(failed, { outcome: "unknown", reason: "сетевой исход неизвестен" });
  });
});

describe("LLM: память в запросе к модели", () => {
  const base: LlmSnapshot = {
    briefing: { overdueMoney: 0, idleMachines: 0, pendingApprovals: 0, contractsDueSoon: 0 },
    pendingApprovals: 0,
    recentLabels: [],
    domains: "globerent, vendhub, personal",
  };

  it("выдержки попадают в запрос и помечены как память, а не как текущие цифры", () => {
    const text = buildUserContent("что решали по кофейне", {
      ...base,
      context: [{ kind: "знание", where: "Решения VendHub", text: "поставщика не меняем" }],
    });
    assert.ok(text.includes("поставщика не меняем"), "выдержка не попала в запрос");
    assert.ok(text.includes("Решения VendHub"), "источник не указан — модель не сможет сослаться");
    assert.ok(text.includes("НЕ текущие показатели"), "память не отделена от снимка");
  });

  it("без памяти запрос прежний — лишнего раздела нет", () => {
    const text = buildUserContent("вопрос", base);
    assert.ok(!text.includes("Прошлые разговоры"));
  });

  it("выдержек много — в запрос идёт ограниченное число (контекст не резиновый)", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      kind: "разговор" as const,
      where: `сессия ${i}`,
      text: `фрагмент ${i}`,
    }));
    const text = buildUserContent("вопрос", { ...base, context: many });
    assert.ok(text.includes("фрагмент 0"));
    assert.ok(!text.includes("фрагмент 19"), "в запрос ушли все выдержки — будет шум");
  });
});
