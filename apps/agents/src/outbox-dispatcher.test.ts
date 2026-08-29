import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotionError } from "@mydon/connectors";
import {
  drainNotionOutbox,
  type AgentOutboxClient,
  type ClaimedOutboxDelivery,
} from "./outbox-dispatcher";

function delivery(payload: unknown): ClaimedOutboxDelivery {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    key: "task:t:execution:e:notion-report",
    destination: "notion-report",
    payload,
    leaseToken: "22222222-2222-4222-8222-222222222222",
  };
}

function reportPayload() {
  return {
    report: {
      title: "Разобрать дебиторку — 29.08.2026",
      author: "finance",
      blocks: [{ heading: "Что нашёл", paragraphs: ["Есть просрочка"] }],
    },
  };
}

function fakeCore(items: ClaimedOutboxDelivery[]) {
  const completed: { status: string; options?: { providerRef?: string; error?: string } }[] = [];
  const core: AgentOutboxClient = {
    claimOutbox: async () => items.shift() ?? null,
    completeOutbox: async (_id, _lease, status, options) => {
      completed.push({ status, ...(options ? { options } : {}) });
      return {};
    },
  };
  return { core, completed };
}

const ENV = { NOTION_TOKEN: "token", NOTION_PARENT_PAGE_ID: "page" };

describe("Notion outbox dispatcher", () => {
  it("публикует pending intent и подтверждает provider id", async () => {
    const { core, completed } = fakeCore([delivery(reportPayload())]);
    const result = await drainNotionOutbox(core, {
      env: ENV,
      publish: async () => ({ id: "notion-1", url: "https://notion.so/1" }),
    });
    assert.equal(result.sent, 1);
    assert.deepEqual(completed, [{ status: "sent", options: { providerRef: "notion-1" } }]);
  });

  it("без конфигурации фиксирует skipped и не вызывает provider", async () => {
    const { core, completed } = fakeCore([delivery(reportPayload())]);
    let calls = 0;
    const result = await drainNotionOutbox(core, {
      env: {},
      publish: async () => {
        calls += 1;
        return { id: "x", url: "x" };
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped, 1);
    assert.equal(completed[0]?.status, "skipped");
  });

  it("timeout помечает unknown и не делает скрытый retry", async () => {
    const { core, completed } = fakeCore([delivery(reportPayload())]);
    let calls = 0;
    const result = await drainNotionOutbox(core, {
      env: ENV,
      limit: 10,
      publish: async () => {
        calls += 1;
        throw new Error("timeout");
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.unknown, 1);
    assert.equal(completed[0]?.status, "unknown");
  });

  it("Notion 5xx помечает unknown и не повторяет неоднозначный create", async () => {
    const { core, completed } = fakeCore([delivery(reportPayload())]);
    let calls = 0;
    const result = await drainNotionOutbox(core, {
      env: ENV,
      publish: async () => {
        calls += 1;
        throw new NotionError("service unavailable", 503);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.unknown, 1);
    assert.equal(completed[0]?.status, "unknown");
  });

  it("Notion 409 оставляет unknown: conflict не теряем и не retry-им create", async () => {
    const { core, completed } = fakeCore([delivery(reportPayload())]);
    let calls = 0;
    const result = await drainNotionOutbox(core, {
      env: ENV,
      publish: async () => {
        calls += 1;
        throw new NotionError("conflict_error", 409);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.unknown, 1);
    assert.equal(completed[0]?.status, "unknown");
  });

  it("429 ждёт Retry-After и повторяет create под тем же claim", async () => {
    const item = delivery(reportPayload());
    const { core, completed } = fakeCore([item]);
    const delays: number[] = [];
    let calls = 0;
    const result = await drainNotionOutbox(core, {
      env: ENV,
      sleep: async (ms) => {
        delays.push(ms);
      },
      publish: async () => {
        calls += 1;
        if (calls === 1) throw new NotionError("rate_limited", 429, 2_500);
        return { id: "notion-after-retry", url: "https://notion.so/retry" };
      },
    });

    assert.equal(calls, 2);
    assert.deepEqual(delays, [2_500]);
    assert.equal(result.sent, 1);
    assert.deepEqual(completed, [
      { status: "sent", options: { providerRef: "notion-after-retry" } },
    ]);
  });

  it("после bounded 429 retries фиксирует dead без нового claim", async () => {
    const { core, completed } = fakeCore([delivery(reportPayload())]);
    const delays: number[] = [];
    let calls = 0;
    const result = await drainNotionOutbox(core, {
      env: ENV,
      rateLimitBaseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
      publish: async () => {
        calls += 1;
        throw new NotionError("rate_limited", 429);
      },
    });

    assert.equal(calls, 3, "первичная попытка + два bounded retry");
    assert.deepEqual(delays, [100, 200]);
    assert.equal(result.dead, 1);
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.status, "dead");
    assert.match(completed[0]?.options?.error ?? "", /retry exhausted after 3 attempts/);
  });

  it("детерминированный Notion 4xx и битые payload становятся dead", async () => {
    const { core, completed } = fakeCore([
      delivery(reportPayload()),
      delivery({ report: 1 }),
      delivery({
        report: {
          title: "bad nested block",
          author: "agent",
          blocks: [{ bullets: ["valid", 42] }],
        },
      }),
    ]);
    const result = await drainNotionOutbox(core, {
      env: ENV,
      publish: async () => {
        throw new NotionError("object_not_found", 404);
      },
    });
    assert.equal(result.dead, 3);
    assert.deepEqual(
      completed.map((entry) => entry.status),
      ["dead", "dead", "dead"],
    );
  });
});
