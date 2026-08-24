import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendingOrder, VendingPurchase, VendingPurchaseItem } from "./core-client";
import {
  formatPriceResult,
  formatPurchaseBrief,
  formatPurchaseOrders,
  formatPurchaseSubmitAck,
  formatReceiveOrderAck,
  isPriceCommand,
  isPurchaseOrdersQuery,
  isPurchaseReceiveCommand,
  isPurchaseSubmitCommand,
  parsePriceCommand,
  parseReceiveDistribution,
  pickReceiptOrder,
} from "./purchase-brief";

const item = (o: Partial<VendingPurchaseItem> & { product: string }): VendingPurchaseItem => ({
  need: 0,
  buy: 0,
  pack: 1,
  order: 0,
  price: 0,
  costRounded: 0,
  noPrice: false,
  noSales: false,
  ...o,
});

const base = (o: Partial<VendingPurchase> = {}): VendingPurchase => ({
  items: [],
  excludedNoSales: [],
  noPrice: [],
  totalBuy: 0,
  totalOrder: 0,
  costExact: 0,
  costRounded: 0,
  overpay: 0,
  ...o,
});

describe("Брифинг закупа (Telegram)", () => {
  it("пусто везде — «закупать нечего»", () => {
    const t = formatPurchaseBrief(base());
    assert.match(t, /нечего/i);
  });

  it("итог, переплата и топ по стоимости", () => {
    const p = base({
      items: [
        item({ product: "Montella", buy: 4, order: 12, costRounded: 60000 }),
        item({ product: "Fanta", buy: 2, order: 12, costRounded: 24000 }),
      ],
      totalBuy: 6,
      totalOrder: 24,
      costRounded: 84000,
      overpay: 40000,
    });
    const t = formatPurchaseBrief(p);
    assert.match(t, /Купить 6 ед/);
    assert.match(t, /с упаковками 24 ед/);
    assert.match(t, /84\s?000 сум/);
    assert.match(t, /Переплата за упаковки: 40\s?000 сум/);
    // Топ по costRounded: Montella (60k) раньше Fanta (24k).
    assert.ok(t.indexOf("Montella") < t.indexOf("Fanta"));
    assert.match(t, /Montella — заказать 12 \(нехватка 4\)/);
  });

  it("без цены и без продаж — отдельными строками, не в закупе", () => {
    const p = base({
      items: [item({ product: "NoPrice", buy: 3, order: 3, noPrice: true })],
      excludedNoSales: [item({ product: "Dead", noSales: true })],
      noPrice: ["NoPrice"],
      totalBuy: 3,
      totalOrder: 3,
    });
    const t = formatPurchaseBrief(p);
    assert.match(t, /Без цены — на разбор: NoPrice/);
    assert.match(t, /Не закупать \(нет продаж\): Dead/);
    // У позиции без цены сумма не выдумывается.
    assert.match(t, /NoPrice — заказать 3 \(нехватка 3\) · нет цены/);
  });

  it("больше топа — сворачивает хвост в «…и ещё N»", () => {
    const items = Array.from({ length: 13 }, (_, i) =>
      item({ product: `P${i}`, buy: 1, order: 1, costRounded: 13 - i }),
    );
    const t = formatPurchaseBrief(base({ items, totalBuy: 13, totalOrder: 13, costRounded: 91 }));
    assert.match(t, /…и ещё 3/);
  });
});

