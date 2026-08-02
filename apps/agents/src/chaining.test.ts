import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractNext } from "./chaining";

describe("extractNext — follow-up между агентами", () => {
  it("инлайн через точку с запятой", () => {
    assert.deepEqual(extractNext("итог\nNEXT: a; b ; c"), ["a", "b", "c"]);
  });

  it("маркерами под NEXT, конец на немаркированной строке", () => {
    assert.deepEqual(extractNext("x\nNEXT:\n- one\n- two\n\nдальше текст"), ["one", "two"]);
  });

  it("нет блока → пусто", () => {
    assert.deepEqual(extractNext("нет блока тут"), []);
  });

  it("пустой/undefined вход → пусто", () => {
    assert.deepEqual(extractNext(""), []);
    assert.deepEqual(extractNext(undefined as unknown as string), []);
  });

  it("не больше 10 пунктов", () => {
    const many = "NEXT: " + Array.from({ length: 15 }, (_, i) => `p${i}`).join("; ");
    assert.equal(extractNext(many).length, 10);
  });
});
