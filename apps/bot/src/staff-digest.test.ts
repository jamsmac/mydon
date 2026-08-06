import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersonRow, TaskRow } from "./core-client";
import { buildDigest, digestKey } from "./staff-digest";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "оператор",
  // Оба действующих сотрудника делают всю работу.
  roles: ["operator", "technician", "collector", "storekeeper"],
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
};

let seq = 0;
function task(over: Partial<TaskRow> = {}): TaskRow {
  seq += 1;
  return {
    id: `2222222${seq}-2222-4222-8222-222222222222`.slice(0, 36),
    title: `Работа ${seq}`,
    description: null,
    ownerKind: "human",
    ownerRef: ME.id,
    status: "todo",
    priority: "normal",
    due: null,
    resultNote: null,
    entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...over,
  };
}

const NAMES = new Map([
  ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Kaffit-04"],
  ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Snack-11"],
]);

describe("Утренний дайджест", () => {
  it("пустой день не рассылается вовсе", () => {
    // Сообщение «у тебя ноль задач» каждое утро приучает его не читать.
    assert.equal(buildDigest({ person: ME, mine: [], free: [] }), null);
  });

  it("свои задачи группируются по объекту, а не по виду работ", () => {
    // Техник ездит по точкам: «три дела на Kaffit-04» — это один заезд.
    const d = buildDigest({
      person: ME,
      mine: [
        task({ entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        task({ entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
        task({ entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      ],
      free: [],
      objectNames: NAMES,
    })!;
    const lines = d.text.split("\n").filter((l) => l.includes("Kaffit-04") || l.includes("Snack-11"));
    assert.deepEqual(
      lines.map((l) => (l.includes("Kaffit") ? "K" : "S")),
      ["K", "K", "S"],
      "две работы на одной точке должны идти подряд",
    );
  });

  it("блок свободных не рисуется при пустом пуле", () => {
    const d = buildDigest({ person: ME, mine: [task()], free: [], objectNames: NAMES })!;
    assert.ok(!d.text.includes("Свободные"), "пустой заголовок читается как поломка");
  });

  it("свободные получают кнопку «Взять», свои — «открыть»", () => {
    const d = buildDigest({
      person: ME,
      mine: [task()],
      free: [task({ ownerRef: null })],
      objectNames: NAMES,
    })!;
    const data = d.keyboard!.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(data.some((c) => c.endsWith(":open")));
    assert.ok(data.some((c) => c.endsWith(":claim")));
  });

  it("нумерация сквозная: свободные продолжают список своих", () => {
    // Иначе «взять 1» относилось бы сразу к двум строкам сообщения.
    const d = buildDigest({
      person: ME,
      mine: [task(), task()],
      free: [task({ ownerRef: null })],
      objectNames: NAMES,
    })!;
    assert.match(d.text, /^3 /m, "третья строка — первая свободная");
    assert.ok(d.keyboard!.inline_keyboard.flat().some((b) => b.text.startsWith("✋ Взять 3")));
  });

  it("длинный пул сворачивается, а не вываливается целиком", () => {
    const free = Array.from({ length: 12 }, () => task({ ownerRef: null }));
    const d = buildDigest({ person: ME, mine: [], free, objectNames: NAMES })!;
    assert.match(d.text, /и ещё 7 свободных/);
    assert.ok(d.keyboard!.inline_keyboard.length <= 5);
  });

  it("одни свободные без своих — тоже повод написать", () => {
    // Иначе человек, у которого сегодня ничего не назначено, не узнает,
    // что в общем списке горит работа.
    const d = buildDigest({ person: ME, mine: [], free: [task({ ownerRef: null })], objectNames: NAMES });
    assert.ok(d);
    assert.match(d!.text, /на тебе сейчас|Свободные/i);
  });

  it("счётчик сделанного показывается, если он передан", () => {
    const d = buildDigest({ person: ME, mine: [task(), task()], free: [], doneToday: 1, objectNames: NAMES })!;
    assert.match(d.text, /Сделано сегодня: 1 из 2/);
  });

  it("объект без имени не ломает группировку", () => {
    const d = buildDigest({ person: ME, mine: [task({ entityId: null })], free: [] })!;
    assert.match(d.text, /Без объекта/);
  });

  it("склонение «дело/дела/дел» человеческое", () => {
    const of = (n: number) =>
      buildDigest({ person: ME, mine: Array.from({ length: n }, () => task()), free: [] })!.text;
    assert.match(of(1), /1 дело/);
    assert.match(of(3), /3 дела/);
    // Не \b: в JavaScript граница слова считается по [A-Za-z0-9_], кириллица
    // словом не является, и /дел\b/ не совпало бы ни с чем.
    assert.match(of(5), /5 дел:/);
    assert.match(of(11), /11 дел:/, "одиннадцать — не «дело»");
  });

  it("сообщение укладывается в лимит Telegram при полном списке", () => {
    const d = buildDigest({
      person: ME,
      mine: Array.from({ length: 30 }, () => task({ title: "Длинное название работы на автомате" })),
      free: Array.from({ length: 10 }, () => task({ ownerRef: null })),
      objectNames: NAMES,
    })!;
    assert.ok(d.text.length <= 4096, `${d.text.length} символов — Telegram обрежет`);
  });
});

describe("Ключ идемпотентности рассылки", () => {
  it("уникален по дню и человеку", () => {
    assert.equal(digestKey("2026-08-06", ME.id), `staff-digest:2026-08-06:${ME.id}`);
    assert.notEqual(digestKey("2026-08-06", ME.id), digestKey("2026-08-07", ME.id));
  });
});
