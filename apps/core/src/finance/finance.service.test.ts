import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FinanceService } from "./finance.service";

/**
 * Валидация ввода денег: кривые данные отбиваются ДО похода в базу.
 * Заглушка БД взрывается при любом обращении — так проверяется, что
 * отказ происходит на границе, а не после частичной записи.
 */
function explodingDb(): never {
  throw new Error("до базы дойти не должно");
}
const db = new Proxy(
  {},
  {
    get: () => explodingDb,
  },
) as never;

const service = new FinanceService(db);

describe("FinanceService.createFlow — валидация до базы", () => {
  const base = {
    domain: "globerent" as const,
    direction: "in" as const,
    status: "planned" as const,
    amount: 100,
  };

  it("отбивает нулевую и отрицательную сумму", async () => {
    await assert.rejects(() => service.createFlow({ ...base, amount: 0 }), /положительное число/);
    await assert.rejects(() => service.createFlow({ ...base, amount: -5 }), /положительное число/);
  });

  it("отбивает кривую валюту", async () => {
    await assert.rejects(() => service.createFlow({ ...base, currency: "сум" }), /трёхбуквенный код/);
  });

  it("отбивает категорию вне словаря", async () => {
    await assert.rejects(
      () => service.createFlow({ ...base, category: "чебурек" }),
      /Категория — одна из/,
    );
  });

  it("отбивает кривой срок оплаты", async () => {
    await assert.rejects(() => service.createFlow({ ...base, dueDate: "31.12.2026" }), /ГГГГ-ММ-ДД/);
  });

  it("отбивает нулевой курс", async () => {
    await assert.rejects(() => service.createFlow({ ...base, rate: 0 }), /Курс — положительное число/);
  });
});

describe("FinanceService.setFx — валидация до базы", () => {
  it("отбивает кривой код валюты и попытку задать курс сума", async () => {
    await assert.rejects(() => service.setFx({ currency: "доллар", rate: 12500 }), /трёхбуквенный код/);
    await assert.rejects(() => service.setFx({ currency: "UZS", rate: 1 }), /всегда 1/);
  });
  it("отбивает нулевой курс", async () => {
    await assert.rejects(() => service.setFx({ currency: "USD", rate: 0 }), /положительное число/);
  });
});

describe("FinanceService.markPaid — валидация до базы", () => {
  it("отбивает кривой курс", async () => {
    await assert.rejects(() => service.markPaid("id", { rate: -1 }), /Курс — положительное число/);
  });
});