describe("Оформление закупа: команда и подтверждение (§5.7)", () => {
  it("«оформить закуп» — команда submit, «закуп»/«что заказать» — нет", () => {
    assert.equal(isPurchaseSubmitCommand("оформить закуп"), true);
    assert.equal(isPurchaseSubmitCommand("отправь закуп на утверждение"), true);
    assert.equal(isPurchaseSubmitCommand("заявка на закуп"), true);
    assert.equal(isPurchaseSubmitCommand("согласуй заказ"), true);
    // Брифинг закупа — не submit.
    assert.equal(isPurchaseSubmitCommand("закуп"), false);
    assert.equal(isPurchaseSubmitCommand("что заказать"), false);
  });

  it("подтверждение отправки перечисляет позиции, сумму и куда смотреть", () => {
    const t = formatPurchaseSubmitAck({ submitted: true, positions: 3, costRounded: 84000 });
    assert.match(t, /отправлена на утверждение/);
    assert.match(t, /Позиций: 3/);
    assert.match(t, /84\s?000 сум/);
    assert.match(t, /согласования/);
  });

  it("нечего отправлять — показывает причину, без шума", () => {
    const t = formatPurchaseSubmitAck({ submitted: false, positions: 0, costRounded: 0, reason: "Закупать нечего." });
    assert.match(t, /нечего/i);
  });
});

describe("Накладные закупа: запрос и список (§5.7)", () => {
  const order = (o: Partial<VendingOrder> = {}): VendingOrder => ({
    id: "o1",
    approvalId: "a1",
    status: "approved",
    positions: 3,
    totalOrder: 24,
    costRounded: 84000,
    createdBy: "owner",
    createdAt: "2026-08-02T10:00:00Z",
    ...o,
  });

  it("«накладные» / «история закупа» — запрос списка, «закуп» — нет", () => {
    assert.equal(isPurchaseOrdersQuery("накладные"), true);
    assert.equal(isPurchaseOrdersQuery("история закупа"), true);
    assert.equal(isPurchaseOrdersQuery("закуп"), false);
    assert.equal(isPurchaseOrdersQuery("оформить закуп"), false);
  });

  it("пусто — подсказывает оформить закуп", () => {
    assert.match(formatPurchaseOrders([]), /Накладных закупа пока нет/);
  });

  it("список показывает позиции, сумму и статус по-русски", () => {
    const t = formatPurchaseOrders([order(), order({ id: "o2", status: "received", positions: 1, costRounded: 5000 })]);
    assert.match(t, /Накладные закупа:/);
    assert.match(t, /3 поз., ~84\s?000 сум \(одобрена\)/);
    assert.match(t, /1 поз., ~5\s?000 сум \(принята\)/);
  });
});

