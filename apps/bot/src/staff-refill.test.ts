import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterItemKeyboard,
  cancelText,
  isRefillTrigger,
  newRunId,
  parseCount,
  parseRefillCallback,
  plural,
  productKeyboard,
  readState,
  recordItem,
  refillClientKey,
  refillStepHint,
  summaryText,
  type RefillState,
} from "./staff-refill";
import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";

const PERSON = { id: "11111111-1111-4111-8111-111111111111", name: "Володя" } as PersonRow;

const state = (over: Partial<RefillState> = {}): RefillState => ({
  runId: "run1",
  machineId: "22222222-2222-4222-8222-222222222222",
  machineSerial: "MU-7",
  machineName: "Parus F4",
  index: 0,
  items: [],
  choices: ["Coca-Cola 0.5", "Snickers"],
  pending: "Coca-Cola 0.5",
  ...over,
});

function deps(createRefill: CoreClient["createRefill"]) {
  return { core: { createRefill } as unknown as CoreClient, conversations: {} as Conversations };
}

describe("Заливка автомата: разбор ввода", () => {
  it("ловит формулировки техника", () => {
    for (const t of ["заполнил автомат", "заправил", "пополнил Parus", "загрузил автомат"]) {
      assert.ok(isRefillTrigger(t), t);
    }
    assert.ok(!isRefillTrigger("залил кофе"), "кофейная заливка — другой мастер");
  });

  it("количество — целые штуки", () => {
    assert.equal(parseCount("12"), 12);
    assert.equal(parseCount(" 7 "), 7);
    assert.equal(parseCount("0"), null, "ноль штук — не заливка");
    assert.equal(parseCount("12.5"), null, "половины батончика не бывает");
    assert.equal(parseCount("-3"), null);
    assert.equal(parseCount("много"), null);
    assert.equal(parseCount("99999"), null, "пятизначное — почти наверняка промах");
  });

  it("кнопки разбираются строго, мусор отклоняется", () => {
    assert.deepEqual(parseRefillCallback("rf:cancel"), { kind: "cancel" });
    assert.deepEqual(parseRefillCallback("rf:more"), { kind: "more" });
    assert.deepEqual(parseRefillCallback("rf:done"), { kind: "done" });
    assert.deepEqual(parseRefillCallback("rf:p:3"), { kind: "product", name: "", index: 3 });
    assert.equal(parseRefillCallback("rf:p:abc"), null);
    assert.equal(parseRefillCallback("rf:p:"), null);
    assert.equal(parseRefillCallback("i:cancel"), null, "чужое пространство кнопок");
    assert.equal(parseRefillCallback(""), null);
  });

  it("подсказка зависит от шага", () => {
    assert.match(refillStepHint("count"), /числом/);
    assert.match(refillStepHint("product"), /товар/);
  });
});

describe("Заливка автомата: ключ идемпотентности", () => {
  it("одна позиция — один ключ, разные позиции — разные", () => {
    assert.equal(refillClientKey("run1", 0), "rf:run1:0");
    assert.notEqual(refillClientKey("run1", 0), refillClientKey("run1", 1));
  });

  it("два обхода одного автомата не пересекаются", () => {
    // Иначе второй техник, зашедший следом, «повторил» бы чужую позицию,
    // и его заливка не записалась бы вовсе.
    const a = newRunId(1_700_000_000_000, () => 0.1);
    const b = newRunId(1_700_000_000_000, () => 0.9);
    assert.notEqual(a, b);
    assert.notEqual(refillClientKey(a, 0), refillClientKey(b, 0));
  });
});

