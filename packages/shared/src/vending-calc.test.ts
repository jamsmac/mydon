import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRICE_SPIKE_PCT,
  computePurchase,
  computePurchaseCash,
  machineDeficit,
  needByProduct,
  normalizeProductName,
  planogramStatus,
  priceDeviationPct,
  runoutForecast,
  slotDeficit,
  slotValid,
  type CashCategoryInput,
  type PriceEntry,
  type PurchaseRow,
  type Slot,
} from "./vending-calc";

describe("Вендинг: нормализация имени товара (алиасы)", () => {
  it("сводит регистр, пробелы и ё→е", () => {
    assert.equal(normalizeProductName("  Coca  Cola  cl "), "coca cola cl");
    assert.equal(normalizeProductName("Montella"), "montella");
    assert.equal(normalizeProductName("Тёплый чай"), "теплый чай");
  });

  it("одинаковые по сути имена дают один ключ", () => {
    assert.equal(normalizeProductName("18+"), normalizeProductName("18+ "));
    assert.equal(normalizeProductName("Moxito КЛУБ"), normalizeProductName("moxito клуб"));
  });

  it("десятичная запятая объёма сводится к точке (R-FW-P1)", () => {
    // Прод-адверсариал 26.08: 4 из 11 «имён без карточки» отличались от уже
    // заведённой карточки/алиаса РОВНО этим знаком.
    assert.equal(normalizeProductName("Royal Pomegranate CAN 0,3"), normalizeProductName("Royal Pomegranate CAN 0.3"));
    assert.equal(normalizeProductName("Fanta CAN 0,25"), "fanta can 0.25");
    assert.equal(normalizeProductName("Flash Peach CAN 0,45"), normalizeProductName("Flash Peach CAN 0.45"));
  });

  it("сводится ТОЛЬКО запятая между цифрами — разные товары не склеиваются", () => {
    // Запятая-разделитель в имени («Кофе, чай») цифрами не окружена и остаётся
    // на месте: фолдинг закрывает десятичный знак, а не пунктуацию.
    assert.equal(normalizeProductName("Кофе, чай"), "кофе, чай");
    assert.equal(normalizeProductName("Snickers 50 ,"), "snickers 50 ,");
    // Два РАЗНЫХ объёма одного товара остаются двумя разными ключами.
    assert.notEqual(normalizeProductName("Flash Peach CAN 0,45"), normalizeProductName("Flash Peach CAN 0,25"));
    assert.notEqual(normalizeProductName("Pepsi 0,5"), normalizeProductName("Pepsi 1,5"));
  });
});

// ── §5.1–5.2 Слоты, валидность, статус, дефицит ──────────────────────────────

describe("Вендинг: валидность слота и статус планограммы (§5.1)", () => {
  const slot = (p: string | null, cap: number, qty: number): Slot => ({ coilId: "x", product: p, capacity: cap, quantity: qty });

  it("валиден 0 < capacity ≤ 100; вместимость 0 — невалиден (пример из App В)", () => {
    assert.equal(slotValid(slot("Montella", 6, 0)), true);
    assert.equal(slotValid(slot("Fanta", 0, 0)), false); // слот 59 из App В
    assert.equal(slotValid(slot("X", 101, 0)), false);
  });

  it("no_slots — ни один слот не назначен", () => {
    assert.equal(planogramStatus([slot(null, 6, 0), slot("", 6, 0)]), "no_slots");
  });

  it("uncalibrated — валидных меньше половины назначенных", () => {
    // 3 с товаром, валиден 1 (< 1.5) → uncalibrated
    assert.equal(planogramStatus([slot("A", 6, 0), slot("B", 0, 0), slot("C", 0, 0)]), "uncalibrated");
  });

  it("ok — валидных достаточно", () => {
    assert.equal(planogramStatus([slot("A", 6, 0), slot("B", 6, 0), slot("C", 0, 0)]), "ok");
  });

  it("дефицит слота = вместимость − остаток; остаток > вместимости обрезается", () => {
    assert.equal(slotDeficit(slot("A", 6, 0)), 6);
    assert.equal(slotDeficit(slot("A", 6, 4)), 2);
    assert.equal(slotDeficit(slot("A", 6, 9)), 0); // обрезка до capacity → дефицит 0, не отрицательный
  });

  it("дефицит и заполненность автомата — по валидным слотам", () => {
    const m = machineDeficit([slot("A", 6, 1), slot("B", 6, 3), slot("C", 0, 0)]);
    assert.equal(m.deficit, 8); // (6-1)+(6-3) = 5+3
    assert.equal(m.capacity, 12);
    assert.equal(m.filled, 4);
    assert.equal(m.fillRate, 33); // round(4/12*100)
  });
});

