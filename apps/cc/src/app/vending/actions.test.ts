import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveVendingProductFiscal } from "./actions";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  setVendingProductFiscal: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../../lib/core", () => ({
  core: { setVendingProductFiscal: mocks.setVendingProductFiscal },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

function fiscalForm(): FormData {
  const form = new FormData();
  form.set("productId", "018f6fd4-04e7-7c8d-a604-20e991ae5d48");
  form.set("ikpu", "");
  form.set("mxik", "");
  form.set("barcode", "");
  form.set("vatPct", "12");
  form.set("packageCode", "796");
  form.set("marked", "0");
  return form;
}

describe("saveVendingProductFiscal", () => {
  beforeEach(() => vi.resetAllMocks());

  it("пустые коды превращает в null и пишет полный словарный блок", async () => {
    mocks.setVendingProductFiscal.mockResolvedValue({
      ok: true,
      product: "Snickers 50gr",
      readyBefore: false,
      readyAfter: false,
    });
    const result = await saveVendingProductFiscal("vendhub", fiscalForm());
    expect(result).toEqual({ ok: true, message: "Фискальные данные «Snickers 50gr» сохранены" });
    expect(mocks.setVendingProductFiscal).toHaveBeenCalledWith({
      productId: "018f6fd4-04e7-7c8d-a604-20e991ae5d48",
      ikpu: null,
      mxik: null,
      barcode: null,
      vatPct: 12,
      packageCode: "796",
      marked: false,
      actor: "panel",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/domain/vendhub");
  });

  it("отбивает неверный код общим валидатором до Core", async () => {
    const form = fiscalForm();
    form.set("ikpu", "2202002001010032");
    await expect(saveVendingProductFiscal("vendhub", form)).resolves.toEqual({
      ok: false,
      message: "ИКПУ должен быть 17 цифр или пусто",
    });
    expect(mocks.setVendingProductFiscal).not.toHaveBeenCalled();
  });

  it("отсутствующий select не превращает молча в законную ставку НДС 0", async () => {
    const form = fiscalForm();
    form.delete("vatPct");
    const result = await saveVendingProductFiscal("vendhub", form);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Ставка НДС/);
    expect(mocks.setVendingProductFiscal).not.toHaveBeenCalled();
  });
});
