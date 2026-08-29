import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { hashLedgerPayload } from "../llm-ledger/llm-ledger.money";
import { OutboxService } from "./outbox.service";

type Row = Record<string, unknown>;

function selectChain(rows: Row[]) {
  const chain = {
    orderBy: () => chain,
    limit: () => chain,
    for: async () => rows,
  };
  return chain;
}

describe("OutboxService", () => {
  it("claim атомарно помечает старые dispatch unknown и выдаёт один pending", async () => {
    const pending = {
      id: "11111111-1111-4111-8111-111111111111",
      destination: "notion-report",
      status: "pending",
      attempts: 0,
      payload: {},
      payloadHash: hashLedgerPayload({}),
    };
    const patches: Row[] = [];
    let updateNo = 0;
    const tx = {
      select: () => ({ from: () => ({ where: () => selectChain([pending]) }) }),
      update: () => {
        updateNo += 1;
        const current = updateNo;
        return {
          set: (patch: Row) => ({
            where: (condition: unknown) => {
              patches.push(patch);
              if (current === 1) return Promise.resolve([]);
              const query = new PgDialect().sqlToQuery(
                condition as Parameters<PgDialect["sqlToQuery"]>[0],
              );
              assert.ok(query.params.includes(pending.id));
              return {
                returning: async () => [
                  { ...pending, ...patch, leaseToken: "22222222-2222-4222-8222-222222222222" },
                ],
              };
            },
          }),
        };
      },
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;

    const claimed = await new OutboxService(db).claim(
      "notion-report",
      "agents:test",
      new Date("2026-08-29T12:00:00Z"),
    );
    assert.equal(claimed?.status, "dispatching");
    assert.equal(patches[0]?.status, "unknown", "expired claim не возвращается в pending");
    assert.equal(patches[1]?.status, "dispatching");
  });

  it("не отправляет payload, изменённый после atomic commit", async () => {
    const pending = {
      id: "11111111-1111-4111-8111-111111111111",
      destination: "notion-report",
      status: "pending",
      attempts: 0,
      payload: { report: { title: "tampered" } },
      payloadHash: hashLedgerPayload({ report: { title: "original" } }),
    };
    const patches: Row[] = [];
    const tx = {
      select: () => ({ from: () => ({ where: () => selectChain([pending]) }) }),
      update: () => ({
        set: (patch: Row) => ({
          where: async () => {
            patches.push(patch);
            return [];
          },
        }),
      }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;

    assert.equal(await new OutboxService(db).claim("notion-report", "agents:test"), null);
    assert.equal(patches[1]?.status, "dead");
    assert.equal(patches[1]?.lastError, "outbox payload hash mismatch");
  });

  it("пустая очередь возвращает null без выдуманной доставки", async () => {
    const tx = {
      select: () => ({ from: () => ({ where: () => selectChain([]) }) }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    assert.equal(await new OutboxService(db).claim("notion-report", "agents:test"), null);
  });

  it("потерянный ответ terminal complete возвращает прежнюю строку", async () => {
    const existing = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "sent",
      leaseToken: "22222222-2222-4222-8222-222222222222",
      providerRef: null,
      lastError: null,
    };
    const tx = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      select: () => ({ from: () => ({ where: () => selectChain([existing]) }) }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    const completed = await new OutboxService(db).complete(
      existing.id,
      existing.leaseToken,
      "sent",
    );
    assert.equal(completed.status, "sent");
  });

  it("повтор с другим provider result не считает exact replay", async () => {
    const existing = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "sent",
      leaseToken: "22222222-2222-4222-8222-222222222222",
      providerRef: "page-1",
      lastError: null,
    };
    const tx = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      select: () => ({ from: () => ({ where: () => selectChain([existing]) }) }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;

    await assert.rejects(
      () =>
        new OutboxService(db).complete(existing.id, existing.leaseToken, "sent", {
          providerRef: "page-2",
        }),
      /завершена иначе/,
    );
  });

  it("чужой lease token не может завершить dispatch", async () => {
    const existing = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "dispatching",
      leaseToken: "22222222-2222-4222-8222-222222222222",
      providerRef: null,
      lastError: null,
    };
    const tx = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      select: () => ({ from: () => ({ where: () => selectChain([existing]) }) }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never;
    await assert.rejects(
      () =>
        new OutboxService(db).complete(existing.id, "33333333-3333-4333-8333-333333333333", "sent"),
      /другому claim/,
    );
  });
});
