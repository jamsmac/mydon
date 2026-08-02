import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawMachine, RawProductSale, RawMachineSale, RawSlot, VendingConnector } from "@mydon/connectors";
import { ourvendConfigFromEnv, runOurvendSync, type SyncCoreClient } from "./ourvend-sync";

/** Стаб Core: копит вызовы, чтобы проверить, что и с каким итогом отправлено. */
function stubCore() {
  const calls = { starts: 0, ingests: [] as unknown[], finishes: [] as unknown[] };
  const core: SyncCoreClient = {
    startVendingSync: async () => {
      calls.starts += 1;
      return { id: "run-1" };
    },
    ingestVendingSlots: async (payload) => {
      calls.ingests.push(payload);
      const slots = payload.machines.reduce((a, m) => a + m.slots.length, 0);
      return { machines: payload.machines.length, slots };
    },
    finishVendingSync: async (id, input) => {
      calls.finishes.push({ id, ...input });
      return { ok: true };
    },
  };
  return { core, calls };
}

/** Стаб коннектора: слоты берутся из карты serial→slots; getSlots может бросать. */
function stubConnector(cfg: {
  machines: RawMachine[];
  slots: Record<string, RawSlot[]>;
  throwOn?: Set<string>;
  loginThrows?: boolean;
  listThrows?: boolean;
}): VendingConnector {
  return {
    login: async () => {
      if (cfg.loginThrows) throw new Error("вход не удался");
    },
    listMachines: async (): Promise<RawMachine[]> => {
      if (cfg.listThrows) throw new Error("список не получен");
      return cfg.machines;
    },
    getSlots: async (serial: string): Promise<RawSlot[]> => {
      if (cfg.throwOn?.has(serial)) throw new Error(`слоты ${serial} не пришли`);
      return cfg.slots[serial] ?? [];
    },
    getProductSales: async (): Promise<RawProductSale[]> => [],
    getMachineSales: async (): Promise<RawMachineSale[]> => [],
  };
}

const slot = (coilId: string, product: string, capacity: number, quantity: number): RawSlot => ({ coilId, product, capacity, quantity });
const clock = () => new Date("2026-08-02T10:00:00.000Z");
const CFG = { account: "acc", password: "pwd", groupId: "grp" };

describe("ourvend:sync — коллектор вендинга", () => {
  it("успешный сбор: все автоматы собраны, слоты отданы в Core, итог success", async () => {
    const { core, calls } = stubCore();
    const connector = stubConnector({
      machines: [
        { serial: "AH", alias: "Автомат AH" },
        { serial: "Olma", alias: "Olma" },
      ],
      slots: { AH: [slot("31", "Montella", 6, 0)], Olma: [slot("40", "Fanta", 6, 3), slot("41", "", 0, 0)] },
    });
    const res = await runOurvendSync(core, CFG, { connector, now: clock });

    assert.equal(res.status, "success");
    assert.equal(res.machinesTotal, 2);
    assert.equal(res.machinesOk, 2);
    assert.equal(res.slots, 3);
    assert.equal(calls.starts, 1);
    assert.equal(calls.ingests.length, 1);
    // Итог зафиксирован в журнал ровно один раз, с тем же id.
    assert.equal(calls.finishes.length, 1);
    assert.deepEqual(
      (calls.finishes[0] as { id: string; status: string }).id,
      "run-1",
    );
    assert.equal((calls.finishes[0] as { status: string }).status, "success");
    // capturedAt проставлен из часов.
    assert.equal((calls.ingests[0] as { capturedAt: string }).capturedAt, "2026-08-02T10:00:00.000Z");
  });

  it("частичный сбой: один автомат без слотов → partial, остальные всё равно в базе", async () => {
    const { core, calls } = stubCore();
    const connector = stubConnector({
      machines: [
        { serial: "AH", alias: "AH" },
        { serial: "BAD", alias: "BAD" },
      ],
      slots: { AH: [slot("31", "Montella", 6, 0)] },
      throwOn: new Set(["BAD"]),
    });
    const res = await runOurvendSync(core, CFG, { connector, now: clock });

    assert.equal(res.status, "partial");
    assert.equal(res.machinesTotal, 2);
    assert.equal(res.machinesOk, 1);
    assert.equal(res.slots, 1);
    // Ингест ушёл только по успешному автомату.
    const payload = calls.ingests[0] as { machines: { serial: string }[] };
    assert.equal(payload.machines.length, 1);
    assert.equal(payload.machines[0].serial, "AH");
    assert.match(String((calls.finishes[0] as { error?: string }).error), /BAD/);
  });

  it("провал логина → failed, ничего не отдаём в приём", async () => {
    const { core, calls } = stubCore();
    const connector = stubConnector({ machines: [], slots: {}, loginThrows: true });
    const res = await runOurvendSync(core, CFG, { connector, now: clock });

    assert.equal(res.status, "failed");
    assert.equal(res.machinesTotal, 0);
    assert.equal(calls.ingests.length, 0);
    assert.equal((calls.finishes[0] as { status: string }).status, "failed");
    assert.match(String((calls.finishes[0] as { error?: string }).error), /вход/);
  });

  it("все автоматы без слотов → failed", async () => {
    const { core } = stubCore();
    const connector = stubConnector({
      machines: [{ serial: "A", alias: "A" }],
      slots: {},
      throwOn: new Set(["A"]),
    });
    const res = await runOurvendSync(core, CFG, { connector, now: clock });
    assert.equal(res.status, "failed");
    assert.equal(res.machinesOk, 0);
  });
});

describe("ourvend:sync — конфиг из окружения", () => {
  it("нет учётки или пароля → null (сбор выключен)", () => {
    assert.equal(ourvendConfigFromEnv({} as NodeJS.ProcessEnv), null);
    assert.equal(ourvendConfigFromEnv({ OURVEND_ACCOUNT: "a" } as NodeJS.ProcessEnv), null);
    assert.equal(ourvendConfigFromEnv({ OURVEND_PASSWORD: "p" } as NodeJS.ProcessEnv), null);
  });

  it("учётка+пароль → конфиг; группа по умолчанию, если не задана", () => {
    const c = ourvendConfigFromEnv({ OURVEND_ACCOUNT: "a", OURVEND_PASSWORD: "p" } as NodeJS.ProcessEnv);
    assert.ok(c);
    assert.equal(c.account, "a");
    assert.equal(c.groupId, "729db8bd-02f5-49b9-bccb-53477e396a08");
  });

  it("группа переопределяется OURVEND_GROUP_ID", () => {
    const c = ourvendConfigFromEnv({ OURVEND_ACCOUNT: "a", OURVEND_PASSWORD: "p", OURVEND_GROUP_ID: "xyz" } as NodeJS.ProcessEnv);
    assert.equal(c?.groupId, "xyz");
  });
});
