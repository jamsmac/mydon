import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoreClient, PendingNotifications } from "./core-client";
import { Notifier } from "./notifier";

function stubCore(batches: PendingNotifications["notifications"][]): CoreClient {
  let call = 0;
  return {
    pendingNotifications: async (): Promise<PendingNotifications> => ({
      since: new Date().toISOString(),
      events: 0,
      notifications: batches[Math.min(call++, batches.length - 1)] ?? [],
    }),
  } as unknown as CoreClient;
}

const note = (eventId: string, ruleId: string, text: string) => ({
  eventId,
  ruleId,
  urgency: "immediate",
  text,
});

describe("Доставка срочных уведомлений", () => {
  it("отдаёт новые уведомления", async () => {
    const n = new Notifier(stubCore([[note("e1", "money.overdue", "Просрочен платёж")]]));
    assert.deepEqual(await n.collect(), ["Просрочен платёж"]);
  });

  it("НЕ дублирует одно и то же при повторном опросе", async () => {
    const same = [note("e1", "money.overdue", "Просрочен платёж")];
    const n = new Notifier(stubCore([same, same, same]));
    assert.equal((await n.collect()).length, 1);
    assert.equal((await n.collect()).length, 0, "повторная доставка недопустима");
    assert.equal((await n.collect()).length, 0);
  });

  it("различает разные правила по одному событию", async () => {
    const n = new Notifier(
      stubCore([[note("e1", "rule.a", "Первое"), note("e1", "rule.b", "Второе")]]),
    );
    assert.equal((await n.collect()).length, 2);
  });

  it("доставляет новые события после уже отправленных", async () => {
    const n = new Notifier(
      stubCore([[note("e1", "r", "Первое")], [note("e1", "r", "Первое"), note("e2", "r", "Второе")]]),
    );
    assert.deepEqual(await n.collect(), ["Первое"]);
    assert.deepEqual(await n.collect(), ["Второе"]);
  });

  it("память не растёт бесконечно", async () => {
    const n = new Notifier(stubCore([[note("e1", "r", "x")]]), new Date(), 0);
    await n.collect();
    // после сброса памяти то же уведомление считается новым — это осознанный размен
    assert.equal((await n.collect()).length, 1);
  });
});
