import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VendingPlan } from "../lib/core";
import { PurchasePlanTables } from "./purchase-plan-view";
import { SubmitPurchaseButton } from "./purchase-plan-submit";

const mocks = vi.hoisted(() => ({ submitVendingPurchase: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/vending/actions", () => ({ submitVendingPurchase: mocks.submitVendingPurchase, saveVendingProductRules: vi.fn() }));
// В одном файле с таблицами живёт серверный `PurchasePlanView`, а он тянет
// клиент Core — тот первой строкой импортирует пакет `server-only`, которого
// вне RSC не существует (в jsdom импорт файла падал бы на разрешении модуля).
// Сами таблицы Core не трогают: им отдают готовый план пропом.
vi.mock("../lib/core", () => ({ core: {} }));

const plan: VendingPlan = {
  generatedAt: "2026-08-25T04:00:00.000Z",
  stock: { asOf: "2026-08-20T15:00:00.000Z", totalBefore: 134, use: 3, back: 4, totalAfter: 135, stale: true, unmatched: 0 },
  summary: {
    items: [{ product: "Fanta", need: 12, stock: 3, covered: 3, buy: 9, surplus: 0, pack: 12, order: 12, extra: 3, price: 5167, costExact: 46503, costRounded: 62004, noPrice: false, noSales: false, fromPurchase: 12, fromStock: 0, unfilled: 0, toStock: 0, stockAfter: 3, excluded: false, fixedQty: null, perMachine: { "2508160376": 8, "2508160359": 4 } }],
    excludedNoSales: [],
    excludedByRule: [{ product: "Qurt", need: 5, stock: 3, covered: 3, buy: 0, surplus: 0, pack: 10, order: 0, extra: 0, price: 6800, costExact: 0, costRounded: 0, noPrice: false, noSales: false, fromPurchase: 0, fromStock: 3, unfilled: 2, toStock: 0, stockAfter: 0, excluded: true, fixedQty: null, perMachine: { "2508160376": 5 } }],
    noPrice: [], totalNeed: 12, totalCovered: 3, totalBuy: 9, totalOrder: 12, costExact: 46503, costByPriceFull: 62004, costRounded: 62004, overpay: 15501, shortfallCost: 0,
    totalFromPurchase: 12, totalFromStock: 3, totalUnfilled: 2, totalToStock: 0, allocation: "purchase-first",
  },
  machines: [
    { serial: "2508160376", name: "Olma", routeIndex: 1, need: 13, fromPurchase: 8, fromStock: 3, unfilled: 2, slots: [{ coilId: "3", product: "Fanta", quantity: 1, capacity: 5, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 }, { coilId: "5", product: "Qurt", quantity: 0, capacity: 5, need: 5, fromPurchase: 0, fromStock: 3, unfilled: 2 }] },
    { serial: "2508160359", name: "American Hospital", routeIndex: 2, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0, slots: [{ coilId: "12", product: "Fanta", quantity: 7, capacity: 11, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 }] },
  ],
  routeConfigured: false,
  warnings: [{ code: "stock_stale", message: "Склад инвентаризирован 20.08.2026 — обнови: «склад …»" }],
} as VendingPlan;

describe("лист «План закупа»", () => {
  it("показывает итоги, маршрут, таблицы купить/склад/убрано и слоты по автоматам", () => {
    render(<PurchasePlanTables plan={plan} domain="vendhub" />);
    expect(screen.getByText(/Загрузить 15 из 17/)).toBeVisible();
    expect(screen.getByText("Olma")).toBeVisible();
    expect(screen.getByText(/Убрано из закупки/)).toBeVisible();
    expect(screen.getByText(/Склад: последний пересчёт 20\.08\.2026/)).toBeVisible();
    expect(screen.getByText(/обнови/)).toBeVisible();
    // Давность склада — не «весь склад протух»: пилюля говорит, что именно.
    expect(screen.getByText("часть строк старее 3 дней")).toBeVisible();
  });

  it("«Убрано из закупки» не повторяет «со склада N» — она уже сказана выше (П5b-7)", () => {
    // Та же цифра, сказанная дважды, читается как две разные: «со склада 3» в
    // «Собрать со склада» и «со склада 3» здесь — один и тот же товар. Бот эту
    // секцию печатает без склада, панель обязана совпадать.
    const { container } = render(<PurchasePlanTables plan={plan} domain="vendhub" />);
    const секции = [...container.querySelectorAll(".section-title")];
    const убрано = секции.find((e) => e.textContent === "Убрано из закупки")!;
    const строки = убрано.nextElementSibling!;
    expect(строки.textContent).toContain("нужно 5");
    expect(строки.textContent).toContain("пусто 2");
    expect(строки.textContent).not.toContain("со склада");
  });

  it("«Собрать со склада» считает по автоматам раздачу склада, а не потребность (A1)", () => {
    // У Qurt потребность Olma 5, а со склада уедет 3: «Olma 5» отправило бы
    // владельца искать на складе две несуществующие штуки.
    render(<PurchasePlanTables plan={plan} domain="vendhub" />);
    expect(screen.getByText(/по автоматам Olma 3/)).toBeVisible();
    expect(screen.queryByText(/по автоматам Olma 5/)).toBeNull();
  });

  it("порядок секций как в боте: Купить → Со склада → Убрано → Слоты (UX#21)", () => {
    const { container } = render(<PurchasePlanTables plan={plan} domain="vendhub" />);
    const titles = [...container.querySelectorAll(".section-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Маршрут", "Купить", "Собрать со склада", "Убрано из закупки"]);
  });

  it("подсказка маршрута: порядок по имени объясняет, где задаётся свой (UX#16)", () => {
    render(<PurchasePlanTables plan={plan} domain="vendhub" />);
    expect(screen.getByText(/Порядок — по имени автомата.*Вендинг: маршрут загрузки/)).toBeVisible();
    render(<PurchasePlanTables plan={{ ...plan, routeConfigured: true }} domain="vendhub" />);
    expect(screen.getByText(/Порядок задан в настройках/)).toBeVisible();
  });

  it("сумма 0 при живых позициях: «не посчитана», а не «на 0 сум» (UX#6)", () => {
    const безЦены = {
      ...plan,
      summary: {
        ...plan.summary,
        items: [{ ...plan.summary.items[0]!, noPrice: true, costRounded: 0 }],
        costRounded: 0,
        noPrice: ["Fanta"],
      },
    } as VendingPlan;
    render(<PurchasePlanTables plan={безЦены} domain="vendhub" />);
    expect(screen.getByText(/сумма не посчитана — ни у одной позиции нет цены/)).toBeVisible();
    expect(screen.queryByText(/на 0 сум/)).toBeNull();
  });

  it("часть позиций без цены — сумма помечена неполной (UX#6)", () => {
    const частично = { ...plan, summary: { ...plan.summary, noPrice: ["Qurt"] } } as VendingPlan;
    render(<PurchasePlanTables plan={частично} domain="vendhub" />);
    expect(screen.getByText(/без 1 поз\. без цены — сумма неполная/)).toBeVisible();
  });

  it("нечего закупать — кнопки «Оформить закуп» нет вовсе (UX#23)", () => {
    const пусто = { ...plan, summary: { ...plan.summary, items: [], totalUnfilled: 0 } } as VendingPlan;
    render(<PurchasePlanTables plan={пусто} domain="vendhub" />);
    expect(screen.queryByRole("button", { name: "Оформить закуп" })).toBeNull();
    // И «пусто 0» не печатаем: ноль здесь — не сигнал.
    expect(screen.queryByText(/не закроется/)).toBeNull();
  });
  it("кнопка «Оформить закуп» показывает ошибку Core на месте и не падает", async () => {
    mocks.submitVendingPurchase.mockResolvedValue({ ok: false, message: "Core недоступен" });
    render(<SubmitPurchaseButton domain="vendhub" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Оформить закуп" }));
    expect(await screen.findByText("Core недоступен")).toBeVisible();
  });
  it("успех — подтверждение с числом позиций, refresh и погасшая кнопка (UX#15)", async () => {
    mocks.submitVendingPurchase.mockResolvedValue({ ok: true, message: "Заявка отправлена: 3 поз." });
    render(<SubmitPurchaseButton domain="vendhub" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Оформить закуп" }));
    expect(await screen.findByText(/3 поз\./)).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalled();
    // Второе нажатие создало бы вторую заявку на тот же поход.
    const кнопка = screen.getByRole("button", { name: "Заявка отправлена" });
    expect(кнопка).toBeDisabled();
  });
});

describe("числа плана закупа копируются (R-H-3)", () => {
  it("в выводе листа нет неразрывного пробела", () => {
    const { container } = render(<PurchasePlanTables plan={plan} domain="vendhub" />);
    expect(container.textContent ?? "").not.toContain("\u00a0");
  });
});
