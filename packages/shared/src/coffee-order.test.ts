import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderIsCash, orderIsCountable, orderIsDelivered, orderIsPaid } from "./coffee-order";

describe("Что считать продажей кофе", () => {
  it("оба словаря источника читаются одинаково", () => {
    // Прямой сбор из API отдаёт коды, выгрузка из интерфейса — подписи.
    assert.ok(orderIsCountable({ paymentStatus: "paid", orderResource: "cash", amount: 15000 }));
    assert.ok(orderIsCountable({ paymentStatus: "Paid", orderResource: "Cash payment", amount: 15000 }));
    assert.ok(orderIsCountable({ paymentStatus: "paid", orderResource: "userDefined", amount: "25000.00" }));
    assert.ok(orderIsCountable({ paymentStatus: "Paid", orderResource: "Custom payment", amount: 25000 }));
  });

  it("тестовая выдача не продажа — ни кодом, ни подписью, ни с ценой", () => {
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "testShipment", amount: 15000 }));
    assert.ok(!orderIsCountable({ paymentStatus: "Paid", orderResource: "测试出货", amount: 15000 }));
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "send", amount: 15000 }));
  });

  it("vip с ценой — ПРОДАЖА: это платёжный канал, а не комплимент", () => {
    // 2693 из 2704 оплаченных vip-заказов оплачены на полную цену.
    // Выкинуть их значило потерять 43 млн сум выручки и получить
    // необъяснимую «недостачу» сырья на эти чашки.
    assert.ok(orderIsCountable({ paymentStatus: "paid", orderResource: "vip", amount: 25000 }));
  });

  it("бесплатную выдачу делает нулевая цена, а не ярлык канала", () => {
    // vip-комплимент (11 строк) и cash0 (142 чашки) — оплачено, цена 0.
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "vip", amount: 0 }));
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "cash0", amount: 0 }));
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "cash", amount: 0 }));
  });

  it("возврат не продажа", () => {
    assert.ok(!orderIsCountable({ paymentStatus: "returned", orderResource: "cash", amount: 15000 }));
    assert.ok(!orderIsCountable({ paymentStatus: "Refunded", orderResource: "Cash payment", amount: 15000 }));
  });

  it("продажа в долг — продажа: чашка отдана, деньги ожидаются", () => {
    assert.ok(orderIsCountable({ paymentStatus: "paid", orderResource: "credit", amount: 15000 }));
  });

  it("отказ выдачи НЕ отменяет продажу — деньги взяты", () => {
    const отказ = {
      paymentStatus: "Paid",
      orderResource: "Cash payment",
      brewStatus: "Delivery failure",
      amount: 15000,
    };
    assert.ok(orderIsCountable(отказ), "в выручке остаётся");
    assert.ok(!orderIsDelivered(отказ), "но сырьё по нему не расходовалось");
  });

  it("выдача читается кодами 2 и 10 и обеими подписями", () => {
    assert.ok(orderIsDelivered({ brewStatus: "2" }));
    assert.ok(orderIsDelivered({ brewStatus: "10" }));
    assert.ok(orderIsDelivered({ brewStatus: "Delivered" }));
    assert.ok(orderIsDelivered({ brewStatus: "Delivery confirmed" }));
    assert.ok(!orderIsDelivered({ brewStatus: "0" }));
    assert.ok(!orderIsDelivered({ brewStatus: "1" }));
    assert.ok(!orderIsDelivered({ brewStatus: "11" }));
    assert.ok(!orderIsDelivered({ brewStatus: "Not delivered" }));
    assert.ok(!orderIsDelivered({ brewStatus: "In delivering" }));
  });

  it("пустые значения не считаются оплатой и продажей", () => {
    assert.ok(!orderIsPaid({}));
    assert.ok(!orderIsCountable({ orderResource: "cash", amount: 15000 }));
    assert.ok(!orderIsCountable({ paymentStatus: "paid", orderResource: "cash" }), "без суммы продажи нет");
  });
});

describe("orderIsCash — наличный канал (ревью I3)", () => {
  it("cash, cash0, cash payment, credit — наличные, регистронезависимо", () => {
    assert.ok(orderIsCash({ orderResource: "cash" }));
    assert.ok(orderIsCash({ orderResource: "cash0" }));
    assert.ok(orderIsCash({ orderResource: "cash payment" }));
    assert.ok(orderIsCash({ orderResource: "Cash payment" }));
    assert.ok(orderIsCash({ orderResource: "credit" }));
    assert.ok(orderIsCash({ orderResource: "CASH" }));
    assert.ok(orderIsCash({ orderResource: "Cash0" }));
    assert.ok(orderIsCash({ orderResource: "CREDIT" }));
  });

  it("vip — платёжная карта, НЕ наличные", () => {
    assert.ok(!orderIsCash({ orderResource: "vip" }));
    assert.ok(!orderIsCash({ orderResource: "VIP" }));
  });

  it("userDefined / Custom payment — безнал, НЕ наличные", () => {
    assert.ok(!orderIsCash({ orderResource: "userDefined" }));
    assert.ok(!orderIsCash({ orderResource: "Custom payment" }));
  });

  it("прочие/пустые каналы — не наличные", () => {
    assert.ok(!orderIsCash({ orderResource: "testShipment" }));
    assert.ok(!orderIsCash({ orderResource: "send" }));
    assert.ok(!orderIsCash({}));
    assert.ok(!orderIsCash({ orderResource: null }));
  });
});
