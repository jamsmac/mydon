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
  it("успех — refresh, форма закрывается, в панели видно, что записано (UX#25)", async () => {
    mocks.saveVendingProductRules.mockResolvedValue({ ok: true, message: "Правило «Twix 50gr» сохранено" });
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Twix 50gr" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(await screen.findByText("Правило «Twix 50gr» сохранено")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
  });

  it("форма подписана товаром: видно, что правишь (UX#14)", async () => {
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Snickers 50gr" }));
    expect(screen.getByText("Правила закупа — Snickers 50gr")).toBeVisible();
  });

  it("кнопка подписана «Править», имя товара — в aria-label (UX#24)", () => {
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    // Читалка и тесты находят кнопку по товару, глаз видит короткую подпись.
    expect(screen.getByRole("button", { name: "Править Snickers 50gr" })).toHaveTextContent("Править");
    expect(screen.getAllByRole("button", { name: /^Править / })).toHaveLength(2);
  });
  it("переключение строки без «Отмена» перемонтирует форму — не сохраняет чужие правки", async () => {
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Snickers 50gr" }));
    const pack = screen.getByLabelText("Блок, шт");
    await user.clear(pack);
    await user.type(pack, "12");

    await user.click(screen.getByRole("button", { name: "Править Twix 50gr" }));

    expect(screen.getByLabelText("Блок, шт")).toHaveValue("10");
    expect(screen.getByLabelText("Убрать из закупки (грузить только со склада)")).toBeChecked();
    expect(screen.getByDisplayValue("Twix 50gr")).toBeInTheDocument();
  });
});
