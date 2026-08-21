import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateFEFO, type FefoBatch } from "./fefo";

const d = (s: string): Date => new Date(s + "T00:00:00Z");

// Все 7 донорских тестов (mydon_1/src/lib/vendhub/product-stock/fefo.test.ts),
// batchId адаптирован number → string (R-C3). Плюс случаи для нашей дробной
// области (см. task-2-brief.md), которых у штучного донора не было.
describe("allocateFEFO", () => {
  it("одна партия — хватает", () => {
    const b: FefoBatch[] = [{ batchId: "b1", remaining: 10, expiryAt: null, receivedAt: d("2026-01-01") }];
    assert.deepEqual(allocateFEFO(4, b), [{ batchId: "b1", qty: 4 }]);
  });

  it("expiry-приоритет: раньше истекает — раньше уходит", () => {
    const b: FefoBatch[] = [
      { batchId: "b1", remaining: 5, expiryAt: d("2026-05-01"), receivedAt: d("2026-01-01") },
      { batchId: "b2", remaining: 5, expiryAt: d("2026-03-01"), receivedAt: d("2026-02-01") },
    ];
    assert.deepEqual(allocateFEFO(7, b), [
      { batchId: "b2", qty: 5 },
      { batchId: "b1", qty: 2 },
    ]);
  });

  it("nulls last, затем receivedAt asc", () => {
    const b: FefoBatch[] = [
      { batchId: "b1", remaining: 3, expiryAt: null, receivedAt: d("2026-01-01") },
      { batchId: "b2", remaining: 3, expiryAt: null, receivedAt: d("2026-02-01") },
      { batchId: "b3", remaining: 3, expiryAt: d("2026-06-01"), receivedAt: d("2026-03-01") },
    ];
    // сперва партия со сроком (3), потом null по receivedAt: b1 (3), потом b2 (1)
    assert.deepEqual(allocateFEFO(7, b), [
      { batchId: "b3", qty: 3 },
      { batchId: "b1", qty: 3 },
      { batchId: "b2", qty: 1 },
    ]);
  });

  it("нехватка партий → хвост batchId null", () => {
    const b: FefoBatch[] = [{ batchId: "b1", remaining: 3, expiryAt: null, receivedAt: d("2026-01-01") }];
    assert.deepEqual(allocateFEFO(5, b), [
      { batchId: "b1", qty: 3 },
      { batchId: null, qty: 2 },
    ]);
  });

  it("нет партий → весь need без batchId", () => {
    assert.deepEqual(allocateFEFO(4, []), [{ batchId: null, qty: 4 }]);
  });

  it("need 0 → пусто; пустые/нулевые партии пропускаются", () => {
    assert.deepEqual(
      allocateFEFO(0, [{ batchId: "b1", remaining: 5, expiryAt: null, receivedAt: d("2026-01-01") }]),
      [],
    );
    const b: FefoBatch[] = [{ batchId: "b1", remaining: 0, expiryAt: null, receivedAt: d("2026-01-01") }];
    assert.deepEqual(allocateFEFO(3, b), [{ batchId: null, qty: 3 }]);
  });

  it("Σ долей = need (когда партий хватает)", () => {
    const b: FefoBatch[] = [
      { batchId: "b1", remaining: 4, expiryAt: null, receivedAt: d("2026-01-01") },
      { batchId: "b2", remaining: 9, expiryAt: null, receivedAt: d("2026-02-01") },
    ];
    const legs = allocateFEFO(11, b);
    assert.equal(
      legs.reduce((s, l) => s + l.qty, 0),
      11,
    );
    assert.equal(
      legs.every((l) => l.batchId !== null),
      true,
    );
  });

  // --- Добавлено под нашу дробную область (не было у штучного донора) ---

  it("дробный расход: партии 1.5 и 2.25 кг, нужно 3.0 → доли 1.5 и 1.5, хвоста нет", () => {
    const b: FefoBatch[] = [
      { batchId: "b1", remaining: 1.5, expiryAt: null, receivedAt: d("2026-01-01") },
      { batchId: "b2", remaining: 2.25, expiryAt: null, receivedAt: d("2026-02-01") },
    ];
    assert.deepEqual(allocateFEFO(3.0, b), [
      { batchId: "b1", qty: 1.5 },
      { batchId: "b2", qty: 1.5 },
    ]);
  });

  it("нехватка на дробных: нужно 5.0, есть 1.5 → доля 1.5 + хвост 3.5 batchId null", () => {
    const b: FefoBatch[] = [{ batchId: "b1", remaining: 1.5, expiryAt: null, receivedAt: d("2026-01-01") }];
    assert.deepEqual(allocateFEFO(5.0, b), [
      { batchId: "b1", qty: 1.5 },
      { batchId: null, qty: 3.5 },
    ]);
  });

  it("партия без срока уходит последней, даже если получена раньше партии со сроком", () => {
    const b: FefoBatch[] = [
      // получена раньше (январь), но срока нет
      { batchId: "no-expiry", remaining: 2, expiryAt: null, receivedAt: d("2026-01-01") },
      // получена позже (июнь), но срок задан — по FEFO должна уйти первой целиком
      { batchId: "with-expiry", remaining: 2, expiryAt: d("2026-12-01"), receivedAt: d("2026-06-01") },
    ];
    assert.deepEqual(allocateFEFO(3, b), [
      { batchId: "with-expiry", qty: 2 },
      { batchId: "no-expiry", qty: 1 },
    ]);
  });

  it("эпсилон гасит фиктивный хвост от накопленной погрешности need (0.1+0.2 !== 0.3)", () => {
    const b: FefoBatch[] = [{ batchId: "b1", remaining: 0.3, expiryAt: null, receivedAt: d("2026-01-01") }];
    // need получен как сумма дробных долей извне (например, из потребности по
    // рецептам) — побитово НЕ равен remaining партии, хотя по смыслу партия
    // покрывает потребность день-в-день. Без EPS здесь появился бы фиктивный
    // хвост {batchId: null, qty: ~4.44e-17}.
    const need = 0.1 + 0.2;
    const legs = allocateFEFO(need, b);
    assert.equal(legs.length, 1);
    assert.deepEqual(legs, [{ batchId: "b1", qty: 0.3 }]);
  });
});
