import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoreClient, PendingNotifications } from "./core-client";
import { Notifier, NOTIFIER_DELIVERY_BATCH, NOTIFIER_STARTUP_LOOKBACK_MS } from "./notifier";

type Batch = Pick<PendingNotifications, "notifications"> &
  Partial<Pick<PendingNotifications, "truncated" | "nextCursor">>;

/** Заглушка Core: отдаёт заготовленные партии и запоминает ack-ключи. */
function stubCore(rawBatches: (PendingNotifications["notifications"] | Batch)[]): {
  core: CoreClient;
  ackedKeys: string[];
  requestedSince: Date[];
  requestedAfter: ({ occurredAt: string; eventId: string } | undefined)[];
} {
  const batches = rawBatches.map((batch) =>
    Array.isArray(batch) ? { notifications: batch } : batch,
  );
  let call = 0;
  const ackedKeys: string[] = [];
  const requestedSince: Date[] = [];
  const requestedAfter: ({ occurredAt: string; eventId: string } | undefined)[] = [];
  const core = {
    pendingNotifications: async (
      since: Date,
      page?: { until: Date; after?: { occurredAt: string; eventId: string } },
    ): Promise<PendingNotifications> => {
      requestedSince.push(since);
      requestedAfter.push(page?.after);
      const batch = batches[Math.min(call++, batches.length - 1)] ?? { notifications: [] };
      return {
        since: since.toISOString(),
        until: (page?.until ?? new Date()).toISOString(),
        events: batch.notifications.length,
        truncated: batch.truncated ?? false,
        nextCursor: batch.nextCursor ?? null,
        notifications: batch.notifications,
      };
    },
    ackNotifications: async (keys: string[]): Promise<{ acked: number }> => {
      ackedKeys.push(...keys);
      return { acked: keys.length };
    },
  } as unknown as CoreClient;
  return { core, ackedKeys, requestedSince, requestedAfter };
}

const note = (eventId: string, ruleId: string, text: string) => ({
  eventId,
  ruleId,
  urgency: "immediate",
  text,
  occurredAt: "2026-08-31T00:00:00.000Z",
});

