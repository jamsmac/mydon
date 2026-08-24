import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendingProductRow } from "../lib/core";
import { ProductRulesPanel } from "./product-rules-panel";

const mocks = vi.hoisted(() => ({ saveVendingProductRules: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/vending/actions", () => ({ saveVendingProductRules: mocks.saveVendingProductRules, submitVendingPurchase: vi.fn() }));

const rows: VendingProductRow[] = [
  { id: "p1", name: "Snickers 50gr", category: "snack", purchasePrice: 7000, packSize: 10, isActive: true, excludedFromPurchase: false, fixedPurchaseQty: 48 },
  { id: "p2", name: "Twix 50gr", category: "snack", purchasePrice: 7000, packSize: 10, isActive: true, excludedFromPurchase: true, fixedPurchaseQty: null },
];

describe("лист «Правила закупа»", () => {
  beforeEach(() => vi.resetAllMocks());
  it("показывает товары с правилами", () => {
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    expect(screen.getByText("Snickers 50gr")).toBeVisible();
    expect(screen.getByText("Twix 50gr")).toBeVisible();
  });
  it("сохраняет введённый блок при отказе Core и показывает ошибку", async () => {
    mocks.saveVendingProductRules.mockResolvedValue({ ok: false, message: "Core недоступен" });
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Snickers 50gr" }));
    const pack = screen.getByLabelText("Блок, шт");
    await user.clear(pack); await user.type(pack, "12");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Core недоступен")).toBeVisible();
    expect(pack).toHaveValue("12");
    const form = mocks.saveVendingProductRules.mock.calls[0]?.[1] as FormData;
    expect(form.get("product")).toBe("Snickers 50gr");
    expect(form.get("packSize")).toBe("12");
  });
  it("успех — refresh и форма закрывается", async () => {
    mocks.saveVendingProductRules.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Twix 50gr" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });
});
