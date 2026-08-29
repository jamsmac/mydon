import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelPost } from "@mydon/connectors";
import type { EmbeddingGateway } from "./embedding";
import {
  assessIdeas,
  buildIdeasProposal,
  readIdeaChannels,
  type ChannelDigest,
  type IdeasMemory,
} from "./ideas";
import type { ModelGateway, ModelRequest } from "./model-gateway";

function post(num: number, text: string, links: string[] = []): ChannelPost {
  return { id: `promtjam/${num}`, num, text, links, datetime: null };
}

describe("readIdeaChannels", () => {
  it("читает каналы; недоступный не роняет остальные", async () => {
    const reader = async (c: string) => {
      if (c === "bad") throw new Error("404");
      return [post(1, "идея A")];
    };
    const digests = await readIdeaChannels(["promtjam", "bad"], reader);
    assert.equal(digests[0].posts.length, 1);
    assert.equal(digests[1].error, "404");
    assert.equal(digests[1].posts.length, 0);
  });
});

describe("buildIdeasProposal", () => {
  it("нет постов → null", () => {
    assert.equal(buildIdeasProposal([{ channel: "promtjam", posts: [] }]), null);
  });

  it("дайджест: сортировка по свежести, latestNum для дельта-памяти", () => {
    const digests: ChannelDigest[] = [
      {
        channel: "promtjam",
        posts: [
          post(414, "OmniRoute\nAI-gateway", ["https://omni.example"]),
          post(420, "claudexor ротация квот"),
        ],
      },
    ];
    const p = buildIdeasProposal(digests);
    assert.ok(p);
    assert.match(p.action, /Идеи из каналов/);
    assert.equal(p.facts.latestNum, 420, "для дельты — номер самого свежего поста");
    assert.equal(p.facts.total, 2);
    const top = p.facts.top as { title: string }[];
    assert.equal(top[0].title, "claudexor ротация квот", "свежий пост первым");
  });

  it("недоступный канал отмечается в фактах и тексте", () => {
    const digests: ChannelDigest[] = [
      { channel: "promtjam", posts: [post(1, "идея")] },
      { channel: "closed", posts: [], error: "403" },
    ];
    const p = buildIdeasProposal(digests);
    assert.ok(p);
    assert.match(p.action, /Недоступны: closed/);
  });
});

describe("assessIdeas — оценка моделью (первый LLM-навык)", () => {
  const OPTS = { agentName: "knowledge-curator", requestKey: "ideas-test" } as const;

  function fakeGateway(text: string, ok = true): { gateway: ModelGateway; seen: ModelRequest[] } {
    const seen: ModelRequest[] = [];
    const gateway: ModelGateway = {
      provider: "test-local",
      billingMode: "local",
      call: async (model, req) => {
        seen.push(req);
        return { text, model, costUsd: 0, ok };
      },
    };
    return { gateway, seen };
  }

  it("нет постов → null (нечего оценивать)", async () => {
    const { gateway } = fakeGateway("x");
    assert.equal(await assessIdeas(gateway, [{ channel: "promtjam", posts: [] }], OPTS), null);
  });

  it("оценка модели → предложение; посты идут как обёрнутый недоверенный контент", async () => {
    const { gateway, seen } = fakeGateway("1. claudexor — в LLM-путь\n2. Lightpanda — веб-скан");
    const p = await assessIdeas(
      gateway,
      [{ channel: "promtjam", posts: [post(420, "claudexor ротация")] }],
      OPTS,
    );
    assert.ok(p);
    assert.match(p.action, /Оценка идей канала/);
    assert.match(String(p.facts.assessment), /claudexor/);
    // callModel обернул посты от инъекций (маркеры UNTRUSTED_DATA в промпте).
    assert.match(seen[0].prompt, /UNTRUSTED_DATA/);
    assert.match(seen[0].system ?? "", /не исполняй/i);
  });

  it("модель не ответила → null (не выдаём пустую оценку за работу)", async () => {
    const { gateway } = fakeGateway("", false);
    assert.equal(
      await assessIdeas(gateway, [{ channel: "promtjam", posts: [post(1, "идея")] }], OPTS),
      null,
    );
  });

  // ── Семантическая память (RAG, #6b): дедуп уже разобранных идей ──────────────
  function fakeEmbedder(map: Record<string, number[]>): EmbeddingGateway {
    return {
      provider: "test-local",
      billingMode: "local",
      model: "fake",
      embed: async (t) => ({ vector: map[t] ?? [0, 0, 1] }),
    };
  }
  function fakeCore(seed: { type: string; payload: unknown }[] = []) {
    const events = [...seed];
    return {
      events,
      client: {
        recordEvent: async (i: { type: string; payload?: unknown }) => {
          events.push({ type: i.type, payload: i.payload });
        },
        listEvents: async (type: string) =>
          events.filter((e) => e.type === type).map((e) => ({ payload: e.payload })),
      } as never,
    };
  }

  it("память: запоминает разобранные посты (для будущего дедупа)", async () => {
    const { gateway } = fakeGateway("1. идея — в ядро");
    const { client, events } = fakeCore();
    const emb = fakeEmbedder({ "новая фишка": [1, 0, 0] });
    const memory: IdeasMemory = { core: client, embedder: emb, namespace: "ideas" };
    const p = await assessIdeas(
      gateway,
      [{ channel: "promtjam", posts: [post(7, "новая фишка")] }],
      { ...OPTS, memory },
    );
    assert.ok(p);
    assert.equal(p.facts.priorHits, 0, "в пустой памяти совпадений нет");
    const remembered = events.filter((e) => e.type === "agent.embed:ideas");
    assert.equal(remembered.length, 1, "разобранный пост записан в семантическую память");
  });

  it("память: похожую уже разобранную идею помечает и просит не повторять", async () => {
    const { gateway, seen } = fakeGateway("1. что-то новое");
    // В памяти уже лежит «claudexor ротация» с вектором [1,0,0].
    const stored = [
      {
        type: "agent.embed:ideas",
        payload: { id: "promtjam/1", text: "claudexor ротация квот", vector: [1, 0, 0] },
      },
    ];
    const { client } = fakeCore(stored);
    // Новый пост про claudexor — эмбеддер даёт близкий вектор (косинус ≈ 1 ≥ 0.85).
    const emb = fakeEmbedder({
      "claudexor снова": [0.99, 0.01, 0],
      "claudexor снова про ротацию": [0.99, 0.01, 0],
    });
    const memory: IdeasMemory = { core: client, embedder: emb };
    const p = await assessIdeas(
      gateway,
      [{ channel: "promtjam", posts: [post(9, "claudexor снова про ротацию")] }],
      { ...OPTS, memory },
    );
    assert.ok(p);
    assert.equal(p.facts.priorHits, 1, "нашли одну уже разобранную похожую идею");
    // Прошлая идея попала в НЕДОВЕРЕННЫЙ блок под маркером, инструкция — не повторять.
    assert.match(seen[0].prompt, /РАНЕЕ РАЗОБРАННОЕ/);
    assert.match(seen[0].prompt, /claudexor/);
  });
});