describe("Доставка срочных уведомлений", () => {
  it("после рестарта добирает недоставленное за семь суток", async () => {
    const before = Date.now();
    const { core, requestedSince } = stubCore([[]]);
    const notifier = new Notifier(core);
    const after = Date.now();

    await notifier.collect(new Date(after));

    assert.equal(requestedSince.length, 1);
    const actual = requestedSince[0]!.getTime();
    assert.ok(actual >= before - NOTIFIER_STARTUP_LOOKBACK_MS);
    assert.ok(actual <= after - NOTIFIER_STARTUP_LOOKBACK_MS);
  });

  it("collect отдаёт новые уведомления с ключом и текстом", async () => {
    const { core } = stubCore([[note("e1", "money.overdue", "Просрочен платёж")]]);
    const n = new Notifier(core);
    assert.deepEqual(await n.collect(), [{ key: "e1:money.overdue", text: "Просрочен платёж" }]);
  });

  it("collect НЕ отмечает доставку сам — до ack уведомление приходит снова", async () => {
    const same = [note("e1", "money.overdue", "Просрочен платёж")];
    const { core } = stubCore([same, same]);
    const n = new Notifier(core);
    assert.equal((await n.collect()).length, 1);
    // ack не звали — старый event остаётся в pending даже после движения scan cursor.
    assert.equal((await n.collect()).length, 1, "без ack сигнал не теряется");
  });

  it("после ack то же уведомление больше не отдаётся (в этой сессии)", async () => {
    const same = [note("e1", "money.overdue", "Просрочен платёж")];
    const { core, ackedKeys } = stubCore([same, same, same]);
    const n = new Notifier(core);
    const first = await n.collect();
    await n.ack(first.map((x) => x.key));
    assert.deepEqual(ackedKeys, ["e1:money.overdue"]);
    assert.equal((await n.collect()).length, 0, "после ack — не повторяем");
    assert.equal((await n.collect()).length, 0);
  });

  it("ack только доставленных: недоставленное придёт снова", async () => {
    const batch = [note("e1", "r", "Первое"), note("e2", "r", "Второе")];
    const { core } = stubCore([batch, batch]);
    const n = new Notifier(core);
    const items = await n.collect();
    // Представим, что доставилось только первое.
    await n.ack([items[0].key]);
    const again = await n.collect();
    assert.deepEqual(again, [{ key: "e2:r", text: "Второе" }], "недоставленное повторяется");
  });

  it("различает разные правила по одному событию", async () => {
    const { core } = stubCore([[note("e1", "rule.a", "Первое"), note("e1", "rule.b", "Второе")]]);
    const n = new Notifier(core);
    assert.equal((await n.collect()).length, 2);
  });

  it("truncated catch-up идёт oldest-first по cursor и не теряет recovery", async () => {
    const cursor = {
      occurredAt: "2026-08-31T10:00:00.000Z",
      eventId: "11111111-1111-4111-8111-111111111111",
    };
    const { core, requestedAfter } = stubCore([
      {
        notifications: [note(cursor.eventId, "llm.open", "🚨 open")],
        truncated: true,
        nextCursor: cursor,
      },
      {
        notifications: [
          note("22222222-2222-4222-8222-222222222222", "llm.recovered", "✅ recovered"),
        ],
      },
    ]);
    const notifier = new Notifier(core);

    const open = await notifier.collect();
    assert.deepEqual(
      open.map((item) => item.text),
      ["🚨 open"],
    );
    await notifier.ack(open.map((item) => item.key));
    const recovered = await notifier.collect();

    assert.deepEqual(
      recovered.map((item) => item.text),
      ["✅ recovered"],
    );
    assert.deepEqual(requestedAfter, [undefined, cursor]);
  });

  it("ограничивает одну Telegram-партию, сохраняя хвост без повторного scan", async () => {
    const batch = Array.from({ length: NOTIFIER_DELIVERY_BATCH + 1 }, (_, index) =>
      note(`event-${index}`, "r", `note-${index}`),
    );
    const { core, requestedSince } = stubCore([batch, []]);
    const notifier = new Notifier(core);
    const first = await notifier.collect();
    assert.equal(first.length, NOTIFIER_DELIVERY_BATCH);
    await notifier.ack(first.map((item) => item.key));
    const tail = await notifier.collect();
    assert.deepEqual(
      tail.map((item) => item.text),
      [`note-${NOTIFIER_DELIVERY_BATCH}`],
    );
    assert.equal(requestedSince.length, 2, "новые страницы сканируются без head-of-line block");
  });

  it("не растит pending без границы во время outage и не двигает durable cursor", async () => {
    const batch = Array.from({ length: NOTIFIER_DELIVERY_BATCH }, (_, index) =>
      note(`event-${index}`, "r", `note-${index}`),
    );
    const { core, requestedSince } = stubCore([batch, [note("later", "r", "later")]]);
    const notifier = new Notifier(
      core,
      new Date("2026-08-24T00:00:00.000Z"),
      NOTIFIER_DELIVERY_BATCH,
    );

    assert.equal((await notifier.collect()).length, NOTIFIER_DELIVERY_BATCH);
    assert.equal((await notifier.collect()).length, NOTIFIER_DELIVERY_BATCH);
    assert.equal(requestedSince.length, 1, "при заполненном retry buffer Core не сканируется");
  });

  it("не переставляет recovery перед не подтверждённым open между партиями", async () => {
    const batch = Array.from({ length: NOTIFIER_DELIVERY_BATCH + 1 }, (_, index) =>
      note(
        `event-${index}`,
        index === 0 ? "llm.open" : index === NOTIFIER_DELIVERY_BATCH ? "llm.recovered" : "r",
        `note-${index}`,
      ),
    );
    const { core } = stubCore([batch, []]);
    const notifier = new Notifier(core);

    const firstAttempt = await notifier.collect();
    const retryAfterFirstFailed = await notifier.collect();
    assert.equal(firstAttempt[0]?.key, "event-0:llm.open");
    assert.equal(retryAfterFirstFailed[0]?.key, "event-0:llm.open");
    assert.ok(
      retryAfterFirstFailed.every(
        (item) => item.key !== `event-${NOTIFIER_DELIVERY_BATCH}:llm.recovered`,
      ),
    );
  });

  it("ack пустого списка — без обращения к Core", async () => {
    const { core, ackedKeys } = stubCore([[]]);
    const n = new Notifier(core);
    await n.ack([]);
    assert.equal(ackedKeys.length, 0);
  });
});
