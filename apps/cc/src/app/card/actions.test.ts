import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergePlaces, saveEntity, saveLocation } from "./actions";

const mocks = vi.hoisted(() => ({
  entity: vi.fn(),
  updateEntity: vi.fn(),
  mergePlaces: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../../lib/core", () => ({
  core: {
    entity: mocks.entity,
    updateEntity: mocks.updateEntity,
    mergePlaces: mocks.mergePlaces,
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

describe("saveLocation: пометки источника у координат и адреса места (R-H-8)", () => {
  const место = (attrs: Record<string, unknown>) => ({ id: "loc-1", name: "KIUT Библиотека", externalRef: null, attrs });
  const записано = (): Record<string, unknown> => {
    const call = mocks.updateEntity.mock.calls[0] as [string, { attrs: Record<string, unknown> }] | undefined;
    if (!call) throw new Error("updateEntity не вызывался");
    return call[1].attrs;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.updateEntity.mockResolvedValue({});
  });

  it("адрес ровно с карты — ложится с пометкой «по карте»", async () => {
    mocks.entity.mockResolvedValue(место({}));
    await saveLocation("loc-1", { lat: "41.34", lng: "69.33", address: "улица Шота Руставели, 156", addressSource: "map" });
    expect(записано()["источник адреса"]).toBe("по карте (OpenStreetMap) — проверить");
  });

  it("человек поправил адрес — пометка снимается: теперь это его слово", async () => {
    mocks.entity.mockResolvedValue(
      место({ адрес: "улица Шота Руставели, 156", "источник адреса": "по карте (OpenStreetMap) — проверить" }),
    );
    await saveLocation("loc-1", { lat: "", lng: "", address: "Руставели 156, библиотека, 1 этаж", addressSource: "human" });
    expect(записано()).not.toHaveProperty("источник адреса");
  });

  it("адрес не трогали — пометка остаётся", async () => {
    mocks.entity.mockResolvedValue(
      место({ адрес: "улица Шота Руставели, 156", "источник адреса": "по карте (OpenStreetMap) — проверить" }),
    );
    await saveLocation("loc-1", { lat: "", lng: "", address: "улица Шота Руставели, 156", addressSource: "human" });
    expect(записано()["источник адреса"]).toBe("по карте (OpenStreetMap) — проверить");
  });

  it("координаты переставили — снимается «перенесено с автомата»; не трогали — остаётся", async () => {
    const перенесено = { широта: 41.34, долгота: 69.33, "источник координат": "перенесено с автомата KIUT 1" };
    mocks.entity.mockResolvedValue(место(перенесено));
    await saveLocation("loc-1", { lat: "41.3405", lng: "69.33", address: "" });
    expect(записано()).not.toHaveProperty("источник координат");

    vi.resetAllMocks();
    mocks.updateEntity.mockResolvedValue({});
    mocks.entity.mockResolvedValue(место(перенесено));
    await saveLocation("loc-1", { lat: "41.34", lng: "69.33", address: "Руставели 156" });
    expect(записано()["источник координат"]).toBe("перенесено с автомата KIUT 1");
  });
});

describe("mergePlaces: основание проверяется до Core (М-9, М-10)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("«по адресу» — не основание: отказ словами, в Core не ходим", async () => {
    const res = await mergePlaces("a", "b", "address", "у обоих один адрес, значит одно место");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/адреса основанием не является/);
    expect(mocks.mergePlaces).not.toHaveBeenCalled();
  });

  it("годное основание и причина — уходят в Core как есть", async () => {
    mocks.mergePlaces.mockResolvedValue({});
    const res = await mergePlaces("a", "b", "owner_word", "  одно место, слово владельца 10.09  ");
    expect(res.ok).toBe(true);
    expect(mocks.mergePlaces).toHaveBeenCalledWith("a", "b", { basis: "owner_word", reason: "одно место, слово владельца 10.09" });
  });
});
