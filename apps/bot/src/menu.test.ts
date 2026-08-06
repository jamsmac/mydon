import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  helpText,
  matchMenuLabel,
  matchTrigger,
  menuFor,
  menuItemById,
  menuKeyboard,
  parseMenuCallback,
  STAFF_MENU,
} from "./menu";

describe("Реестр меню сотрудника", () => {
  it("подписи уникальны — иначе точное совпадение неоднозначно", () => {
    const labels = STAFF_MENU.map((i) => i.label);
    assert.equal(new Set(labels).size, labels.length);
  });

  it("id уникальны и укладываются в callback_data", () => {
    const ids = STAFF_MENU.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.ok(/^[a-z]{3,8}$/.test(id), `${id} не пройдёт parseMenuCallback`);
      assert.ok(Buffer.byteLength(`m:${id}`) <= 64, `${id} длиннее лимита Telegram`);
    }
  });

  it("в callback_data не попадает кириллица — иначе 64 байта кончатся на трёх буквах", () => {
    for (const i of STAFF_MENU) {
      assert.ok(!/[А-Яа-яЁё]/.test(`m:${i.id}`));
    }
  });
});

describe("Совпадение по подписи кнопки", () => {
  it("ловит точную подпись, включая эмодзи", () => {
    assert.equal(matchMenuLabel("📋 Мои задачи")?.id, "tasks");
    assert.equal(matchMenuLabel("  📥 Инкассация  ")?.id, "coll");
  });

  it("не ловит подпись внутри длинного текста", () => {
    // Иначе отчёт по задаче, где встретилось название пункта, открывал бы меню.
    assert.equal(matchMenuLabel("сделал 📋 Мои задачи и ушёл"), null);
    assert.equal(matchMenuLabel("задачи"), null, "это триггер, а не кнопка");
  });

  it("находит и неготовые пункты — чтобы объяснить, а не промолчать", () => {
    const sched = matchMenuLabel("🗓 Графики");
    assert.equal(sched?.id, "sched");
    assert.equal(sched?.ready, false);
  });
});

describe("Совпадение по слову", () => {
  it("ловит привычные формулировки", () => {
    assert.equal(matchTrigger("задачи")?.id, "tasks");
    assert.equal(matchTrigger("что делать")?.id, "tasks");
    assert.equal(matchTrigger("инкассация")?.id, "coll");
    assert.equal(matchTrigger("залил кофе")?.id, "refill");
    assert.equal(matchTrigger("помыл")?.id, "clean");
    assert.equal(matchTrigger("приход")?.id, "intake");
  });

  it("не ловит неготовые потоки", () => {
    // Пока мастера нет, слово должно уйти в общий разбор, а не запускать пустоту.
    assert.equal(matchTrigger("замена купюроприёмника"), null);
    assert.equal(matchTrigger("техосмотр"), null);
    assert.equal(matchTrigger("поломка"), null);
  });

  it("«точка» не считается словом раздела графиков", () => {
    // Регекс раздела содержит «то». Границу нельзя выразить через \b:
    // в JavaScript \b считается по [A-Za-z0-9_], кириллица словом не является,
    // и `то\b` не совпал бы вообще ни с чем — молча, без ошибки.
    const sched = STAFF_MENU.find((i) => i.id === "sched")!;
    assert.equal(sched.match("точка закрыта"), false);
    assert.equal(sched.match("товар кончился"), false);
    assert.equal(sched.match("тоже сделал"), false);
    assert.equal(sched.match("то по автомату"), true);
    assert.equal(sched.match("то"), true);
    assert.equal(sched.match("графики"), true);
    assert.equal(sched.match("обслуживание"), true);
  });
});

describe("Клавиатура меню", () => {
  it("по две кнопки в ряд", () => {
    const kb = menuKeyboard();
    for (const row of kb.keyboard) {
      assert.ok(row.length >= 1 && row.length <= 2, "три кнопки в ряд режут подписи на телефоне");
    }
    assert.equal(kb.keyboard.flat().length, menuFor().length);
  });

  it("постоянная и подстраивается по высоте", () => {
    const kb = menuKeyboard();
    assert.equal(kb.is_persistent, true);
    assert.equal(kb.resize_keyboard, true);
  });

  it("неготовые пункты в клавиатуру не попадают", () => {
    const shown = menuKeyboard().keyboard.flat().map((b) => b.text);
    assert.ok(!shown.includes("🗓 Графики"));
    assert.ok(shown.includes("📋 Мои задачи"));
  });

  it("у каждого показанного пункта есть обработчик — проверяем через id", () => {
    for (const item of menuFor()) {
      assert.ok(menuItemById(item.id), `${item.id} не находится по id`);
    }
  });
});

describe("Разбор inline-дубля меню", () => {
  it("принимает только известный формат", () => {
    assert.deepEqual(parseMenuCallback("m:tasks"), { id: "tasks" });
    assert.equal(parseMenuCallback("m:"), null);
    assert.equal(parseMenuCallback("m:задачи"), null);
    assert.equal(parseMenuCallback("t:tasks"), null);
    assert.equal(parseMenuCallback("m:tasks:extra"), null);
  });
});

describe("Справка", () => {
  it("строится из реестра и не расходится с кнопками", () => {
    const text = helpText();
    for (const item of menuFor()) {
      assert.ok(text.includes(item.label), `${item.label} потерялся в справке`);
    }
    assert.ok(!text.includes("🗓 Графики"), "неготовое обещать нельзя");
  });
});
