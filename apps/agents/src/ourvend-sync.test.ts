import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawMachine, RawProductSale, RawMachineSale, RawSlot, VendingConnector } from "@mydon/connectors";
import { ourvendConfigFromEnv, runOurvendSync, type SyncCoreClient } from "./ourvend-sync";

/** Стаб Core: копит вызовы, чтобы проверить, что и с каким итогом отправлено. */
function stubCore() {
  const calls = {
    starts: 0,
    ingests: [] as unknown[],
    /** Аргумент `days`, с которым звали детектор (по одному на вызов). */
    detects: [] as number[],
    sales: [] as unknown[],
    finishes: [] as unknown[],
    /** Порядок реальных вызовов Core — проверить, что детектор идёт СТРОГО после слотов. */
    order: [] as string[],
  };
  const core: SyncCoreClient = {
    startVendingSync: async () => {
      calls.starts += 1;
      calls.order.push("start");
      return { id: "run-1" };
    },
    ingestVendingSlots: async (payload) => {
      calls.ingests.push(payload);
      calls.order.push("ingest");
      const slots = payload.machines.reduce((a, m) => a + m.slots.length, 0);
      return { machines: payload.machines.length, slots };
    },
    // Дефолт: детектор молчит (0 событий) — тесты, которым важен только приём
    // слотов, могут не думать о нём. Тесты про детектор переопределяют поле.
    detectRefillEvents: async (days) => {
      calls.detects.push(days ?? -1);
      calls.order.push("detect");
      return { machines: 0, events: 0, matched: 0, skipped: [] };
    },
    ingestVendingSales: async (payload) => {
      calls.sales.push(payload);
      calls.order.push("sales");
      return { productRows: payload.productSales.length, machineRows: payload.machineSales.length };
    },
    finishVendingSync: async (id, input) => {
      calls.finishes.push({ id, ...input });
      calls.order.push("finish");
      return { ok: true };
    },
  };
  return { core, calls };
}

