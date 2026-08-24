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
  stock: { asOf: "2026-08-20T15:00:00.000Z", totalBefore: 134, use: 3, back: 4, totalAfter: 135, stale: true },
  summary: {
    items: [{ product: "Fanta", need: 12, stock: 3, buy: 9, pack: 12, order: 12, price: 5167, costRounded: 62004, noPrice: false, noSales: false, fromPurchase: 12, fromStock: 0, unfilled: 0, toStock: 0, stockAfter: 3, excluded: false, fixedQty: null, perMachine: { "2508160376": 8, "2508160359": 4 } }],
    excludedNoSales: [],
    excludedByRule: [{ product: "Qurt", need: 5, stock: 3, buy: 0, pack: 10, order: 0, price: 6800, costRounded: 0, noPrice: false, noSales: false, fromPurchase: 0, fromStock: 3, unfilled: 2, toStock: 0, stockAfter: 0, excluded: true, fixedQty: null, perMachine: { "2508160376": 5 } }],
    noPrice: [], totalBuy: 9, totalOrder: 12, costExact: 46503, costRounded: 62004, overpay: 15501,
    totalFromPurchase: 12, totalFromStock: 3, totalUnfilled: 2, totalToStock: 0, allocation: "purchase-first",
  },
  machines: [
    { serial: "2508160376", name: "Olma", routeIndex: 1, need: 13, fromPurchase: 8, fromStock: 3, unfilled: 2, slots: [{ coilId: "3", product: "Fanta", quantity: 1, capacity: 5, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 }, { coilId: "5", product: "Qurt", quantity: 0, capacity: 5, need: 5, fromPurchase: 0, fromStock: 3, unfilled: 2 }] },
    { serial: "2508160359", name: "American Hospital", routeIndex: 2, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0, slots: [{ coilId: "12", product: "Fanta", quantity: 7, capacity: 11, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 }] },
  ],
  warnings: [{ code: "stock_stale", message: "Склад инвентаризирован 20.08.2026 — обнови: «склад …»" }],
} as VendingPlan;

describe("лист «План закупа»", () => {
  it("показывает итоги, маршрут, таблицы купить/склад/убрано и слоты по автоматам", () => {
    render(<PurchasePlanTables plan={plan} domain="vendhub" />);
    expect(screen.getByText(/Загрузить 15 из 17/)).toBeVisible();
    expect(screen.getByText("Olma")).toBeVisible();
    expect(screen.getByText(/Убрано из закупки/)).toBeVisible();
    expect(screen.getByText(/Склад на 20\.08\.2026/)).toBeVisible();
    expect(screen.getByText(/обнови/)).toBeVisible();
  });
  it("кнопка «Оформить закуп» показывает ошибку Core на месте и не падает", async () => {
    mocks.submitVendingPurchase.mockResolvedValue({ ok: false, message: "Core недоступен" });
    render(<SubmitPurchaseButton domain="vendhub" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Оформить закуп" }));
    expect(await screen.findByText("Core недоступен")).toBeVisible();
  });
  it("успех — подтверждение с числом позиций и refresh", async () => {
    mocks.submitVendingPurchase.mockResolvedValue({ ok: true, message: "Заявка отправлена: 3 поз." });
    render(<SubmitPurchaseButton domain="vendhub" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Оформить закуп" }));
    expect(await screen.findByText(/3 поз\./)).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
