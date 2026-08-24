import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractActForm,
  ContractPaymentForm,
  ContractStatusButtons,
  NewContractForm,
} from "./contract-forms";

const mocks = vi.hoisted(() => ({
  addContractAct: vi.fn(),
  addContractPayment: vi.fn(),
  createContract: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  setContractStatus: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("../app/contracts/actions", () => ({
  addContractAct: mocks.addContractAct,
  addContractPayment: mocks.addContractPayment,
  createContract: mocks.createContract,
  setContractStatus: mocks.setContractStatus,
}));

describe("формы договоров", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт спецификацию договора и сохраняет черновик при ошибке", async () => {
    mocks.createContract.mockResolvedValue({ ok: false, message: "Покупатель не выбран" });
    const user = userEvent.setup();
    render(<NewContractForm clients={[]} />);

    await user.click(screen.getByRole("button", { name: "+ Договор купли-продажи" }));
    const number = screen.getByLabelText(/Номер/);
    await user.type(number, "501");
    const itemName = screen.getByPlaceholderText("HELI CPCD30, 2026 г.в.");
    await user.type(itemName, "HELI CPCD30");
    await user.clear(screen.getByPlaceholderText("шт"));
    await user.type(screen.getByPlaceholderText("шт"), "2");
    await user.type(screen.getByPlaceholderText("цена с НДС"), "100000000");
    await user.click(screen.getByRole("button", { name: "Создать договор" }));

    expect(await screen.findByText("Покупатель не выбран")).toBeVisible();
    const form = mocks.createContract.mock.calls[0]?.[0] as FormData;
    expect(form.get("contractNo")).toBe("501");
    expect(JSON.parse(String(form.get("items")))).toEqual([
      { name: "HELI CPCD30", qty: 2, price: 100000000 },
    ]);
    expect(itemName).toHaveValue("HELI CPCD30");
    expect(number).toHaveValue("501");
  });

  it("не отменяет договор без явного подтверждения", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<ContractStatusButtons id="contract-1" status="active" />);

    await user.click(screen.getByRole("button", { name: "отменить" }));

    expect(window.confirm).toHaveBeenCalledWith(
      "Отменить договор? Платежи и акты по нему станут недоступны.",
    );
    expect(mocks.setContractStatus).not.toHaveBeenCalled();
  });

  it("показывает ошибку платежа и сохраняет сумму", async () => {
    mocks.addContractPayment.mockResolvedValue({ ok: false, message: "Сумма больше остатка" });
    const user = userEvent.setup();
    render(<ContractPaymentForm id="contract-1" />);

    const amount = screen.getByLabelText("Сумма");
    await user.type(amount, "50000000");
    await user.type(screen.getByLabelText("№ платёжки"), "PAY-7");
    await user.click(screen.getByRole("button", { name: "Внести платёж" }));

    expect(await screen.findByText("Сумма больше остатка")).toBeVisible();
    const form = mocks.addContractPayment.mock.calls[0]?.[1] as FormData;
    expect(form.get("amount")).toBe("50000000");
    expect(form.get("docNo")).toBe("PAY-7");
    expect(amount).toHaveValue("50000000");
  });

  it("показывает ошибку акта и не теряет подписантов", async () => {
    mocks.addContractAct.mockResolvedValue({ ok: false, message: "Номер акта уже существует" });
    const user = userEvent.setup();
    render(<ContractActForm id="contract-1" />);

    await user.click(screen.getByRole("button", { name: "+ Акт приёма-передачи" }));
    const actNo = screen.getByLabelText("Номер акта");
    await user.type(actNo, "A-15");
    await user.type(screen.getByLabelText("Подписал от продавца"), "А. Алимов");
    await user.click(screen.getByRole("button", { name: "Оформить акт" }));

    expect(await screen.findByText("Номер акта уже существует")).toBeVisible();
    const form = mocks.addContractAct.mock.calls[0]?.[1] as FormData;
    expect(form.get("actNo")).toBe("A-15");
    expect(actNo).toHaveValue("A-15");
  });
});