/** Стаб коннектора: слоты/продажи берутся из карт по serial; getSlots может бросать. */
function stubConnector(cfg: {
  machines: RawMachine[];
  slots: Record<string, RawSlot[]>;
  productSales?: Record<string, RawProductSale[]>;
  machineSales?: RawMachineSale[];
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
    getProductSales: async (serial: string): Promise<RawProductSale[]> => cfg.productSales?.[serial] ?? [],
    getMachineSales: async (): Promise<RawMachineSale[]> => cfg.machineSales ?? [],
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

  it("собирает продажи за окно: строки одного товара суммируются, продажи автоматов проходят", async () => {
    const { core, calls } = stubCore();
    const connector = stubConnector({
      machines: [{ serial: "AH", alias: "AH" }],
      slots: { AH: [slot("31", "Montella", 6, 2)] },
      // Одно имя в двух строках — коллектор обязан сложить (§3.2.3).
      productSales: { AH: [{ product: "Montella", saleNum: 4 }, { product: "Montella", saleNum: 3 }] },
      machineSales: [{ serial: "AH", totalAmount: 48000, totalCount: 7 }],
    });
    const res = await runOurvendSync(core, CFG, { connector, now: clock });

    assert.equal(res.status, "success");
    assert.equal(res.productSales, 1);
    assert.equal(calls.sales.length, 1);
    const payload = calls.sales[0] as {
      periodStart: string;
      periodEnd: string;
      productSales: { serial: string; product: string; quantity: number }[];
      machineSales: { serial: string; totalCount: number }[];
    };
    assert.deepEqual(payload.productSales, [{ serial: "AH", product: "Montella", quantity: 7 }]);
    assert.equal(payload.machineSales[0].totalCount, 7);
    // Окно — 7 суток до момента съёма.
    assert.equal(payload.periodEnd, "2026-08-02T10:00:00.000Z");
    assert.equal(payload.periodStart, "2026-07-26T10:00:00.000Z");
  });

  it("продажи упали целиком: слоты собраны, но ни строки продаж — статус honest partial, не success", async () => {
    const { core, calls } = stubCore();
    const connector: VendingConnector = {
      login: async () => {},
      listMachines: async () => [{ serial: "AH", alias: "AH" }],
      getSlots: async () => [slot("31", "Montella", 6, 2)],
      getProductSales: async () => {
        // AbortError — типичная причина обрыва похода за продажами (таймаут).
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        throw e;
      },
      getMachineSales: async () => [],
    };
    const res = await runOurvendSync(core, CFG, { connector, now: clock });
    // Планограмма снята полностью, но окно продаж пустое — статус больше не
    // врёт «success»: владелец должен видеть, что продажи не обновились.
    assert.equal(res.status, "partial");
    assert.ok(res.machinesOk > 0);
    assert.equal(res.productSales, 0);
    assert.equal(calls.sales.length, 0);
    assert.match(String(res.error), /продажи/);
    assert.match(String((calls.finishes[0] as { error?: string }).error), /продажи AH/);
  });

  it("детектор заливок падает — сбор всё равно success, итог помечен detect: \"failed\"", async () => {
    const { core, calls } = stubCore();
    core.detectRefillEvents = async (days) => {
      calls.detects.push(days ?? -1);
      calls.order.push("detect");
      throw new Error("детектор недоступен");
    };
    const connector = stubConnector({
      machines: [{ serial: "AH", alias: "AH" }],
      slots: { AH: [slot("31", "Montella", 6, 2)] },
    });
    const res = await runOurvendSync(core, CFG, { connector, now: clock });

    assert.equal(res.status, "success"); // сбой детектора не роняет сбор
    assert.equal(res.detect, "failed");
    // Ошибка детектора не отправляется в Core как ошибка сбора продаж/слотов.
    assert.equal((calls.finishes[0] as { error?: string }).error, undefined);
    assert.equal((calls.finishes[0] as Record<string, unknown>).detect, undefined);
  });

  it("детектор заливок отрабатывает после слотов ровно один раз, итог попадает в detect", async () => {
    const { core, calls } = stubCore();
    core.detectRefillEvents = async (days) => {
      calls.detects.push(days ?? -1);
      calls.order.push("detect");
      return { machines: 2, events: 3, matched: 2, skipped: [] };
    };
    const connector = stubConnector({
      machines: [{ serial: "AH", alias: "AH" }],
      slots: { AH: [slot("31", "Montella", 6, 2)] },
    });
    const res = await runOurvendSync(core, CFG, { connector, now: clock });

    assert.deepEqual(res.detect, { events: 3, matched: 2 });
    assert.equal(calls.detects.length, 1);
    assert.equal(calls.detects[0], 1); // days=1, как договорено для агента
    // Детектор должен идти строго после приёма слотов.
    const ingestAt = calls.order.indexOf("ingest");
    const detectAt = calls.order.indexOf("detect");
    assert.ok(ingestAt >= 0 && detectAt > ingestAt);
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

  it("пустая OURVEND_GROUP_ID — это «не задана», а не пустая группа", () => {
    // docker compose подставляет пустую строку для незаданной переменной
    // (`${OURVEND_GROUP_ID:-}`). С `??` дефолт бы не применился, и сбор пошёл
    // бы в несуществующую группу.
    const c = ourvendConfigFromEnv({
      OURVEND_ACCOUNT: "a",
      OURVEND_PASSWORD: "p",
      OURVEND_GROUP_ID: "",
    } as NodeJS.ProcessEnv);
    assert.equal(c?.groupId, "729db8bd-02f5-49b9-bccb-53477e396a08");
  });

  it("пустые учётка и пароль равны отсутствующим", () => {
    // Та же причина: в контейнере переменная всегда есть, вопрос лишь в том,
    // пустая она или нет. Пустая обязана означать «сбор выключен».
    assert.equal(
      ourvendConfigFromEnv({ OURVEND_ACCOUNT: "", OURVEND_PASSWORD: "" } as NodeJS.ProcessEnv),
      null,
    );
    assert.equal(
      ourvendConfigFromEnv({ OURVEND_ACCOUNT: "a", OURVEND_PASSWORD: "" } as NodeJS.ProcessEnv),
      null,
    );
  });
});
