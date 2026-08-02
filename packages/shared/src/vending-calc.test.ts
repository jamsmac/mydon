import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computePurchase,
  machineDeficit,
  needByProduct,
  normalizeProductName,
  planogramStatus,
  runoutForecast,
  slotDeficit,
  slotValid,
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
