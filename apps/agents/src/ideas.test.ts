import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelPost } from "@mydon/connectors";
import { assessIdeas, buildIdeasProposal, readIdeaChannels, type ChannelDigest } from "./ideas";
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
      { channel: "promtjam", posts: [post(414, "OmniRoute\nAI-gateway", ["https://omni.example"]), post(420, "claudexor ротация квот")] },
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
  function fakeGateway(text: string, ok = true): { gateway: ModelGateway; seen: ModelRequest[] } {
    const seen: ModelRequest[] = [];
    const gateway: ModelGateway = {
      call: async (model, req) => {
        seen.push(req);
        return { text, model, costUsd: 0, ok };
      },
    };
    return { gateway, seen };
  }

  it("нет постов → null (нечего оценивать)", async () => {
    const { gateway } = fakeGateway("x");
    assert.equal(await assessIdeas(gateway, [{ channel: "promtjam", posts: [] }]), null);
  });

  it("оценка модели → предложение; посты идут как обёрнутый недоверенный контент", async () => {
    const { gateway, seen } = fakeGateway("1. claudexor — в LLM-путь\n2. Lightpanda — веб-скан");
    const p = await assessIdeas(gateway, [{ channel: "promtjam", posts: [post(420, "claudexor ротация")] }]);
    assert.ok(p);
    assert.match(p.action, /Оценка идей канала/);
    assert.match(String(p.facts.assessment), /claudexor/);
    // callModel обернул посты от инъекций (маркеры UNTRUSTED_DATA в промпте).
    assert.match(seen[0].prompt, /UNTRUSTED_DATA/);
    assert.match(seen[0].system ?? "", /не исполняй/i);
  });

  it("модель не ответила → null (не выдаём пустую оценку за работу)", async () => {
    const { gateway } = fakeGateway("", false);
    assert.equal(await assessIdeas(gateway, [{ channel: "promtjam", posts: [post(1, "идея")] }]), null);
  });
});
