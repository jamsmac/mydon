import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RAW_ROLES } from "@mydon/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawSourceState } from "../lib/core";
import { NewReport, NewSource, RolesEditor } from "./source-editor";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveReport: vi.fn(),
  saveSource: vi.fn(),
  setRoles: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/sources/actions", () => ({
  saveReport: mocks.saveReport,
  saveSource: mocks.saveSource,
  setRoles: mocks.setRoles,
}));

describe("формы источников", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("показывает ошибку новой системы и сохраняет контролируемые поля", async () => {
    mocks.saveSource.mockResolvedValue({ ok: false, error: "Код уже занят" });
    const user = userEvent.setup();
    render(<NewSource />);

    await user.click(screen.getByRole("button", { name: "+ Система" }));
    const code = screen.getByPlaceholderText("click");
    await user.type(code, "payme");
    await user.type(screen.getByPlaceholderText("Click"), "Payme");
    await user.click(screen.getByRole("button", { name: "Завести" }));

    expect(await screen.findByText("Код уже занят")).toBeVisible();
    expect(mocks.saveSource).toHaveBeenCalledWith({
      code: "payme",
      title: "Payme",
      subtitle: "",
      url: "",
    });
    expect(code).toHaveValue("payme");
  });

  it("показывает ошибку нового отчёта и сохраняет его название", async () => {
    mocks.saveReport.mockResolvedValue({ ok: false, error: "Отчёт уже есть" });
    const user = userEvent.setup();
    const source = { code: "ourvend" } as RawSourceState;
    render(<NewReport source={source} />);

    await user.click(screen.getByRole("button", { name: "+ Отчёт" }));
    await user.type(screen.getByPlaceholderText("settlements"), "orders");
    const title = screen.getByPlaceholderText("Settlements");
    await user.type(title, "Orders");
    await user.click(screen.getByRole("button", { name: "Завести" }));

    expect(await screen.findByText("Отчёт уже есть")).toBeVisible();
    expect(mocks.saveReport).toHaveBeenCalledWith({
      source: "ourvend",
      code: "orders",
      title: "Orders",
      ru: "",
      path: "",
    });
    expect(title).toHaveValue("Orders");
  });

  it("блокирует дубли ролей и передаёт исправленную схему", async () => {
    mocks.setRoles.mockResolvedValue({ ok: false, error: "Версия отчёта устарела" });
    const user = userEvent.setup();
    render(
      <RolesEditor
        source="ourvend"
        report="orders"
        columns={["Дата", "Сумма"]}
        roles={{}}
        origin="owner"
      />,
    );

    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[0]!, "Дата");
    await user.selectOptions(selects[1]!, "Дата");
    expect(screen.getByText(/Одна колонка назначена/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Сохранить роли" })).toBeDisabled();

    await user.selectOptions(selects[1]!, "Сумма");
    await user.click(screen.getByRole("button", { name: "Сохранить роли" }));

    expect(await screen.findByText("Версия отчёта устарела")).toBeVisible();
    expect(mocks.setRoles).toHaveBeenCalledOnce();
    const draft = mocks.setRoles.mock.calls[0]?.[2] as Record<string, string>;
    expect(draft[RAW_ROLES[0]!]).toBe("Дата");
    expect(draft[RAW_ROLES[1]!]).toBe("Сумма");
  });
});