describe("Заливка автомата: запись позиции", () => {
  it("пишет позицию, двигает индекс и показывает остаток", async () => {
    const calls: unknown[] = [];
    const d = deps((async (input) => {
      calls.push(input);
      return { refill: { id: "r1" }, stockLeft: 14, duplicate: false };
    }) as CoreClient["createRefill"]);

    const res = await recordItem(state(), 6, PERSON, d);
    assert.equal(res.state.index, 1);
    assert.equal(res.state.pending, undefined);
    assert.deepEqual(res.state.items, [{ product: "Coca-Cola 0.5", qty: 6, left: 14 }]);
    assert.match(res.reply.text, /Coca-Cola 0\.5 — 6 шт/);
    assert.match(res.reply.text, /осталось 14/);
    assert.deepEqual(calls, [
      {
        machineSerial: "MU-7",
        machineId: "22222222-2222-4222-8222-222222222222",
        productName: "Coca-Cola 0.5",
        qty: 6,
        personId: PERSON.id,
        clientKey: "rf:run1:0",
        createdBy: `person:${PERSON.id}`,
      },
    ]);
  });

  it("минусовой остаток объясняется словами, а не просто числом", async () => {
    const d = deps((async () => ({
      refill: { id: "r1" },
      stockLeft: -4,
      duplicate: false,
    })) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 6, PERSON, d);
    assert.match(res.reply.text, /склад давно не пересчитывали/i);
  });

  it("сбой сети не двигает индекс — повтор пойдёт тем же ключом", async () => {
    // Если запись всё-таки прошла на сервере, повтор тем же ключом вернёт её
    // же и не спишет склад второй раз. Сдвинь мы индекс — получили бы дубль.
    const d = deps((async () => {
      throw new Error("ECONNRESET");
    }) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 6, PERSON, d);
    assert.equal(res.state.index, 0);
    assert.deepEqual(res.state.items, []);
    assert.match(res.reply.text, /записанное сохранено/i);
  });

  it("после позиции предлагает продолжить обход или закончить", async () => {
    const d = deps((async () => ({
      refill: { id: "r1" },
      stockLeft: 1,
      duplicate: false,
    })) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 1, PERSON, d);
    const buttons = res.reply.keyboard?.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(buttons, ["rf:more", "rf:done"]);
  });
});

describe("Заливка автомата: тексты", () => {
  it("отмена после записанных позиций не пугает техника", () => {
    // Он должен понять, что записанное на месте, а не искать его в панели.
    assert.match(cancelText(3), /записано 3 позиции — они сохранены/i);
    assert.match(cancelText(0), /ничего не записано/i);
  });

  it("склонения не ломаются на 1, 2 и 11", () => {
    assert.equal(plural(1), "позицию");
    assert.equal(plural(3), "позиции");
    assert.equal(plural(5), "позиций");
    assert.equal(plural(11), "позиций");
    assert.equal(plural(21), "позицию");
  });

  it("итог перечисляет записанное с остатком", () => {
    const t = summaryText([
      { product: "Coca-Cola 0.5", qty: 6, left: 14 },
      { product: "Snickers", qty: 4, left: null },
    ]);
    assert.match(t, /Записал 2 позиции/);
    assert.match(t, /Coca-Cola 0\.5 — 6 шт\. \(на складе 14\)/);
    assert.match(t, /Snickers — 4 шт\.$/m, "без остатка — без скобок");
  });

  it("клавиатура товаров ограничена и всегда даёт выход", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Товар ${i}`);
    const kb = productKeyboard(many);
    const last = kb.inline_keyboard.slice(-2).flat().map((b) => b.callback_data);
    assert.deepEqual(last, ["rf:other", "rf:cancel"]);
    assert.equal(kb.inline_keyboard.length, 22, "20 товаров + «другой» + «отмена»");
  });

  it("пустое зеркало не ломает клавиатуру", () => {
    // Сбор Ourvend может быть выключен — тогда предлагаем ввести имя руками.
    const kb = productKeyboard([]);
    assert.deepEqual(
      kb.inline_keyboard.flat().map((b) => b.callback_data),
      ["rf:other", "rf:cancel"],
    );
  });
});

describe("Заливка автомата: состояние визарда", () => {
  it("читается из памяти и проверяется по форме", () => {
    assert.ok(readState(state() as unknown as Record<string, unknown>));
    assert.equal(readState({}), null);
    assert.equal(readState({ runId: "r", machineSerial: "MU-7" }), null, "без индекса и списков");
  });

  it("клавиатура «ещё/готово» не содержит отмены", () => {
    // На этом шаге отменять уже нечего: позиция записана. Кнопка «Отмена»
    // здесь читалась бы как «удалить записанное».
    const b = afterItemKeyboard().inline_keyboard.flat().map((x) => x.callback_data);
    assert.ok(!b.includes("rf:cancel"));
  });
});
