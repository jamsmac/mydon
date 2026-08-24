import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendingPlan } from "./core-client";
import { MAX_PARTS, TG_BUDGET, formatPurchasePlan, isPlanCommand } from "./purchase-plan";

/** ru-RU ставит U+202F/U+00A0 в тысячах — сравниваем по обычному пробелу. */
const norm = (s: string): string => s.replace(/[\u00a0\u202f]/g, " ");

const plan: VendingPlan = {
  generatedAt: "2026-08-25T04:00:00.000Z",
  stock: { asOf: "2026-08-20T15:00:00.000Z", totalBefore: 134, use: 3, back: 4, totalAfter: 135, stale: true, unmatched: 0 },
  summary: {
    items: [
      {
        product: "Fanta",
        need: 12,
        stock: 3,
        buy: 9,
        pack: 12,
        order: 12,
        price: 5167,
        costRounded: 62004,
        noPrice: false,
        noSales: false,
        fromPurchase: 12,
        fromStock: 0,
        unfilled: 0,
        toStock: 0,
        stockAfter: 3,
        excluded: false,
        fixedQty: null,
        perMachine: { "2508160376": 8, "2508160359": 4 },
      },
    ],
    excludedNoSales: [],
    excludedByRule: [
      {
        product: "Qurt",
        need: 5,
        stock: 3,
        buy: 0,
        pack: 10,
        order: 0,
        price: 6800,
        costRounded: 0,
        noPrice: false,
        noSales: false,
        fromPurchase: 0,
        fromStock: 3,
        unfilled: 2,
        toStock: 0,
        stockAfter: 0,
        excluded: true,
        fixedQty: null,
        perMachine: { "2508160376": 5 },
      },
    ],
    noPrice: [],
    totalBuy: 9,
    totalOrder: 12,
    costExact: 46503,
    costRounded: 62004,
    overpay: 15501,
    shortfallCost: 0,
    totalFromPurchase: 12,
    totalFromStock: 3,
    totalUnfilled: 2,
    totalToStock: 0,
    allocation: "purchase-first",
  },
  machines: [
    {
      serial: "2508160376",
      name: "Olma",
      routeIndex: 1,
      need: 13,
      fromPurchase: 8,
      fromStock: 3,
      unfilled: 2,
      slots: [
        { coilId: "3", product: "Fanta", quantity: 1, capacity: 5, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 },
        { coilId: "5", product: "Qurt", quantity: 0, capacity: 5, need: 5, fromPurchase: 0, fromStock: 3, unfilled: 2 },
      ],
    },
    {
      serial: "2508160359",
      name: "American Hospital",
      routeIndex: 2,
      need: 4,
      fromPurchase: 4,
      fromStock: 0,
      unfilled: 0,
      slots: [
        { coilId: "12", product: "Fanta", quantity: 7, capacity: 11, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 },
      ],
    },
  ],
  routeConfigured: false,
  warnings: [{ code: "stock_stale", message: "Склад инвентаризирован 20.08.2026 — обнови: «склад …»" }],
};

