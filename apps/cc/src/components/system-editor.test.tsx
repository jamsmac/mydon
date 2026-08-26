import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SystemConfigItem } from "../lib/core";
import { SystemEditor } from "./system-editor";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), saveSystemConfig: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/system/actions", () => ({ saveSystemConfig: mocks.saveSystemConfig }));

/** Тумблер источника учёта — единственный сегодня с фолбэком ядра. */
const ИСТОЧНИК: SystemConfigItem = {
  key: "OURVEND_ACCOUNTING_SOURCE",
  label: "Источник учёта OurVend",
  kind: "select",
  options: ["stock", "own"],
  value: "stock",
  source: "db",
};

describe("«Система»: действующее значение рядом с записанным (R-FW-S5)", () => {
  it("зеркала нет — панель говорит «действует: own (без зеркала)», а не «stock»", () => {
    // Прод-случай на пути катовера: после шага 3 рунбука `STOCK_DATABASE_URL`
    // удалён, и записанный `stock` действует как `own`. Панель, печатающая
    // только записанное, отправила бы владельца искать погашенное зеркало.
    render(<SystemEditor items={[{ ...ИСТОЧНИК, effective: "own" }]} />);
    expect(screen.getByText("действует: own (без зеркала)")).toBeVisible();
    // Записанное значение при этом не подменяется: чинить владелец будет его.
    expect(screen.getByText("задано в панели")).toBeVisible();
  });

  it("действующее совпадает с записанным — второй пилюли нет", () => {
    render(<SystemEditor items={[{ ...ИСТОЧНИК, value: "own", effective: "own" }]} />);
    expect(screen.queryByText(/действует:/)).toBeNull();
  });

  it("поля нет вовсе (Core прошлой сборки) — подписи нет, а не «неизвестно»", () => {
    render(<SystemEditor items={[ИСТОЧНИК]} />);
    expect(screen.queryByText(/действует:/)).toBeNull();
  });

  it("чужой ключ с фолбэком — «действует: X» без придуманной причины", () => {
    render(
      <SystemEditor
        items={[{ key: "SOME_OTHER", label: "Другой", kind: "text", value: "a", source: "env", effective: "b" }]}
      />,
    );
    expect(screen.getByText("действует: b")).toBeVisible();
  });
});