describe("Вендинг: потребность по товарам с разбивкой (§5.3)", () => {
  it("суммирует дефицит по автоматам, хранит разбивку", () => {
    const needs = needByProduct([
      { machineId: "AH", slots: [{ coilId: "1", product: "Montella", capacity: 6, quantity: 0 }] },
      { machineId: "Olma", slots: [{ coilId: "2", product: "Montella", capacity: 6, quantity: 3 }] },
    ]);
    assert.equal(needs.length, 1);
    assert.equal(needs[0].total, 9); // 6 + 3
    assert.deepEqual(needs[0].perMachine, { AH: 6, Olma: 3 });
  });
});

// ── Приложение Г: контрольный пример (эталон до единицы) ──────────────────────

/** product → [AH, Olma, stock, price, pack]. Данные из Приложения Г + прайса А. */
const CONTROL: Record<string, [number, number, number, number, number]> = {
  Montella: [18, 9, 7, 2090, 12],
  СуперКонтик: [9, 10, 0, 5000, 10],
  Barni: [8, 5, 0, 3875, 10],
  Pepsi: [2, 8, 0, 5417, 12],
  Kinder: [9, 0, 0, 11000, 10],
  Bounty: [6, 2, 0, 7800, 10],
  MnMs: [7, 0, 0, 9000, 10],
  CocaZero: [6, 1, 0, 5250, 12],
  MoxitoKlub: [5, 10, 9, 9800, 12],
  Cheers: [5, 1, 0, 9500, 10],
  Oreo: [4, 2, 0, 5500, 10],
  ErmakQurt: [4, 1, 0, 6800, 10],
  Borjomi: [4, 0, 0, 10500, 12],
  RedBull: [0, 4, 0, 16000, 12],
  TUC: [2, 1, 0, 10500, 10],
  Ozbegim: [1, 2, 0, 9000, 12],
  Fanta: [4, 4, 7, 5167, 12],
  ChocoPie: [6, 0, 5, 2000, 10],
  Nesquick: [1, 0, 0, 6900, 12],
  CocaClassic: [6, 4, 19, 5167, 12],
  MoxitoLime: [5, 5, 22, 9800, 12],
  Snickers: [6, 1, 11, 7000, 10],
  FuseTea: [2, 5, 7, 8500, 12],
  Velona: [5, 1, 12, 2500, 10],
  ErmakArahis: [3, 2, 5, 4800, 10],
  Sprite: [2, 2, 7, 5167, 12],
  Plus18: [0, 4, 10, 8500, 12],
  Laimon: [0, 3, 3, 8000, 12],
  Lays: [2, 0, 5, 13000, 10],
  Twix: [0, 2, 2, 7000, 10],
  Flint: [0, 1, 3, 5800, 10],
  FlashUp: [0, 1, 10, 8500, 12],
};

function controlInput(): { input: PurchaseRow[]; prices: Map<string, PriceEntry> } {
  const input: PurchaseRow[] = [];
  const prices = new Map<string, PriceEntry>();
  for (const [product, [ah, olma, stock, price, pack]] of Object.entries(CONTROL)) {
    input.push({ product, perMachine: { AH: ah, Olma: olma }, stock, sold7: 1 });
    prices.set(product, { price, pack });
  }
  return { input, prices };
}

