import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { can } from "@mydon/shared";
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

/**
 * Оба действующих полевых сотрудника делают всю работу, поэтому в тестах
 * меню роли берутся полные. Урезанный доступ проверяется отдельно ниже:
 * в бою его сейчас не воспроизвести.
 */
const ALL: string[] = ["operator", "technician", "collector", "storekeeper"];
const matchTrigger2 = (text: string, roles: readonly string[] = ALL) => matchTrigger(text, roles);

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

  it("находит пункт независимо от готовности — чтобы объяснить, а не промолчать", () => {
    // matchMenuLabel намеренно НЕ фильтрует по ready: неготовому пункту надо
    // ответить «скоро включим», а не промолчать, будто кнопки не было.
    const sched = matchMenuLabel("🗓 Графики");
    assert.equal(sched?.id, "sched");
  });
});

describe("Совпадение по слову", () => {
  it("ловит привычные формулировки", () => {
    assert.equal(matchTrigger2("задачи")?.id, "tasks");
    assert.equal(matchTrigger2("что делать")?.id, "tasks");
    assert.equal(matchTrigger2("инкассация")?.id, "coll");
    assert.equal(matchTrigger2("залил кофе")?.id, "refill");
    assert.equal(matchTrigger2("помыл")?.id, "wash", "«помыл» техник говорит про бункер");
    assert.equal(matchTrigger2("чистка")?.id, "clean");
    assert.equal(matchTrigger2("замена купюроприёмника")?.id, "part");
    assert.equal(matchTrigger2("техосмотр")?.id, "insp");
    assert.equal(matchTrigger2("поломка")?.id, "issue");
    assert.equal(matchTrigger2("приход")?.id, "intake");
  });

  it("по словам ловятся только готовые потоки", () => {
    // Слово от неготового мастера должно уйти в общий разбор, а не запускать
    // пустоту. Сейчас готовы все пункты, поэтому проверяем сам механизм.
    for (const item of STAFF_MENU) {
      if (item.ready) continue;
      assert.equal(matchTrigger2(item.label), null, `${item.id} не готов, но ловится словом`);
    }
    assert.equal(matchTrigger2("графики")?.id, "sched");
  });

  it("мойка бункера и чистка автомата не перехватывают друг друга", () => {
    // Это разные объекты учёта: точка с бункерами 1..8 против автомата с
    // узлами. Перепутав их, техник запишет работу не туда.
    assert.equal(matchTrigger2("помыл бункер")?.id, "wash");
    assert.equal(matchTrigger2("почистил бункер")?.id, "wash");
    assert.equal(matchTrigger2("чистка автомата")?.id, "clean");
    assert.equal(matchTrigger2("санобработка")?.id, "clean");
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
    const kb = menuKeyboard(ALL);
    for (const row of kb.keyboard) {
      assert.ok(row.length >= 1 && row.length <= 2, "три кнопки в ряд режут подписи на телефоне");
    }
    assert.equal(kb.keyboard.flat().length, menuFor(ALL).length);
  });

  it("постоянная и подстраивается по высоте", () => {
    const kb = menuKeyboard(ALL);
    assert.equal(kb.is_persistent, true);
    assert.equal(kb.resize_keyboard, true);
  });

  it("в клавиатуру попадают ровно готовые пункты", () => {
    const shown = menuKeyboard(ALL).keyboard.flat().map((b) => b.text);
    const expected = STAFF_MENU.filter((i) => i.ready && can(ALL, i.perm)).map((i) => i.label);
    assert.deepEqual(shown, expected);
    for (const item of STAFF_MENU) {
      if (!item.ready) assert.ok(!shown.includes(item.label), `${item.id} не готов, но показан`);
    }
  });

  it("у каждого показанного пункта есть обработчик — проверяем через id", () => {
    for (const item of menuFor(ALL)) {
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
    const text = helpText(ALL);
    for (const item of menuFor(ALL)) {
      assert.ok(text.includes(item.label), `${item.label} потерялся в справке`);
    }
    // Спрятанный правами пункт не должен всплыть в справке: иначе человек
    // прочтёт про кнопку, которой у него нет.
    assert.ok(!helpText(["collector"]).includes("🔧 Замена детали"));
    for (const item of STAFF_MENU) {
      if (!item.ready) assert.ok(!text.includes(item.label), "неготовое обещать нельзя");
    }
  });
});

describe("Урезанный доступ", () => {
  it("инкассатор не видит замену детали ни кнопкой, ни словом", () => {
    // В бою сейчас не воспроизвести: у обоих сотрудников полный набор ролей.
    // Проверяется тестом, чтобы третий человек добавлялся строкой в матрице,
    // а не переделкой меню.
    const labels = menuKeyboard(["collector"]).keyboard.flat().map((b) => b.text);
    assert.ok(!labels.includes("🔧 Замена детали"));
    assert.ok(labels.includes("📥 Инкассация"));
    assert.equal(matchTrigger("замена купюроприёмника", ["collector"]), null);
    assert.equal(matchTrigger("инкассация", ["collector"])?.id, "coll");
  });

  it("пустые роли оставляют базовое, но убирают остальное", () => {
    // Карточка заведена, роли проставить не успели — бот обязан работать.
    // В базовое входит и «Поломка»: увидевший сломанный автомат должен уметь
    // сказать об этом, какие бы роли ему ни забыли проставить.
    const labels = menuKeyboard([]).keyboard.flat().map((b) => b.text);
    assert.deepEqual(labels, ["📋 Мои задачи", "⚠️ Поломка", "↩️ Ошибся — исправить"]);
    assert.ok(!labels.includes("📥 Инкассация"), "деньги базовым правом не даются");
  });
});

describe("Пункт без мастера не показывается и не ловится словом", () => {
  it("«Заполнил автомат» скрыт: мастера нет, а кнопка стирала бы начатое", () => {
    // В staff-refill.ts лежат только заготовки — входной точки нет,
    // startMenuItem падал в default. При этом нажатие СНАЧАЛА гасило беседу и
    // лишь потом отвечало «пока не готово»: обход с выбранной точкой исчезал
    // ради пункта, который ничего не делает.
    const labels = menuKeyboard(["operator"]).keyboard.flat().map((b) => b.text);
    assert.ok(!labels.includes("📦 Заполнил автомат"), "кнопки нет");
    assert.equal(matchTrigger("заполнил автомат", ["operator"]), null, "и слово не ловится");
    assert.equal(matchMenuLabel("📦 Заполнил автомат"), null, "и подпись не срабатывает");
  });

  it("остальные полевые пункты у оператора на месте", () => {
    const labels = menuKeyboard(["operator"]).keyboard.flat().map((b) => b.text);
    for (const want of ["☕ Заливка бункера", "💧 Расходники", "🧼 Мойка бункера"]) {
      assert.ok(labels.includes(want), want);
    }
  });
});
