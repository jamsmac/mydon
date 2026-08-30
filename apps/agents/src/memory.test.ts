import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesSignature, signature } from "./memory";

describe("Сигнатура фактов (дельта-память)", () => {
  it("малая legacy-сигнатура сохраняет точный JSON-формат", () => {
    assert.equal(signature({ z: 2, a: "x" }), '{"a":"x","z":2}');
  });

  it("одинаковые факты → одинаковая сигнатура", () => {
    assert.equal(signature({ a: 1, b: 2 }), signature({ a: 1, b: 2 }));
  });

  it("порядок ключей не влияет", () => {
    assert.equal(signature({ a: 1, b: 2 }), signature({ b: 2, a: 1 }));
  });

  it("изменение значения меняет сигнатуру", () => {
    assert.notEqual(signature({ idleMachines: 4 }), signature({ idleMachines: 5 }));
  });

  it("пустые факты дают стабильную сигнатуру", () => {
    assert.equal(signature({}), signature({}));
    assert.equal(signature({}), "{}");
  });

  it("большие факты дают bounded SHA-256 сигнатуру", () => {
    const result = signature({ report: "x".repeat(1_000) });

    assert.ok(result.length <= 512);
    assert.match(result, /^sha256:[0-9a-f]{64}$/);
  });

  it("граница wire-контракта: 512 остаётся raw, 513 хешируется", () => {
    const atLimit = signature({ a: "x".repeat(504) });
    const overLimit = signature({ a: "x".repeat(505) });

    assert.equal(atLimit.length, 512);
    assert.match(atLimit, /^\{"a":"x+/);
    assert.equal(overLimit.length, 71);
    assert.match(overLimit, /^sha256:[0-9a-f]{64}$/);
  });

  it("большая сигнатура детерминирована и не зависит от порядка ключей", () => {
    const payload = "x".repeat(1_000);

    assert.equal(signature({ a: payload, b: 2 }), signature({ b: 2, a: payload }));
  });

  it("разные большие факты дают разные SHA-256 сигнатуры", () => {
    assert.notEqual(
      signature({ report: "x".repeat(1_000) }),
      signature({ report: "y".repeat(1_000) }),
    );
  });

  it("сравнивает новую bounded сигнатуру", () => {
    const facts = { report: "x".repeat(1_000) };

    assert.equal(matchesSignature(signature(facts), facts), true);
    assert.equal(matchesSignature(null, facts), false);
  });

  it("принимает старую raw-сигнатуру больших cron-фактов", () => {
    const facts = { a: "x".repeat(1_000), b: 2 };
    const legacy = JSON.stringify(facts);

    assert.ok(legacy.length > 512);
    assert.equal(matchesSignature(legacy, facts), true);
    assert.equal(matchesSignature(legacy, { ...facts, b: 3 }), false);
  });
});