describe("Вендинг: сводный закуп воспроизводит Приложение Г до единицы (§5.4–5.5)", () => {
  const { input, prices } = controlInput();
  // includeNoSales=true — контрольный снимок посчитан с позициями-без-продаж
  // (Nesquick входит в 240/1 665 068); в проде это переключатель (§7 preview).
  const sum = computePurchase(input, prices, { round: true, includeNoSales: true });

  it("итоги единиц: нужно 223, склад 90, купить 133, заказать 240", () => {
    assert.equal(sum.totalNeed, 223);
    assert.equal(sum.totalCovered, 90);
    assert.equal(sum.totalBuy, 133);
    assert.equal(sum.totalOrder, 240);
  });

  it("суммы: costExact 863 862, costRounded 1 665 068, переплата 801 206", () => {
    assert.equal(sum.costExact, 863_862);
    assert.equal(sum.costRounded, 1_665_068);
    assert.equal(sum.overpay, 801_206);
  });

  it("«Закуп по прайсу» (полный дефицит по прайсу) = 1 442 999", () => {
    assert.equal(sum.costByPriceFull, 1_442_999);
  });

  it("построчно: Montella — купить 20, заказать 24, сумма 50 160", () => {
    const m = sum.items.find((i) => i.product === "Montella");
    assert.ok(m);
    assert.equal(m.need, 27);
    assert.equal(m.covered, 7);
    assert.equal(m.buy, 20);
    assert.equal(m.order, 24); // ceil(20/12)*12
    assert.equal(m.costRounded, 50_160);
    assert.deepEqual(m.perMachine, { AH: 18, Olma: 9 });
  });

  it("полностью закрытые складом — order 0 (CocaCola: нужно 10, склад 19)", () => {
    const c = sum.items.find((i) => i.product === "CocaClassic");
    assert.ok(c);
    assert.equal(c.buy, 0);
    assert.equal(c.order, 0);
    assert.equal(c.costRounded, 0);
    assert.equal(c.surplus, 9);
  });
});

describe("Вендинг: опции закупа", () => {
  const { input, prices } = controlInput();

  it("без округления costRounded = costExact (переплата 0)", () => {
    const s = computePurchase(input, prices, { round: false, includeNoSales: true });
    assert.equal(s.totalOrder, s.totalBuy);
    assert.equal(s.costRounded, s.costExact);
    assert.equal(s.overpay, 0);
  });

  it("позиция без продаж по умолчанию вынесена из итогов", () => {
    // Nesquick: продаж 0, дефицит 1, склад 0 → в excludedNoSales, не в items.
    const one: PurchaseRow[] = [{ product: "Nesquick", perMachine: { AH: 1 }, stock: 0, sold7: 0 }];
    const s = computePurchase(one, new Map([["Nesquick", { price: 6900, pack: 12 }]]));
    assert.equal(s.items.length, 0);
    assert.equal(s.excludedNoSales.length, 1);
    assert.equal(s.totalOrder, 0);
    assert.equal(s.costRounded, 0);
  });

  it("товар без цены — в noPrice и вне денежных сумм", () => {
    const one: PurchaseRow[] = [{ product: "Загадка", perMachine: { AH: 5 }, stock: 0, sold7: 3 }];
    const s = computePurchase(one, new Map());
    assert.deepEqual(s.noPrice, ["Загадка"]);
    assert.equal(s.totalBuy, 5); // в единицах учтён
    assert.equal(s.costRounded, 0); // в деньгах — нет
  });
});

describe("Вендинг: прогноз запаса (§5.6)", () => {
  it("daysLeft = остаток / (sold7/7); нет продаж → бесконечность; критичные ≤3 дн", () => {
    const { all, critical } = runoutForecast([
      { product: "Montella", sold7: 59, inMachines: 9 }, // 8.43/дн → ~1.07 дн
      { product: "Snickers", sold7: 0, inMachines: 11 }, // нет продаж → ∞
      { product: "Fanta", sold7: 10, inMachines: 4 }, // ~2.8 дн
    ]);
    const montella = all.find((r) => r.product === "Montella")!;
    assert.ok(Math.abs(montella.daysLeft - 9 / (59 / 7)) < 1e-9);
    assert.equal(all.find((r) => r.product === "Snickers")!.daysLeft, Infinity);
    // Критичные отсортированы по возрастанию daysLeft.
    assert.deepEqual(
      critical.map((r) => r.product),
      ["Montella", "Fanta"],
    );
  });
});

