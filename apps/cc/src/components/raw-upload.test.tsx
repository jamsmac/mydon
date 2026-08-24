import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RawUpload } from "./raw-upload";

const mocks = vi.hoisted(() => ({
  importFile: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/sources/actions", () => ({
  importFile: mocks.importFile,
}));

async function openAndFill(): Promise<File> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Загрузить выгрузку" }));
  const file = new File(["date;amount\n2026-08-24;1000"], "sales.csv", {
    type: "text/csv",
  });
  await user.upload(screen.getByLabelText(/Файл выгрузки/), file);
  fireEvent.change(screen.getByLabelText("Когда снято у источника"), {
    target: { value: "2026-08-24T12:30" },
  });
  return file;
}

describe("RawUpload", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт файл вместе с идентификаторами источника и показывает API-ошибку", async () => {
    mocks.importFile.mockResolvedValue({ ok: false, error: "INGEST_KEY не настроен" });
    render(<RawUpload source="gj" report="sales" reportTitle="Продажи" path="Отчёты" />);
    const file = await openAndFill();
    expect((screen.getByLabelText(/Файл выгрузки/) as HTMLInputElement).files?.[0]?.name).toBe(
      file.name,
    );

    const submit = screen.getByRole("button", { name: "Загрузить" });
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    expect(await screen.findByText("INGEST_KEY не настроен")).toBeVisible();
    const form = mocks.importFile.mock.calls[0]?.[0] as FormData;
    expect(form.get("source")).toBe("gj");
    expect(form.get("report")).toBe("sales");
    expect(form.get("fetchedAt")).toBe("2026-08-24T12:30");
    expect(form.get("file")).toBeInstanceOf(File);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("даёт выбрать лист Excel и повторно отправляет форму", async () => {
    mocks.importFile
      .mockResolvedValueOnce({
        ok: false,
        error: "Выбери лист",
        needsSheet: true,
        sheets: ["Продажи", "Остатки"],
      })
      .mockResolvedValueOnce({ ok: true, rows: 42 });
    render(<RawUpload source="ourvend" report="orders" reportTitle="Заказы" path="Экспорт" />);
    await openAndFill();

    const submit = screen.getByRole("button", { name: "Загрузить" });
    fireEvent.submit(submit.closest("form") as HTMLFormElement);
    expect(await screen.findByLabelText("Лист книги Excel")).toBeVisible();
    expect(screen.getByText("Выбери лист")).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText("Лист книги Excel"), "Остатки");
    const repeat = screen.getByRole("button", { name: "Импортировать выбранное" });
    fireEvent.submit(repeat.closest("form") as HTMLFormElement);

    await waitFor(() => expect(mocks.importFile).toHaveBeenCalledTimes(2));
    const secondForm = mocks.importFile.mock.calls[1]?.[0] as FormData;
    expect(secondForm.get("sheet")).toBe("Остатки");
    expect(await screen.findByText(/Загружено строк: 42/)).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
