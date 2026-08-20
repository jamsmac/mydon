import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderIsCountable, orderIsDelivered, orderIsPaid } from "./coffee-order";

describe("Что считать продажей кофе", () => {
  it("оба словаря источника читаются одинаково", () => {
    // Прямой сбор из API отдаёт коды, выгрузка из интерфейса — подписи.
    assert.ok(orderIsCountable({ paymentStatus: "paid", orderResource: "cash" }));
    assert.ok(orderIsCountable({ paymentStatus: "Paid", orderResource: "Cash payment" }));
    assert.ok(orderIsCountable({ paymentStatus: "paid", orderResource: "userDefined" }));
    assert.ok(orderIsCountable({ paymentStatus: "Paid", orderResource: "Custom payment" }));
  });

  it("тестовая выдача не продажа — ни кодом, ни подписью", () => {
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "testShipment" }));
    assert.ok(!orderIsCountable({ paymentStatus: "Paid", orderResource: "测试出货" }));
  });

  it("vip и ручная выдача не продажа: чашка ушла, денег не было", () => {
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "vip" }));
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "send" }));
  });

  it("возврат не продажа", () => {
    assert.ok(!orderIsCountable({ paymentStatus: "returned", orderResource: "cash" }));
    assert.ok(!orderIsCountable({ paymentStatus: "Refunded", orderResource: "Cash payment" }));
  });

  it("продажа в долг — продажа: чашка отдана, деньги ожидаются", () => {
    assert.ok(orderIsCountable({ paymentStatus: "paid", orderResource: "credit" }));
  });

  it("отказ выдачи НЕ отменяет продажу — деньги взяты", () => {
    const отказ = { paymentStatus: "Paid", orderResource: "Cash payment", brewStatus: "Delivery failure" };
    assert.ok(orderIsCountable(отказ), "в выручке остаётся");
    assert.ok(!orderIsDelivered(отказ), "но сырьё по нему не расходовалось");
  });

  it("выдача читается и кодом, и подписью", () => {
    assert.ok(orderIsDelivered({ brewStatus: "2" }));
    assert.ok(orderIsDelivered({ brewStatus: "Delivered" }));
    assert.ok(!orderIsDelivered({ brewStatus: "0" }));
    assert.ok(!orderIsDelivered({ brewStatus: "Not delivered" }));
  });

  it("пустые значения не считаются оплатой", () => {
    assert.ok(!orderIsPaid({}));
    assert.ok(!orderIsCountable({ orderResource: "cash" }));
  });
});