// ── §5.8 Касса закупа: воспроизводит реальную запись владельца 02.08.2026 ────

describe("Вендинг: касса закупа воспроизводит реальную запись до сума", () => {
  // Реальная заметка: получил 2 400 000, «корзинка» 98 230, «базар» (снеки)
  // 376 300, «базар» (напитки) 1 023 000, остаток 902 470. Строки — как в
  // заметке (арифметика владельца), category «базар» повторяется дважды.
  const categories: CashCategoryInput[] = [
    { name: "корзинка", lines: [{ label: "47×2090", qty: 47, unitPrice: 2090, amount: 98_230 }] },
    {
      name: "базар",
      lines: [
        { label: "Barni", qty: 4, unitPrice: 18_500, amount: 74_000 },
        { label: "Bounty", qty: 10, unitPrice: 8_000, amount: 80_000 },
        { label: "ChocoPie", qty: 2, amount: 51_000 }, // 2*12*(25500/12) — уже посчитано владельцем
        { label: "Oreo", qty: 12, unitPrice: 5_500, amount: 66_000 },
        { label: "Cheers", qty: 6, unitPrice: 8_800, amount: 52_800 },
        { label: "TUC", qty: 5, unitPrice: 10_500, amount: 52_500 },
      ],
    },
    {
      name: "базар",
      lines: [
        { label: "Moxito", amount: 235_000 },
        { label: "Moxito klibn", amount: 235_000 },
        { label: "Fuse Tea can 0.45", amount: 105_000 },
        { label: "Plus 18 can 0.33", amount: 102_000 },
        { label: "Coca Cola classic can 0.25", amount: 62_000 },
        { label: "Fanta can 0.25", amount: 62_000 },
        { label: "Sprite can 0.25", amount: 62_000 },
        { label: "RedBull can 0.25", qty: 10, unitPrice: 16_000, amount: 160_000 },
      ],
    },
  ];

  const session = computePurchaseCash(2_400_000, categories);

  it("подытоги статей совпадают с записью (корзинка 98 230, базар 376 300 и 1 023 000)", () => {
    assert.equal(session.categories[0]!.subtotal, 98_230);
    assert.equal(session.categories[1]!.subtotal, 376_300);
    assert.equal(session.categories[2]!.subtotal, 1_023_000);
  });

  it("потрачено и остаток совпадают с записью: 1 497 530 и 902 470", () => {
    assert.equal(session.totalSpent, 1_497_530);
    assert.equal(session.remainder, 902_470);
  });

  it("повторяющаяся статья «базар» не схлопывается — две отдельные строки", () => {
    const bazaars = session.categories.filter((c) => c.name === "базар");
    assert.equal(bazaars.length, 2);
  });

  it("потрачено больше, чем получено — остаток уходит в минус (не скрываем перерасход)", () => {
    const overspent = computePurchaseCash(100_000, [{ name: "базар", lines: [{ label: "X", amount: 150_000 }] }]);
    assert.equal(overspent.remainder, -50_000);
  });
});

describe("Гейт цены закупа (П3): priceDeviationPct", () => {
  it("формула донора: |Δ|/прежняя × 100, симметрично вверх и вниз", () => {
    assert.equal(priceDeviationPct(12_000, 10_000), 20);
    assert.equal(priceDeviationPct(8_000, 10_000), 20);
    assert.equal(priceDeviationPct(45_000, 4_500), 900); // классическая опечатка донора
  });

  it("сравнивать не с чем — null (гейт пропускается): нет цены, ноль, отрицательная", () => {
    assert.equal(priceDeviationPct(12_000, null), null);
    assert.equal(priceDeviationPct(12_000, undefined), null);
    assert.equal(priceDeviationPct(12_000, 0), null);
    assert.equal(priceDeviationPct(12_000, -5), null);
    assert.equal(priceDeviationPct(Number.NaN, 10_000), null);
  });

  it("порог PRICE_SPIKE_PCT — донорские 20%", () => {
    assert.equal(PRICE_SPIKE_PCT, 20);
  });
});

// ── §4.1 (спека П5a): политика раздачи и правила товара ─────────────────────