describe("Приёмка накладной: команда и подтверждение (§5.7)", () => {
  it("«принять закуп»/«накладная принята» — команда приёмки; «накладные» — нет", () => {
    assert.equal(isPurchaseReceiveCommand("принять закуп"), true);
    assert.equal(isPurchaseReceiveCommand("накладная принята"), true);
    assert.equal(isPurchaseReceiveCommand("принял товар"), true);
    // Просмотр списка — не приёмка.
    assert.equal(isPurchaseReceiveCommand("накладные"), false);
    assert.equal(isPurchaseReceiveCommand("оформить закуп"), false);
  });

  it("отрицание перед глаголом — это НЕ приёмка (найдено адверсариал-ревью)", () => {
    assert.equal(isPurchaseReceiveCommand("ещё не принял закуп, жду курьера"), false);
    assert.equal(isPurchaseReceiveCommand("не получил товар"), false);
    assert.equal(isPurchaseReceiveCommand("пока не принят закуп"), false);
    // Отрицание не по глаголу приёмки — не должно гасить настоящую команду.
    assert.equal(isPurchaseReceiveCommand("товар не бракованный, принял накладную"), true);
  });

  it("подтверждение приёмки: позиции, единицы и подсказка пересчёта", () => {
    const t = formatReceiveOrderAck({ received: true, replenished: 2, units: 24 });
    assert.match(t, /принята на склад/);
    assert.match(t, /Зачислено на склад: 24 ед\. \(2 поз\.\)/);
    assert.match(t, /что заказать/);
    assert.doesNotMatch(t, /Распределено/); // без distributedUnits — блока нет
    assert.doesNotMatch(t, /Журнал прихода/); // без recordedPurchases — строки нет
  });

  it("мост П3 в ack: журнал прихода и подсказка про чек", () => {
    const t = formatReceiveOrderAck({ received: true, replenished: 2, units: 24, recordedPurchases: 3 });
    assert.match(t, /Журнал прихода: 3 поз\./);
    assert.match(t, /подписью «чек»/);
  });

  it("нечего принимать — показывает причину", () => {
    const t = formatReceiveOrderAck({ received: false, replenished: 0, units: 0, reason: "Непринятых накладных нет." });
    assert.match(t, /Непринятых накладных нет/);
  });

  it("с распределением по автоматам — отдельная строка (§5.7)", () => {
    const t = formatReceiveOrderAck({ received: true, replenished: 1, units: 5, distributedUnits: 5 });
    assert.match(t, /Зачислено на склад: 5 ед\. \(1 поз\.\)/);
    assert.match(t, /Распределено по автоматам: 5 ед\./);
  });

  it("несовпавшее распределение — предупреждение, а не тишина (найдено адверсариал-ревью)", () => {
    const t = formatReceiveOrderAck({
      received: true,
      replenished: 1,
      units: 10,
      distributedUnits: 0,
      unmatchedDistribution: ["Flint"],
    });
    assert.match(t, /Не найдено в накладной \(ушло на склад\): Flint/);
  });

  it("parseReceiveDistribution: пары после первого двоеточия, без двоеточия — undefined", () => {
    assert.deepEqual(parseReceiveDistribution("принять закуп: TUC 5, Flint 5"), { TUC: 5, Flint: 5 });
    assert.equal(parseReceiveDistribution("принять закуп"), undefined);
    assert.equal(parseReceiveDistribution("принять закуп: "), undefined); // двоеточие есть, пар нет
  });

  it("parseReceiveDistribution: двоеточие с текстом без чисел — безопасный undefined", () => {
    assert.equal(parseReceiveDistribution("накладная принята: спасибо"), undefined);
  });

  it("parseReceiveDistribution: посторонний текст со своим двоеточием ДО списка не склеивается в мусорный ключ (найдено адверсариал-ревью)", () => {
    // Двоеточие внутри пояснения («раскладка:») не должно попасть в имя товара —
    // этот кусок просто не распознаётся, а не превращается в мусорную пару.
    const parsed = parseReceiveDistribution("Принял: по факту вот такая раскладка: Кола 5, Спрайт 3");
    assert.deepEqual(parsed, { Спрайт: 3 });
  });
});

