import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECONCILE_THRESHOLD_RATIO,
  UNDERFILL_RATIO,
  buildLocationSummary,
  consumedSince,
  costOf,
  fillStatus,
  netWeight,
  reconcileConsumption,
  type LatestRefillRow,
} from "./coffee-calc";

describe("Кофе-бункеры: чистый вес и расход (§ item — coffee bunkers)", () => {
  it("netWeight вычитает тару; без тары — null, а не сырой вес выдаётся за чистый", () => {
    assert.equal(netWeight(1200, 620), 580);
    assert.equal(netWeight(1200, null), null);
  });

  it("consumedSince — разница между прошлой заливкой и текущим замером «до»", () => {
    assert.equal(consumedSince(580, 200), 380); // засыпали 580, застали 200 — ушло 380
    assert.equal(consumedSince(580, 580), 0); // не расходовали
  });

  it("consumedSince: отрицательный расход (телеметрия противоречит себе) — null, не отрицательное число", () => {
    assert.equal(consumedSince(200, 580), null); // «до» больше, чем было засыпано — ерунда
  });

  it("consumedSince: нет одной из сторон — null", () => {
    assert.equal(consumedSince(null, 200), null);
    assert.equal(consumedSince(580, null), null);
  });

  it("costOf — грамм × цена за грамм; без цены или без грамм — null, не ноль", () => {
    assert.equal(costOf(380, 80), 30400); // 380г кофе по 80 сум/г
    assert.equal(costOf(null, 80), null);
    assert.equal(costOf(380, null), null, "цена не заведена — себестоимость неизвестна, а не 0");
  });
});

describe("Кофе-бункеры: недолив заливки (fillStatus)", () => {
  it("залили по норме или больше — ok", () => {
    const r = fillStatus(600, 600);
    assert.equal(r.status, "ok");
    assert.equal(r.fillRatio, 1);
    assert.equal(fillStatus(650, 600).status, "ok");
  });

  it("залили заметно меньше нормы — underfill", () => {
    const r = fillStatus(400, 600, UNDERFILL_RATIO); // 400/600 ≈ 0.67 < 0.85
    assert.equal(r.status, "underfill");
    assert.ok(r.fillRatio! < UNDERFILL_RATIO);
  });

  it("ровно на границе порога — ok (порог — «ниже», не «на»)", () => {
    const target = 600;
    const atThreshold = target * UNDERFILL_RATIO;
    assert.equal(fillStatus(atThreshold, target).status, "ok");
    assert.equal(fillStatus(atThreshold - 1, target).status, "underfill");
  });

  it("нет эталона или нет факта — unknown, не молчаливый ok", () => {
    assert.equal(fillStatus(400, null).status, "unknown");
    assert.equal(fillStatus(null, 600).status, "unknown");
    assert.equal(fillStatus(400, 0).status, "unknown", "эталон 0 — бессмысленное деление, не считаем недоливом");
  });
});

describe("Кофе-бункеры: сверка факт/ожидание (reconcileConsumption)", () => {
  it("расхождение в пределах порога — ok", () => {
    const r = reconcileConsumption(1000, 950, RECONCILE_THRESHOLD_RATIO);
    assert.equal(r.status, "ok");
    assert.equal(r.deltaGrams, 50);
  });

  it("расхождение сверх порога — anomaly", () => {
    const r = reconcileConsumption(1300, 1000, RECONCILE_THRESHOLD_RATIO);
    assert.equal(r.status, "anomaly");
    assert.ok(r.deltaRatio! > RECONCILE_THRESHOLD_RATIO);
  });

  it("нечем сверить (одна из сторон null) — unknown, не молчаливый ok", () => {
    assert.equal(reconcileConsumption(null, 1000).status, "unknown");
    assert.equal(reconcileConsumption(1000, null).status, "unknown");
  });

  it("ожидание 0 (продаж не было), но фактический расход есть — anomaly", () => {
    const r = reconcileConsumption(200, 0);
    assert.equal(r.status, "anomaly");
  });

  it("ожидание 0 и факт 0 — ok", () => {
    assert.equal(reconcileConsumption(0, 0).status, "ok");
  });
});

describe("Кофе-бункеры: сводная таблица по точкам (buildLocationSummary)", () => {
  it("каждая точка присутствует в результате, даже без заливок (пустая строка, не потеряна)", () => {
    const rows = buildLocationSummary(["AH", "Grand clinic"], []);
    assert.deepEqual(
      rows.map((r) => r.location),
      ["AH", "Grand clinic"],
    );
    assert.deepEqual(rows[0]!.byPosition, {});
  });

  it("раскладывает последние заливки по (точка, позиция)", () => {
    const latest: LatestRefillRow[] = [
      { locationName: "AH", position: 1, packageCount: 2, filledWeight: 1200 },
      { locationName: "AH", position: 7, packageCount: 1, filledWeight: 630 },
      { locationName: "Grand clinic", position: 1, packageCount: 1, filledWeight: 600 },
    ];
    const rows = buildLocationSummary(["AH", "Grand clinic"], latest);
    const ah = rows.find((r) => r.location === "AH")!;
    assert.deepEqual(ah.byPosition[1], { packageCount: 2, weight: 1200 });
    assert.deepEqual(ah.byPosition[7], { packageCount: 1, weight: 630 });
    assert.equal(ah.byPosition[3], undefined);
    const grand = rows.find((r) => r.location === "Grand clinic")!;
    assert.deepEqual(grand.byPosition[1], { packageCount: 1, weight: 600 });
  });
});
