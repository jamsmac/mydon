import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendingProductRow } from "../lib/core";
import { ProductRulesPanel } from "./product-rules-panel";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveVendingProductFiscal: vi.fn(),
  saveVendingProductRules: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/vending/actions", () => ({
  saveVendingProductFiscal: mocks.saveVendingProductFiscal,
  saveVendingProductRules: mocks.saveVendingProductRules,
  submitVendingPurchase: vi.fn(),
}));

const rows: VendingProductRow[] = [
  {
    id: "p1",
    name: "Snickers 50gr",
    category: "snack",
    purchasePrice: 7000,
    salePrice: 15000,
    packSize: 10,
    isActive: true,
    excludedFromPurchase: false,
    fixedPurchaseQty: 48,
    fiscal: {
      ikpu: "01806001001086002",
      mxik: null,
      vatPct: 12,
      barcode: null,
      packageCode: "796",
      marked: false,
    },
  },
  {
    id: "p2",
    name: "Twix 50gr",
    category: "snack",
    purchasePrice: 7000,
    salePrice: null,
    packSize: 10,
    isActive: true,
    excludedFromPurchase: true,
    fixedPurchaseQty: null,
    fiscal: { ikpu: null, mxik: null, vatPct: 12, barcode: null, packageCode: "796", marked: false },
  },
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

  it("строка товара показывает чип «чек соберётся» / «дыр: N»", () => {
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    expect(screen.getByText("чек соберётся")).toBeVisible();
    expect(screen.getByText("дыр: 1")).toBeVisible();
  });

  it("правка открывает обе формы одним блоком карточки товара", async () => {
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Snickers 50gr" }));
    expect(screen.getByLabelText("Блок, шт")).toBeVisible();
    expect(screen.getByLabelText("ИКПУ")).toBeVisible();
  });

  it("переключение строки без «Отмена» перемонтирует форму — не сохраняет чужие правки", async () => {
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Snickers 50gr" }));
    const pack = screen.getByLabelText("Блок, шт");
    await user.clear(pack);
    await user.type(pack, "12");
    await user.type(screen.getByLabelText("ИКПУ"), "12345678901234567");

    await user.click(screen.getByRole("button", { name: "Править Twix 50gr" }));

    expect(screen.getByLabelText("Блок, шт")).toHaveValue("10");
    expect(screen.getByLabelText("ИКПУ")).toHaveValue("");
    expect(screen.getByLabelText("Убрать из закупки (грузить только со склада)")).toBeChecked();
    expect(screen.getByDisplayValue("Twix 50gr")).toBeInTheDocument();
  });
});

describe("Правила закупа: эталон витрины только для чтения", () => {
  it("показывает эталон и говорит, где он правится", () => {
    render(<ProductRulesPanel domain="vendhub" products={[rows[0]!]} />);
    // Эталон — деньги, и «сум» у него такой же обязательный, как у цены
    // закупки в этой же строке (адверсариал UX #11).
    expect(screen.getByText(/витрина 15 000 сум/)).toBeVisible();
    expect(screen.getByText(/цена продажи <товар> <сум>/)).toBeVisible();
    // Формы правки здесь НЕТ: единственный писатель эталона — бот (R-P5b-6),
    // тот же принцип, что у закупочной цены.
    expect(screen.queryByLabelText(/Витрина/)).toBeNull();
  });

  it("эталона нет — так и сказано, а не «витрина 0»", () => {
    render(<ProductRulesPanel domain="vendhub" products={[rows[1]!]} />);
    expect(screen.getByText(/эталон не задан/)).toBeVisible();
    expect(screen.queryByText(/витрина 0/)).toBeNull();
  });
});