describe("Вендинг: политика раздачи и правила товара (П5a, донор vending-ops)", () => {
  const prices = new Map<string, PriceEntry>([
    ["Fanta", { price: 5167, pack: 12 }],
    ["Snickers", { price: 7000, pack: 10 }],
    ["Qurt", { price: 6800, pack: 10 }],
    ["Montella", { price: 2090, pack: 12 }],
  ]);
  const row = (product: string, need: number, stock: number, sold7 = 5): PurchaseRow => ({
    product, perMachine: { olma: need }, need, stock, sold7,
  });

  it("purchase-first (по умолчанию): новая упаковка идёт в автоматы первой, склад не трогается", () => {
    const s = computePurchase([row("Fanta", 20, 5)], prices);
    const i = s.items[0]!;
    assert.equal(s.allocation, "purchase-first");
    assert.equal(i.buy, 15);
    assert.equal(i.order, 24);
    assert.equal(i.fromPurchase, 20);
    assert.equal(i.fromStock, 0);
    assert.equal(i.toStock, 4);
    assert.equal(i.stockAfter, 9);
    assert.equal(i.unfilled, 0);
    // прежние поля не меняются (Приложение Г)
    assert.equal(i.covered, 5);
    assert.equal(i.surplus, 0);
    assert.equal(i.extra, 9);
  });

  it("warehouse-first (совместимость): склад закрывает потребность первым", () => {
    const s = computePurchase([row("Fanta", 20, 5)], prices, { allocation: "warehouse-first" });
    const i = s.items[0]!;
    assert.equal(i.fromStock, 5);
    assert.equal(i.fromPurchase, 15);
    assert.equal(i.toStock, 9);
    assert.equal(i.stockAfter, 9);
  });

  it("фикс-количество: при дефиците покупаем ровно фикс, без округления; излишек на склад", () => {
    const rules = new Map([["Snickers", { fixedQty: 48 }]]);
    const s = computePurchase([row("Snickers", 10, 0)], prices, { rules });
    const i = s.items[0]!;
    assert.equal(i.fixedQty, 48);
    assert.equal(i.buy, 10);
    assert.equal(i.order, 48);
    assert.equal(i.fromPurchase, 10);
    assert.equal(i.toStock, 38);
    assert.equal(i.stockAfter, 38);
    assert.equal(i.costRounded, 48 * 7000);
  });

  it("фикс меньше дефицита: остаток честно «пусто», extra не уходит в минус", () => {
    const rules = new Map([["Snickers", { fixedQty: 5 }]]);
    const s = computePurchase([row("Snickers", 12, 2)], prices, { rules });
    const i = s.items[0]!;
    assert.equal(i.order, 5);
    assert.equal(i.fromPurchase, 5);
    assert.equal(i.fromStock, 2);
    assert.equal(i.unfilled, 5);
    assert.equal(i.extra, 0);
  });

  it("фикс не срабатывает без дефицита (склад закрывает)", () => {
    const rules = new Map([["Snickers", { fixedQty: 48 }]]);
    const s = computePurchase([row("Snickers", 10, 15)], prices, { rules });
    assert.equal(s.items[0]!.order, 0);
    assert.equal(s.items[0]!.fromStock, 10);
  });

  it("исключён из закупки: не покупаем, грузим со склада что есть, остальное пусто; вне денег", () => {
    const rules = new Map([["Qurt", { excluded: true }]]);
    const s = computePurchase([row("Qurt", 8, 5)], prices, { rules });
    assert.equal(s.items.length, 0);
    assert.equal(s.excludedByRule.length, 1);
    const i = s.excludedByRule[0]!;
    assert.equal(i.excluded, true);
    assert.equal(i.order, 0);
    assert.equal(i.fromStock, 5);
    assert.equal(i.unfilled, 3);
    assert.equal(s.costRounded, 0);
    assert.equal(s.totalFromStock, 5);
    assert.equal(s.totalUnfilled, 3);
  });

  it("нет продаж: не покупаем, но склад грузим; штуки в итогах раздачи, денег нет", () => {
    const s = computePurchase([row("Montella", 6, 4, 0)], prices);
    const i = s.excludedNoSales[0]!;
    assert.equal(i.fromPurchase, 0);
    assert.equal(i.fromStock, 4);
    assert.equal(i.unfilled, 2);
    assert.equal(s.totalFromStock, 4);
    assert.equal(s.totalBuy, 0);
  });

  it("блок без цены берётся из правил; цена — нет (noPrice)", () => {
    const rules = new Map([["TUC", { pack: 5 }]]);
    const s = computePurchase([row("TUC", 7, 0)], prices, { rules });
    const i = s.items[0]!;
    assert.equal(i.pack, 5);
    assert.equal(i.order, 10);
    assert.equal(i.noPrice, true);
    assert.equal(i.fromPurchase, 7);
  });

  it("фикс МЕНЬШЕ нехватки: переплаты нет, недобор виден отдельным числом (ревью безопасности)", () => {
    // Snickers: нехватка 100, склад 0, фикс 48 → купим 48×7000 = 336 000, а по
    // нехватке нужно было 700 000. Разность отрицательная, и раньше она уезжала
    // в `overpay` как «переплата −364 000» — экономия там, где недокуп.
    const rules = new Map([["Snickers", { fixedQty: 48 }]]);
    const s = computePurchase([row("Snickers", 100, 0)], prices, { rules });
    assert.equal(s.items[0]!.order, 48);
    assert.equal(s.costExact, 700_000);
    assert.equal(s.costRounded, 336_000);
    assert.equal(s.overpay, 0);
    assert.equal(s.shortfallCost, 364_000);
    assert.equal(s.items[0]!.unfilled, 52);
  });

  it("обычный закуп: недобора нет, переплата на месте", () => {
    const s = computePurchase([row("Fanta", 20, 5)], prices);
    assert.ok(s.overpay > 0);
    assert.equal(s.shortfallCost, 0);
  });

  it("битая кратность (pack 0) не даёт NaN в сумме: считаем поштучно", () => {
    // `pack_size` — обычный integer; ноль от старого импорта давал ceil(x/0)×0
    // = NaN и молча портил весь бюджет закупа.
    const битый = new Map<string, PriceEntry>([["Fanta", { price: 5167, pack: 0 }]]);
    const s = computePurchase([row("Fanta", 7, 0)], битый);
    const i = s.items[0]!;
    assert.equal(i.pack, 1);
    assert.equal(i.order, 7);
    assert.equal(i.costRounded, 7 * 5167);
    assert.ok(Number.isFinite(s.costRounded));
  });

  it("исключённый товар без цены не шумит в «на разбор» (A3/UX#22)", () => {
    // Цена нужна для бюджета; товар, который владелец решил не покупать, в
    // бюджет не входит — просить для него цену не за чем.
    const rules = new Map([["Загадка", { excluded: true }]]);
    const s = computePurchase([{ product: "Загадка", perMachine: { olma: 5 }, need: 5, stock: 2, sold7: 4 }], new Map(), {
      rules,
    });
    assert.deepEqual(s.noPrice, []);
    assert.equal(s.excludedByRule[0]!.noPrice, true);
    // Не исключённый — по-прежнему на разбор.
    const обычный = computePurchase([{ product: "Загадка", perMachine: { olma: 5 }, need: 5, stock: 0, sold7: 4 }], new Map());
    assert.deepEqual(обычный.noPrice, ["Загадка"]);
  });

  it("инварианты: fromPurchase + fromStock + unfilled = need; stockAfter ≥ 0", () => {
    const rules = new Map([["Qurt", { excluded: true }], ["Snickers", { fixedQty: 3 }]]);
    const s = computePurchase(
      [row("Fanta", 20, 5), row("Snickers", 12, 2), row("Qurt", 8, 5), row("Montella", 6, 4, 0)],
      prices,
      { rules },
    );
    for (const i of [...s.items, ...s.excludedByRule, ...s.excludedNoSales]) {
      assert.equal(i.fromPurchase + i.fromStock + i.unfilled, i.need, i.product);
      assert.ok(i.stockAfter >= 0, i.product);
    }
    assert.equal(s.totalFromPurchase + s.totalFromStock + s.totalUnfilled, 46);
  });
});
