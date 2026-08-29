import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmLedgerUnavailableError } from "@mydon/shared";
import { cosineSimilarity, type EmbeddingGateway } from "./embedding";
import { recallSemantic, rememberSemantic } from "./memory-rag";

describe("cosineSimilarity", () => {
  it("одинаковые векторы → 1, ортогональные → 0", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });
  it("разная длина или нули → 0 (безопасно)", () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
    assert.equal(cosineSimilarity([], []), 0);
  });
});

/** Фейковый эмбеддер: слово → простой вектор по «теме» (детерминированно). */
function fakeEmbedder(map: Record<string, number[]>, fail = false): EmbeddingGateway {
  return {
    provider: "test-local",
    billingMode: "local",
    model: "fake",
    embed: async (text) => ({ vector: fail ? null : (map[text] ?? [0, 0, 0]) }),
  };
}

const CONTEXT = {
  agentName: "test-agent",
  feature: "memory-test",
  requestKey: "memory-test",
} as const;

/** Фейковый Core: копит события, отдаёт по типу. */
function fakeCore() {
  const events: { type: string; payload: unknown; clientKey?: string }[] = [];
  return {
    events,
    client: {
      recordEvent: async (input: { type: string; payload?: unknown; clientKey?: string }) => {
        events.push({
          type: input.type,
          payload: input.payload,
          ...(input.clientKey ? { clientKey: input.clientKey } : {}),
        });
      },
      listEvents: async (type: string) =>
        events.filter((e) => e.type === type).map((e) => ({ payload: e.payload })),
    } as never,
  };
}

describe("rememberSemantic / recallSemantic", () => {
  const VECS = {
    "погрузчик HELI 3т": [1, 0, 0],
    "вилочный погрузчик 3 тонны": [0.9, 0.1, 0],
    "кофейный автомат": [0, 1, 0],
  };

  it("нет эмбеддинга → remember=false, recall=[]", async () => {
    const { client } = fakeCore();
    const emb = fakeEmbedder({}, true);
    assert.equal(await rememberSemantic(client, emb, "ns", "1", "текст", CONTEXT), false);
    assert.deepEqual(await recallSemantic(client, emb, "ns", "запрос", CONTEXT), []);
  });

  it("вспоминает похожее по смыслу, не по точному совпадению", async () => {
    const { client } = fakeCore();
    const emb = fakeEmbedder(VECS);
    await rememberSemantic(client, emb, "leads", "a", "погрузчик HELI 3т", CONTEXT);
    await rememberSemantic(client, emb, "leads", "b", "кофейный автомат", CONTEXT);

    // Запрос про вилочный погрузчик — ближе к «погрузчик HELI», не к «кофе».
    const emb2 = fakeEmbedder({ ...VECS, "нужен вилочный погрузчик": [0.95, 0.05, 0] });
    const hits = await recallSemantic(
      client,
      emb2,
      "leads",
      "нужен вилочный погрузчик",
      CONTEXT,
      1,
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a", "самый похожий — погрузчик, не кофе");
    assert.ok(hits[0].score > 0.9);
  });

  it("namespace изолирован: чужой namespace не всплывает", async () => {
    const { client } = fakeCore();
    const emb = fakeEmbedder(VECS);
    await rememberSemantic(client, emb, "vendhub", "c", "кофейный автомат", CONTEXT);
    const hits = await recallSemantic(client, emb, "leads", "кофейный автомат", CONTEXT);
    assert.deepEqual(hits, [], "в namespace leads пусто");
  });

  it("повтор logical memory write имеет один stable clientKey", async () => {
    const { client, events } = fakeCore();
    const emb = fakeEmbedder(VECS);
    await rememberSemantic(client, emb, "leads", "a", "погрузчик HELI 3т", CONTEXT);
    await rememberSemantic(client, emb, "leads", "a", "погрузчик HELI 3т", CONTEXT);
    assert.equal(events.length, 2, "fake Core намеренно не дедуплицирует");
    assert.ok(events[0]?.clientKey?.startsWith("agent-semantic:"));
    assert.equal(events[0]?.clientKey, events[1]?.clientKey);
    assert.ok((events[0]?.clientKey?.length ?? 0) < 128);
  });

  it("lease потерян после embedding — событие памяти не записывается", async () => {
    const { client, events } = fakeCore();
    let checks = 0;
    await assert.rejects(
      () =>
        rememberSemantic(client, fakeEmbedder(VECS), "lease", "x", "кофейный автомат", {
          ...CONTEXT,
          assertLease: async () => {
            checks += 1;
            if (checks === 2) throw new LlmLedgerUnavailableError("task lease lost");
          },
        }),
      LlmLedgerUnavailableError,
    );
    assert.deepEqual(events, []);
  });
});