describe("Бот: команда «план закупа»", () => {
  it("ловит формулировки владельца и не ловит «что заказать»", () => {
    for (const t of ["план закупа", "План закупки", "маршрут закупа", "план загрузки"]) assert.equal(isPlanCommand(t), true, t);
    for (const t of ["что заказать", "закуп", "оформить закуп"]) assert.equal(isPlanCommand(t), false, t);
  });
  it("сводка: итоги, маршрут по автоматам, склад до/после, предупреждение о давности", () => {
    const [head] = formatPurchasePlan(plan).map(norm);
    assert.match(head!, /Загрузить 15 из 17/);
    assert.match(head!, /купить 12 .*62 004/);
    assert.match(head!, /1\. Olma — загрузить 11 \(закуп 8 · склад 3\) · пусто 2/);
    assert.match(head!, /2\. American Hospital — загрузить 4/);
    // «Вернуть 4» читалось как возврат поставщику, а это излишек упаковки на
    // склад; дата — про пересчёт склада, а не про план (UX#4).
    assert.match(head!, /Склад: сейчас 134 → после похода 135 \(увезём 3, докупим сверх нужды 4\)/);
    assert.match(head!, /последний пересчёт 20\.08\.2026/);
    assert.doesNotMatch(head!, /вернуть/i);
    // «Пусто» без пояснения читалось как «пустые слоты» (UX#29).
    assert.match(head!, /пусто 2 — столько штук не закроется ни закупом, ни складом/);
    assert.match(head!, /⚠️ .*20\.08\.2026/);
  });
  it("купить / со склада / убрано / слоты по автоматам — отдельные сообщения", () => {
    const parts = formatPurchasePlan(plan).map(norm);
    // «(в автоматы 12, на склад 0)» читалось как «докупим 12 в автоматы» —
    // теперь прямо сказано, что это раздача уже купленного (UX#7).
    assert.ok(
      parts.some((p) => /🛒 Купить/.test(p) && /Fanta — 12 — сразу в автоматы 12, остальное на склад 0 · 62 004 сум/.test(p)),
    );
    assert.ok(parts.some((p) => /📦 Со склада/.test(p) && /Qurt — 3/.test(p)));
    // «со склада 3» уже сказано в 📦 — повтор предлагал взять вдвое (UX#31).
    assert.ok(parts.some((p) => /🚫 Убрано из закупки/.test(p) && /• Qurt — пусто 2/.test(p)));
    assert.ok(!parts.some((p) => /🚫 Убрано из закупки/.test(p) && /со склада 3/.test(p)));
    assert.ok(parts.some((p) => /🎰 Olma/.test(p) && /слот 5 Qurt: 0\/5 \+5 → склад 3 · пусто 2/.test(p)));
  });

  it("после списка покупок сказано, чем это оформляется (UX#17)", () => {
    const купить = formatPurchasePlan(plan).find((p) => /🛒 Купить/.test(p))!;
    assert.match(купить, /Готов покупать — напиши «оформить закуп»/);
  });

  it("фикс-количество объяснено в строке: почему покупаем больше нехватки (UX#20)", () => {
    const сФиксом: VendingPlan = {
      ...plan,
      summary: {
        ...plan.summary,
        items: [{ ...plan.summary.items[0]!, product: "Snickers", order: 48, buy: 10, fixedQty: 48, fromPurchase: 10, toStock: 38, costRounded: 336000 }],
      },
    };
    const купить = norm(formatPurchasePlan(сФиксом).find((p) => /🛒 Купить/.test(p))!);
    assert.match(купить, /• Snickers — 48 \(фикс 48; нехватка 10\) — сразу в автоматы 10, остальное на склад 38 · 336 000 сум/);
  });

  it("позиция без цены: сказано, что в сумму не вошла (UX#7)", () => {
    const безЦены: VendingPlan = {
      ...plan,
      summary: { ...plan.summary, items: [{ ...plan.summary.items[0]!, noPrice: true, costRounded: 0 }], noPrice: ["Fanta"] },
    };
    const купить = formatPurchasePlan(безЦены).find((p) => /🛒 Купить/.test(p))!;
    assert.match(купить, /нет цены — в сумму не вошло/);
  });
  it("каждое сообщение укладывается в бюджет Telegram", () => {
    const big = { ...plan, machines: plan.machines.map((m) => ({ ...m, slots: Array.from({ length: 200 }, (_, i) => ({ ...m.slots[0]!, coilId: String(i) })) })) };
    for (const p of formatPurchasePlan(big)) assert.ok(p.length <= TG_BUDGET, String(p.length));
  });
  it("маршрут из десятков автоматов с предупреждениями — сводка тоже режется", () => {
    const many = {
      ...plan,
      machines: Array.from({ length: 40 }, (_, i) => ({ ...plan.machines[0]!, routeIndex: i + 1, name: `Автомат с длинным именем ${i}` })),
      warnings: Array.from({ length: 40 }, (_, i) => ({ code: "machine_skipped" as const, message: `Автомат ${i} не в строю — пропущен в плане.` })),
    };
    for (const p of formatPurchasePlan(many)) assert.ok(p.length <= TG_BUDGET, String(p.length));
  });

  it("одна строка длиннее бюджета режется внутри — и ни одно имя не теряется", () => {
    // Core отдаёт «Без цены — вне бюджета: …» и «Нет в прайсе вендинга: …»
    // одной строкой на все товары: она приходит в ПЕРВОЕ сообщение, и её
    // перелив убил бы весь ответ (Telegram 400 на sendMessage).
    const names = Array.from({ length: 400 }, (_, i) => `Товар с длинным именем ${i}`);
    const long = {
      ...plan,
      warnings: [{ code: "no_price" as const, message: `Без цены — вне бюджета: ${names.join(", ")}` }],
    };
    const parts = formatPurchasePlan(long);
    for (const p of parts) assert.ok(p.length <= TG_BUDGET, String(p.length));
    const all = parts.join("\n");
    for (const n of names) assert.ok(all.includes(n), n);
  });

  it("нечего грузить — одно сообщение", () => {
    const empty = { ...plan, summary: { ...plan.summary, items: [], excludedByRule: [], totalFromPurchase: 0, totalFromStock: 0, totalUnfilled: 0 }, machines: [] };
    assert.equal(formatPurchasePlan(empty).length, 1);
  });

  it("нечего грузить, но посчитано не всё — предупреждения не молчат (UX#3)", () => {
    // «Грузить нечего» одинаково звучит и когда всё полно, и когда автоматы
    // выпали из расчёта. Второе владелец обязан увидеть.
    const empty: VendingPlan = {
      ...plan,
      summary: { ...plan.summary, items: [], excludedByRule: [], totalFromPurchase: 0, totalFromStock: 0, totalUnfilled: 0 },
      machines: [],
      warnings: [
        { code: "machine_skipped", message: "Olma (2508160376) не в строю: В ремонте" },
        { code: "sales_stale", message: "Продажи собраны 9 дн. назад — «нет продаж» может быть ложным" },
      ],
    };
    const [text] = formatPurchasePlan(empty);
    assert.match(text!, /Грузить нечего/);
    assert.match(text!, /Но посчитано не всё/);
    assert.match(text!, /Olma \(2508160376\) не в строю/);
    assert.match(text!, /Продажи собраны 9 дн\. назад/);
  });

  it("парк из 40 автоматов не топит чат: не больше MAX_PARTS сообщений и хвост со ссылкой", () => {
    // 26 автоматов = 26 сообщений подряд: пока бот их шлёт, первое (что купить)
    // уезжает из видимой части чата, и план перестаёт быть планом.
    const много: VendingPlan = {
      ...plan,
      machines: Array.from({ length: 40 }, (_, i) => ({ ...plan.machines[0]!, serial: `s${i}`, routeIndex: i + 1, name: `Автомат ${i}` })),
    };
    const parts = formatPurchasePlan(много);
    assert.ok(parts.length <= MAX_PARTS, `частей ${parts.length}`);
    const последняя = parts[parts.length - 1]!;
    assert.match(последняя, /ещё \d+ автоматов — на листе «План закупа» в панели/);
    for (const p of parts) assert.ok(p.length <= TG_BUDGET, String(p.length));
  });

  it("автоматов немного — хвоста нет, слоты печатаются все", () => {
    const parts = formatPurchasePlan(plan);
    assert.ok(!parts.some((p) => /ещё \d+ автоматов/.test(p)));
    assert.ok(parts.some((p) => /🎰 American Hospital/.test(p)));
  });
});
