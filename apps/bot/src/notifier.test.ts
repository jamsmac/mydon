import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoreClient, PendingNotifications } from "./core-client";
import { Notifier } from "./notifier";

/** Заглушка Core: отдаёт заготовленные партии и запоминает ack-ключи. */
function stubCore(batches: PendingNotifications["notifications"][]): {
  core: CoreClient;
  ackedKeys: string[];
} {
  let call = 0;
  const ackedKeys: string[] = [];
  const core = {
    pendingNotifications: async (): Promise<PendingNotifications> => ({
      since: new Date().toISOString(),
      events: 0,
      notifications: batches[Math.min(call++, batches.length - 1)] ?? [],
    }),
    ackNotifications: async (keys: string[]): Promise<{ acked: number }> => {
      ackedKeys.push(...keys);
      return { acked: keys.length };
    },
  } as unknown as CoreClient;
  return { core, ackedKeys };
}

const note = (eventId: string, ruleId: string, text: string) => ({
  eventId,
  ruleId,
  urgency: "immediate",
  text,
});

describe("Доставка срочных уведомлений", () => {
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
    // ack не звали — Core (заглушка) снова отдаёт то же, и оно НЕ подавлено.
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

  it("ack пустого списка — без обращения к Core", async () => {
    const { core, ackedKeys } = stubCore([[]]);
    const n = new Notifier(core);
    await n.ack([]);
    assert.equal(ackedKeys.length, 0);
  });
});