describe("Команда цены (П3): «цена <товар> <число> [точно]»", () => {
  it("isPriceCommand: жёсткий префикс, соседние слова не срабатывают", () => {
    assert.equal(isPriceCommand("цена TUC 12000"), true);
    assert.equal(isPriceCommand("  ЦЕНА: кола 9000"), true);
    assert.equal(isPriceCommand("цена"), true); // разберётся в подсказку формата
    assert.equal(isPriceCommand("оценка склада"), false);
    assert.equal(isPriceCommand("цены поднялись"), false);
    assert.equal(isPriceCommand("какая цена у колы"), false);
  });

  it("parsePriceCommand: базовый разбор, пробелы в числе, суффикс «к», «точно»", () => {
    assert.deepEqual(parsePriceCommand("цена TUC 12000"), { product: "TUC", price: 12000, confirmed: false });
    assert.deepEqual(parsePriceCommand("цена: кола 12 000"), { product: "кола", price: 12000, confirmed: false });
    assert.deepEqual(parsePriceCommand("цена ред булл 9к"), { product: "ред булл", price: 9000, confirmed: false });
    assert.deepEqual(parsePriceCommand("цена TUC 15000 точно"), { product: "TUC", price: 15000, confirmed: true });
    // «точно» в середине — тоже подтверждение (порядок слов не экзамен).
    assert.deepEqual(parsePriceCommand("цена точно TUC 15000"), { product: "TUC", price: 15000, confirmed: true });
  });

  it("parsePriceCommand: имя товара с цифрой не съедает цену", () => {
    assert.deepEqual(parsePriceCommand("цена 7 Days 8000"), { product: "7 Days", price: 8000, confirmed: false });
    // Жадный разбор склеивал «330 9000» в цену 3 309 000 — теперь пробел в
    // числе допустим только как разделитель тысяч (группы ровно по 3)
    // (найдено адверсариал-ревью).
    assert.deepEqual(parsePriceCommand("цена Cola 330 9000"), { product: "Cola 330", price: 9000, confirmed: false });
  });

  it("parsePriceCommand: естественные хвосты — «сум», точка, запятая после имени", () => {
    assert.deepEqual(parsePriceCommand("цена кола 12000 сум"), { product: "кола", price: 12000, confirmed: false });
    assert.deepEqual(parsePriceCommand("цена кола 12000."), { product: "кола", price: 12000, confirmed: false });
    assert.deepEqual(parsePriceCommand("цена кола, точно 12000"), { product: "кола", price: 12000, confirmed: true });
  });

  it("parsePriceCommand: мусор → null (подсказка формата, не запись)", () => {
    assert.equal(parsePriceCommand("цена"), null);
    assert.equal(parsePriceCommand("цена TUC"), null);
    assert.equal(parsePriceCommand("цена TUC ноль"), null);
    assert.equal(parsePriceCommand("цена TUC 4870000000012"), null, "штрихкод — не цена");
    assert.equal(parsePriceCommand("цена TUC 0"), null);
  });

  it("formatPriceResult: успех / гейт / не найден", () => {
    const ok = formatPriceResult({ ok: true, product: "TUC", oldPrice: null, newPrice: 12000 });
    assert.match(ok, /не была задана/);
    // ru-RU разделяет тысячи узким неразрывным пробелом (U+202F), не обычным.
    assert.match(ok, /12[\s\u00a0\u202f]000 сум/);

    const spike = formatPriceResult({
      ok: false,
      reason: "spike",
      product: "TUC",
      oldPrice: 10000,
      newPrice: 15000,
      deviationPct: 50,
    });
    assert.match(spike, /на 50%/);
    assert.match(spike, /«цена TUC 15000 точно»/);

    assert.match(formatPriceResult({ ok: false, reason: "not_found", product: "Чипсы" }), /не найден/);
  });
});

describe("Чек к накладной (П3): pickReceiptOrder", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  const order = (o: Partial<VendingOrder>): VendingOrder => ({
    id: "o1",
    approvalId: "a1",
    status: "received",
    positions: 3,
    totalOrder: 10,
    costRounded: 100000,
    createdBy: "owner",
    createdAt: "2026-08-24T08:00:00Z",
    receivedAt: "2026-08-24T10:00:00Z",
    receivedBy: "owner",
    ...o,
  });

  it("берёт последнюю принятую за сутки; непринятые и старые — мимо", () => {
    const fresh = order({ id: "fresh", receivedAt: "2026-08-24T11:00:00Z" });
    const older = order({ id: "older", receivedAt: "2026-08-24T09:00:00Z" });
    const stale = order({ id: "stale", receivedAt: "2026-08-22T09:00:00Z" });
    const open = order({ id: "open", status: "approved", receivedAt: null });
    assert.equal(pickReceiptOrder([open, older, fresh, stale], now)?.id, "fresh");
  });

  it("принятая до появления receivedAt (null) не подходит — честный отказ вместо угадывания", () => {
    assert.equal(pickReceiptOrder([order({ receivedAt: null })], now), null);
    assert.equal(pickReceiptOrder([], now), null);
  });

  it("receivedAt из будущего (кривые часы) — не подходит", () => {
    assert.equal(pickReceiptOrder([order({ receivedAt: "2026-08-25T12:00:00Z" })], now), null);
  });
});
