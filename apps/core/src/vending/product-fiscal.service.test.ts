import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { auditLog, event, vendingProduct } from "@mydon/db";
import { ProductFiscalService } from "./product-fiscal.service";

const КАРТОЧКА = {
  id: "p-lit",
  name: "Lit Energy Blueberry CAN 0,45",
  ikpu: null as string | null,
  mxik: null as string | null,
  vatPct: 12,
  barcode: null as string | null,
  packageCode: "796",
  marked: false,
};

function стенд(строка: typeof КАРТОЧКА | null = КАРТОЧКА) {
  const записи: { таблица: unknown; values: Record<string, unknown> }[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ for: async () => (строка ? [строка] : []) }),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          записи.push({ таблица: table, values: patch });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        записи.push({ таблица: table, values });
      },
    }),
  };
  const db = {
    transaction: async (fn: (handle: typeof tx) => Promise<void>) => {
      return fn(tx);
    },
    insert: () => {
      throw new Error("аудит обязан писаться внутри транзакции, а не своим хендлом");
    },
  } as never;
  return { db, записи };
}

const МОМЕНТ = new Date("2026-08-26T09:00:00.000Z");

describe("Фискальный блок карточки: единственный писатель (П6, R-P6-5)", () => {
  it("пустой патч — отказ 400, а не молчаливое «ок»", async () => {
    const { db, записи } = стенд();
    await assert.rejects(
      () => new ProductFiscalService(db).update("p-lit", {}, "panel", МОМЕНТ),
      (error: unknown) => error instanceof BadRequestException,
    );
    assert.equal(записи.length, 0, "пустой патч не имеет права дойти до базы");
  });

  it("неверное значение — reason «invalid» с русским текстом, а не 500", async () => {
    const { db, записи } = стенд();
    const итог = await new ProductFiscalService(db).update(
      "p-lit",
      { ikpu: "2202002001010032" },
      "panel",
      МОМЕНТ,
    );
    assert.deepEqual(итог, {
      ok: false,
      reason: "invalid",
      errors: ["ИКПУ должен быть 17 цифр или пусто"],
    });
    assert.equal(записи.length, 0);
  });

  it("неизвестный productId — not_found, а не 500", async () => {
    const { db } = стенд(null);
    assert.deepEqual(await new ProductFiscalService(db).update("нет", { vatPct: 0 }, "panel", МОМЕНТ), {
      ok: false,
      reason: "not_found",
    });
  });

  it("before/after в аудите — весь блок из шести полей", async () => {
    const { db, записи } = стенд();
    await new ProductFiscalService(db).update("p-lit", { ikpu: "02202003001086002" }, "panel", МОМЕНТ);
    const аудит = записи.find((entry) => entry.таблица === auditLog)!;
    const ПОЛЯ = ["ikpu", "mxik", "vatPct", "barcode", "packageCode", "marked"];
    assert.deepEqual(Object.keys(аудит.values.before as object).sort(), [...ПОЛЯ].sort());
    assert.deepEqual(Object.keys(аудит.values.after as object).sort(), [...ПОЛЯ].sort());
    assert.equal((аудит.values.after as { packageCode: string }).packageCode, "796");
  });

  it("action и target названы так, как их будут искать в /audit", async () => {
    const { db, записи } = стенд();
    await new ProductFiscalService(db).update("p-lit", { marked: true }, "person:u1", МОМЕНТ);
    const аудит = записи.find((entry) => entry.таблица === auditLog)!;
    assert.equal(аудит.values.action, "vending.product.set_fiscal");
    assert.equal(аудит.values.target, "p-lit");
    assert.equal(аудит.values.actorRef, "person:u1");
    assert.equal(аудит.values.actorKind, "human");
  });

  it("update, событие и аудит уходят в одной транзакции и в этом порядке", async () => {
    const { db, записи } = стенд();
    await new ProductFiscalService(db).update("p-lit", { vatPct: 0 }, "panel", МОМЕНТ);
    assert.deepEqual(
      записи.map((entry) => entry.таблица),
      [vendingProduct, event, auditLog],
    );
  });

  it("readyBefore/readyAfter считаются по блоку до и после правки", async () => {
    const { db, записи } = стенд();
    const итог = await new ProductFiscalService(db).update(
      "p-lit",
      { ikpu: "02202003001086002" },
      "panel",
      МОМЕНТ,
    );
    assert.equal(итог.ok, true);
    assert.equal((итог as { readyBefore: boolean }).readyBefore, false);
    assert.equal((итог as { readyAfter: boolean }).readyAfter, true);
    const событие = записи.find((entry) => entry.таблица === event)!;
    assert.equal((событие.values.payload as { readyAfter: boolean }).readyAfter, true);
    assert.equal(событие.values.type, "vending.product_fiscal_changed");
  });

  it("null в ИКПУ очищает поле, отсутствие ключа не трогает штрихкод", async () => {
    const { db, записи } = стенд({
      ...КАРТОЧКА,
      ikpu: "02202003001086002",
      barcode: "4870204391234",
    });
    await new ProductFiscalService(db).update("p-lit", { ikpu: null }, "panel", МОМЕНТ);
    const update = записи.find((entry) => entry.таблица === vendingProduct)!;
    assert.equal(update.values.ikpu, null);
    assert.ok(!("barcode" in update.values));
  });

  it("ключ со значением undefined не затирает полный after", async () => {
    const { db, записи } = стенд({ ...КАРТОЧКА, barcode: "4870204391234" });
    await new ProductFiscalService(db).update(
      "p-lit",
      { marked: true, barcode: undefined },
      "panel",
      МОМЕНТ,
    );
    const аудит = записи.find((entry) => entry.таблица === auditLog)!;
    assert.equal((аудит.values.after as { barcode: string }).barcode, "4870204391234");
  });

  it("`now` берётся из параметра", async () => {
    const { db, записи } = стенд();
    await new ProductFiscalService(db).update("p-lit", { marked: true }, "panel", МОМЕНТ);
    assert.equal((записи[0].values as { updatedAt: Date }).updatedAt.toISOString(), МОМЕНТ.toISOString());
  });
});
