import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "../lib/core";
import { attrText, EntityEditor } from "./entity-editor";

const mocks = vi.hoisted(() => ({
  saveEntity: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../app/card/actions", () => ({
  saveEntity: mocks.saveEntity,
}));

/** Товар с объектным полем «поставка» — как у 34 карточек импорта mydon-stock. */
function товар(attrs: Record<string, unknown>): Entity {
  return {
    id: "entity-1",
    domain: "vendhub",
    type: "product",
    name: "СуперКонтик Шоколадный вкус 100gr",
    externalRef: null,
    attrs,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("attrText", () => {
  it("объект разворачивает в пары «ключ: значение»", () => {
    expect(
      attrText({ НДС: "включён в цену", "дата последней закупки": "2026-07-13" }),
    ).toBe("НДС: включён в цену · дата последней закупки: 2026-07-13");
  });

  it("массив простых значений — через запятую", () => {
    expect(attrText(["supplier", "client"])).toBe("supplier, client");
  });

  it("массив объектов считает записями, не расплющивая", () => {
    expect(attrText([{ всего: 5 }, { всего: 6 }])).toBe("2 записи");
  });

  it("пустое и null — прочерк, числа и строки — как есть", () => {
    expect(attrText(null)).toBe("—");
    expect(attrText([])).toBe("—");
    expect(attrText({})).toBe("—");
    expect(attrText(9750)).toBe("9750");
    expect(attrText("пакет")).toBe("пакет");
  });
});

describe("EntityEditor: объектные значения полей", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("объект «поставка» показывает читаемо, а не «[object Object]»", () => {
    render(
      <EntityEditor
        entity={товар({
          поставка: {
            НДС: "включён в цену",
            источник: "mydon-stock, журнал прихода",
            "дата последней закупки": "2026-07-13",
            "наименование в приходе": "Суперконтик",
          },
        })}
      />,
    );

    expect(
      screen.getByText(
        "НДС: включён в цену · источник: mydon-stock, журнал прихода · " +
          "дата последней закупки: 2026-07-13 · наименование в приходе: Суперконтик",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("массив строк показывает через запятую, массив объектов — счётом записей", () => {
    render(
      <EntityEditor
        entity={товар({
          roles: ["supplier", "client"],
          "что поставляет": [{ всего: 5 }, { всего: 6 }, { всего: 10 }],
        })}
      />,
    );

    expect(screen.getByText("supplier, client")).toBeInTheDocument();
    expect(screen.getByText("3 записи")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("[object Object]");
  });

  it("в форме правки объектное поле не превращается в текстовый input", async () => {
    const user = userEvent.setup();
    render(
      <EntityEditor
        entity={товар({
          поставка: { НДС: "включён в цену" },
          упаковка: "24 шт",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Изменить" }));

    // Обычное строковое поле правится как раньше…
    expect(screen.getByDisplayValue("24 шт")).toBeInTheDocument();
    // …а объект в форму не попадает: input с «[object Object]» при сохранении
    // перетёр бы данные этой строкой (см. saveEntity в actions.ts).
    expect(screen.queryByDisplayValue("[object Object]")).toBeNull();
    expect(document.querySelector('[name="attr:поставка"]')).toBeNull();
  });
});
