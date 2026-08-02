import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelPost } from "@mydon/connectors";
import { buildIdeasProposal, readIdeaChannels, type ChannelDigest } from "./ideas";

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
