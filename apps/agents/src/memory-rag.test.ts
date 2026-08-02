import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  return { embed: async (text) => (fail ? null : map[text] ?? [0, 0, 0]) };
}

/** Фейковый Core: копит события, отдаёт по типу. */
function fakeCore() {
  const events: { type: string; payload: unknown }[] = [];
  return {
    events,
    client: {
      recordEvent: async (input: { type: string; payload?: unknown }) => {
        events.push({ type: input.type, payload: input.payload });
      },
      listEvents: async (type: string) => events.filter((e) => e.type === type).map((e) => ({ payload: e.payload })),
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
    assert.equal(await rememberSemantic(client, emb, "ns", "1", "текст"), false);
    assert.deepEqual(await recallSemantic(client, emb, "ns", "запрос"), []);
  });

  it("вспоминает похожее по смыслу, не по точному совпадению", async () => {
    const { client } = fakeCore();
    const emb = fakeEmbedder(VECS);
    await rememberSemantic(client, emb, "leads", "a", "погрузчик HELI 3т");
    await rememberSemantic(client, emb, "leads", "b", "кофейный автомат");

    // Запрос про вилочный погрузчик — ближе к «погрузчик HELI», не к «кофе».
    const emb2 = fakeEmbedder({ ...VECS, "нужен вилочный погрузчик": [0.95, 0.05, 0] });
    const hits = await recallSemantic(client, emb2, "leads", "нужен вилочный погрузчик", 1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a", "самый похожий — погрузчик, не кофе");
    assert.ok(hits[0].score > 0.9);
  });

  it("namespace изолирован: чужой namespace не всплывает", async () => {
    const { client } = fakeCore();
    const emb = fakeEmbedder(VECS);
    await rememberSemantic(client, emb, "vendhub", "c", "кофейный автомат");
    const hits = await recallSemantic(client, emb, "leads", "кофейный автомат");
    assert.deepEqual(hits, [], "в namespace leads пусто");
  });
});
