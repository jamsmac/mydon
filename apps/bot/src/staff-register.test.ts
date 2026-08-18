import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow } from "./core-client";
import {
  handleRegisterCallback,
  handleRegisterName,
  handleRegisterPhoto,
  isRegisterTrigger,
  parseRegisterCallback,
  startRegister,
  unitKeyboard,
} from "./staff-register";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "оператор",
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
};

const NEW_ID = "33333333-3333-4333-8333-333333333333";

/** Заглушка Core: записывает вызовы, чтобы проверить, что именно ушло. */
function stubCore(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const core = {
    createEntity: async (input: Record<string, unknown>) => {
      calls.push(`create:${input.domain}:${input.type}:${input.name}:${input.createdFrom}`);
      return { id: NEW_ID, name: String(input.name) };
    },
    uploadPhoto: async (input: Record<string, unknown>) => {
      calls.push(`photo:${input.ownerType}:${input.ownerId}:${input.filename}`);
      return { id: "att-1", url: "/attachments/att-1/raw" };
    },
    updateEntity: async (id: string, attrs: Record<string, unknown>) => {
      calls.push(`update:${id}:${JSON.stringify(attrs)}`);
      return {};
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Разбор кнопок заведения", () => {
  it("принимает только свой строгий формат", () => {
    assert.deepEqual(parseRegisterCallback("r:type:ingredient"), { kind: "type", type: "ingredient" });
    assert.deepEqual(parseRegisterCallback("r:type:component"), { kind: "type", type: "component" });
    assert.deepEqual(parseRegisterCallback("r:photo:done"), { kind: "photoDone" });
    assert.deepEqual(parseRegisterCallback("r:cancel"), { kind: "cancel" });
    assert.deepEqual(parseRegisterCallback("r:unit:0"), { kind: "unit", unit: "г" });
    assert.equal(parseRegisterCallback("r:type:machine"), null, "чужой тип не проходит");
    assert.equal(parseRegisterCallback("r:unit:99"), null, "несуществующий индекс единицы");
    assert.equal(parseRegisterCallback("t:22222222-2222-4222-8222-222222222222:done"), null);
    assert.equal(parseRegisterCallback(""), null);
  });

  it("клавиатура единиц кодирует индексы, а не кириллицу (+ ряд «Отмена»)", () => {
    const flat = unitKeyboard().inline_keyboard.flat();
    const units = flat.filter((b) => b.callback_data !== "r:cancel");
    assert.ok(flat.some((b) => b.callback_data === "r:cancel"), "шаг единиц — не тупик кнопок");
    for (const b of units) assert.match(b.callback_data, /^r:unit:\d+$/);
    // каждая кнопка разбирается обратно в реальную единицу
    for (const b of flat) assert.ok(parseRegisterCallback(b.callback_data));
  });
});

describe("Триггер заведения", () => {
  it("ловит понятные формулировки", () => {
    assert.ok(isRegisterTrigger("новый ингредиент"));
    assert.ok(isRegisterTrigger("новая запчасть"));
    assert.ok(isRegisterTrigger("завести"));
    assert.ok(isRegisterTrigger("добавить ингредиент"));
  });
  it("не срабатывает на постороннем", () => {
    assert.ok(!isRegisterTrigger("задачи"));
    assert.ok(!isRegisterTrigger("новый день"));
  });
});

describe("Поток заведения номенклатуры", () => {
  it("проходит тип → имя → фото → единица и заводит черновик на утверждение", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };

    // старт: спрашиваем тип
    const start = startRegister(1, deps);
    assert.match(start.text, /что заводим/i);
    assert.equal(conversations.get(1)?.step, "type");

    // выбрали «ингредиент» → просим имя
    const afterType = await handleRegisterCallback(1, { kind: "type", type: "ingredient" }, ME, deps);
    assert.match(afterType.message?.text ?? "", /название/i);
    assert.equal(conversations.get(1)?.step, "name");

    // имя → создаётся черновик, ждём фото
    const afterName = await handleRegisterName(1, "Зёрна Арабика", ME, deps);
    assert.match(afterName.text, /черновик/i);
    assert.equal(conversations.get(1)?.step, "photo");
    assert.equal(conversations.get(1)?.data.entityId, NEW_ID);
    // черновик: createdFrom заполнен → ляжет на утверждение владельцу
    assert.match(calls[0], /^create:vendhub:ingredient:Зёрна Арабика:staff:/);

    // фото → грузится и привязывается к черновику
    const afterPhoto = await handleRegisterPhoto(
      1,
      { bytes: Buffer.from("img"), mime: "image/jpeg" },
      ME,
      deps,
    );
    assert.match(afterPhoto?.text ?? "", /фото добавлено \(1\)/i);
    assert.match(calls[1], new RegExp(`^photo:entity:${NEW_ID}:`));

    // «готово» → выбор единицы
    const afterDone = await handleRegisterCallback(1, { kind: "photoDone" }, ME, deps);
    assert.ok(afterDone.message?.keyboard, "должна прийти клавиатура единиц");
    assert.equal(conversations.get(1)?.step, "unit");

    // единица → дописываем поле и завершаем
    const afterUnit = await handleRegisterCallback(1, { kind: "unit", unit: "кг" }, ME, deps);
    assert.match(afterUnit.message?.text ?? "", /ждёт утверждения/i);
    assert.match(calls[2], new RegExp(`^update:${NEW_ID}:{"unit":"кг"}`));
    assert.equal(conversations.get(1), null, "визард завершён");
  });

  it("без фото карточка всё равно заводится", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    startRegister(2, deps);
    await handleRegisterCallback(2, { kind: "type", type: "component" }, ME, deps);
    await handleRegisterName(2, "Фильтр помпы", ME, deps);
    await handleRegisterCallback(2, { kind: "photoDone" }, ME, deps);
    const done = await handleRegisterCallback(2, { kind: "unit", unit: "шт" }, ME, deps);
    assert.match(done.message?.text ?? "", /без фото/i);
    assert.ok(!calls.some((c) => c.startsWith("photo:")), "фото не грузили");
  });

  it("фото вне активного заведения игнорируется", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const res = await handleRegisterPhoto(
      3,
      { bytes: Buffer.from("x"), mime: "image/png" },
      ME,
      { core, conversations },
    );
    assert.equal(res, null);
  });

  it("отмена бросает визард", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    startRegister(4, deps);
    const res = await handleRegisterCallback(4, { kind: "cancel" }, ME, deps);
    assert.match(res.message?.text ?? "", /отменил/i);
    assert.equal(conversations.get(4), null);
  });

  it("кнопка после истёкшего визарда не падает, а зовёт начать заново", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    // визарда нет — сразу нажали «единицу»
    const res = await handleRegisterCallback(5, { kind: "unit", unit: "кг" }, ME, { core, conversations });
    assert.match(res.message?.text ?? "", /начни заново/i);
  });
});
