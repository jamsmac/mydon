import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  finalLifecycle,
  IMPORT_LIFECYCLE,
  lifecycleFromUnits,
  lifecycleRank,
  monotonicLifecycleStep,
} from "./import-lifecycle";

/** Монотонный lifecycle импортного контракта — правила донора + исправление paying. */

describe("ранги монотонности", () => {
  it("строго возрастают по конвейеру; paying получил ранг (баг донора исправлен)", () => {
    const order = ["draft", "signed", "paying", "shipping", "customs", "warehoused", "delivered", "closed"] as const;
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(
        lifecycleRank(order[i]!) > lifecycleRank(order[i - 1]!),
        `${order[i]} должен быть старше ${order[i - 1]}`,
      );
    }
  });
  it("контракт «в оплате» синк не утаскивает назад в signed (регресс донора)", () => {
    // У донора paying имел ранг 0 → computed 'signed' (ранг 1) «побеждал» и
    // контракт откатывался. Теперь signed младше paying — шаг null.
    assert.equal(monotonicLifecycleStep("paying", "signed"), null);
    assert.equal(monotonicLifecycleStep("paying", "shipping"), "shipping");
  });
});

describe("lifecycleFromUnits — фаза из статусов единиц", () => {
  it("приоритет: склад > таможня > отгрузка > подписан", () => {
    assert.equal(lifecycleFromUnits(["CONTRACT_SIGNED", "IM40"]), "warehoused");
    assert.equal(lifecycleFromUnits(["CONTRACT_SIGNED", "IM74"]), "customs");
    assert.equal(lifecycleFromUnits(["CONTRACT_SIGNED", "IN_TRANSIT_TO_UZ"]), "shipping");
    assert.equal(lifecycleFromUnits(["CONTRACT_SIGNED", "IN_PRODUCTION"]), "signed");
  });
  it("CANCELLED/ARCHIVED исключаются; пусто → null (no-op)", () => {
    assert.equal(lifecycleFromUnits(["CANCELLED", "IM40"]), "warehoused");
    assert.equal(lifecycleFromUnits(["CANCELLED", "ARCHIVED"]), null);
    assert.equal(lifecycleFromUnits([]), null);
  });
});

describe("monotonicLifecycleStep — только вперёд", () => {
  it("вперёд двигает, назад и на месте — null", () => {
    assert.equal(monotonicLifecycleStep("signed", "customs"), "customs");
    assert.equal(monotonicLifecycleStep("customs", "shipping"), null);
    assert.equal(monotonicLifecycleStep("customs", "customs"), null);
  });
  it("closed и cancelled заморожены навсегда", () => {
    assert.equal(monotonicLifecycleStep("closed", "warehoused"), null);
    assert.equal(monotonicLifecycleStep("cancelled", "signed"), null);
  });
});

describe("finalLifecycle — delivered и closed", () => {
  it("delivered: все единицы в актах И с договором; closed: + всё оплачено", () => {
    const units = [
      { inHandoverAct: true, hasSaleContract: true },
      { inHandoverAct: true, hasSaleContract: true },
    ];
    assert.equal(finalLifecycle({ activeUnits: units, allSaleContractsPaid: false }), "delivered");
    assert.equal(finalLifecycle({ activeUnits: units, allSaleContractsPaid: true }), "closed");
  });
  it("одна единица без акта или без договора — рано (null)", () => {
    assert.equal(
      finalLifecycle({
        activeUnits: [
          { inHandoverAct: true, hasSaleContract: true },
          { inHandoverAct: false, hasSaleContract: true },
        ],
        allSaleContractsPaid: true,
      }),
      null,
    );
    assert.equal(
      finalLifecycle({
        activeUnits: [{ inHandoverAct: true, hasSaleContract: false }],
        allSaleContractsPaid: true,
      }),
      null,
    );
  });
  it("без активных единиц — null, а не ложный delivered", () => {
    assert.equal(finalLifecycle({ activeUnits: [], allSaleContractsPaid: true }), null);
  });
  it("словарь фаз полон", () => {
    assert.equal(IMPORT_LIFECYCLE.length, 9);
  });
});
