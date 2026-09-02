import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveEntity } from "./actions";

const mocks = vi.hoisted(() => ({
  entity: vi.fn(),
  updateEntity: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../../lib/core", () => ({
  core: {
    entity: mocks.entity,
    updateEntity: mocks.updateEntity,
  },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

/** Сведения импорта mydon-stock — объектное поле без своего редактора в форме. */
const поставка = { поставщик: "TCN", блок: 24, последняя: "2026-08-20" };

function свежаяКарточка(attrs: Record<string, unknown>) {
  return { id: "prod-1", name: "Moxito", externalRef: "c2508160376", attrs };
}

/** Форма паспорта: объектные attrs она не возит (фильтр в entity-editor.tsx). */
function формаПаспорта(): FormData {
  const form = new FormData();
  form.set("name", "Moxito");
  form.set("externalRef", "c2508160376");
  form.set("attr:цена", "6000");
  return form;
}

describe("saveEntity: объектные attrs без своего редактора", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.updateEntity.mockResolvedValue({ id: "prod-1" });
  });

  it("сохранение паспорта не удаляет объектное поле, которого нет в форме", async () => {
    mocks.entity.mockResolvedValue(
      свежаяКарточка({ цена: 5000, поставка, меню: '[{"productId":"p2","price":null}]' }),
    );

    await expect(saveEntity("prod-1", формаПаспорта())).resolves.toEqual({ ok: true });

    expect(mocks.updateEntity).toHaveBeenCalledWith("prod-1", {
      name: "Moxito",
      externalRef: "c2508160376",
      attrs: {
        // Строковое поле формы прошло (и осталось числом) …
        цена: 6000,
        // … объект и управляемый ключ — нетронуты из свежей карточки.
        поставка,
        меню: '[{"productId":"p2","price":null}]',
      },
    });
  });

  it("поле-тёзка объектного attr через «+ Поле» — честный отказ, объект цел", async () => {
    mocks.entity.mockResolvedValue(свежаяКарточка({ поставка }));
    const form = формаПаспорта();
    form.set("newKey", "поставка");
    form.set("newValue", "раз в неделю");

    await expect(saveEntity("prod-1", form)).resolves.toEqual({
      ok: false,
      error: "Поле «поставка» ведётся импортом или своим редактором — руками его не заменить",
    });
    // Строка из формы объект НЕ перетёрла: записи не было вовсе.
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it("поле-тёзка управляемого ключа (MANAGED_ATTR_KEYS) — тот же отказ", async () => {
    // В свежей карточке «меню» может и не быть: без отказа ввод молча съел бы
    // delete attrs[k] в цикле управляемых ключей.
    mocks.entity.mockResolvedValue(свежаяКарточка({}));
    const form = формаПаспорта();
    form.set("newKey", "меню");
    form.set("newValue", "кофе и вода");

    await expect(saveEntity("prod-1", form)).resolves.toEqual({
      ok: false,
      error: "Поле «меню» ведётся импортом или своим редактором — руками его не заменить",
    });
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it("новое поле без коллизии сохраняется как раньше", async () => {
    mocks.entity.mockResolvedValue(свежаяКарточка({ поставка }));
    const form = формаПаспорта();
    form.set("newKey", "вкус");
    form.set("newValue", "мохито");

    await expect(saveEntity("prod-1", form)).resolves.toEqual({ ok: true });

    expect(mocks.updateEntity).toHaveBeenCalledWith("prod-1", {
      name: "Moxito",
      externalRef: "c2508160376",
      attrs: { цена: 6000, вкус: "мохито", поставка },
    });
  });
});
