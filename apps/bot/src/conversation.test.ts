import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";

describe("Визард-состояние сотрудника", () => {
  it("начинает и читает визард", () => {
    const c = new Conversations();
    c.start(1, "register", "name", { type: "ingredient" });
    const cur = c.get(1);
    assert.equal(cur?.flow, "register");
    assert.equal(cur?.step, "name");
    assert.equal(cur?.data.type, "ingredient");
  });

  it("advance двигает шаг и копит данные", () => {
    const c = new Conversations();
    c.start(1, "register", "type");
    c.advance(1, "name", { type: "ingredient" });
    c.advance(1, "photo", { name: "Зёрна" });
    const cur = c.get(1);
    assert.equal(cur?.step, "photo");
    assert.deepEqual(cur?.data, { type: "ingredient", name: "Зёрна" });
  });

  it("advance на несуществующем визарде — null", () => {
    const c = new Conversations();
    assert.equal(c.advance(1, "name"), null);
  });

  it("протухает по TTL", () => {
    const c = new Conversations(1000);
    c.start(1, "register", "name", {}, 0);
    assert.ok(c.get(1, 500), "в пределах TTL — жив");
    assert.equal(c.get(1, 2000), null, "после TTL — протух");
  });

  it("новый start перетирает брошенный", () => {
    const c = new Conversations();
    c.start(1, "register", "name", { a: 1 });
    c.start(1, "inventory", "warehouse", { b: 2 });
    assert.equal(c.get(1)?.flow, "inventory");
    assert.equal(c.get(1)?.data.a, undefined);
  });

  it("clear завершает", () => {
    const c = new Conversations();
    c.start(1, "register", "name");
    c.clear(1);
    assert.equal(c.get(1), null);
  });

  it("sweep убирает только протухшие", () => {
    const c = new Conversations(1000);
    c.start(1, "register", "a", {}, 0);
    c.start(2, "register", "b", {}, 1500);
    c.sweep(2000); // #1 протух (2000-0>1000), #2 жив (2000-1500<1000)
    assert.equal(c.get(1, 2000), null);
    assert.ok(c.get(2, 2000));
  });
});
