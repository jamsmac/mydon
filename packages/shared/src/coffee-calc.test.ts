import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECONCILE_THRESHOLD_RATIO,
  UNDERFILL_RATIO,
  buildLocationSummary,
  consumedSince,
  costOf,
  fillStatus,
  matchReturnsToRefills,
  netWeight,
  parseContainerReturnMessage,
  reconcileConsumption,
  type ContainerFillEvent,
  type ContainerReturnEvent,
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

describe("parseContainerReturnMessage — строки «позиция. набор. вес»", () => {
  it("реальное сообщение с заголовком точки (Кпп остатки, 30 июля)", () => {
    const res = parseContainerReturnMessage(
      "Кпп остатки\n1. 026. 1119\n2. 019. 1944\n3. 016. 1231\n4. 012. 1135\n5. 022. 1465\n6. 013. 902\n7. 007. 1116",
    );
    assert.equal(res.locationNote, "Кпп остатки");
    assert.equal(res.returns.length, 7);
    assert.deepEqual(res.returns[0], { position: 1, containerNumber: 26, weight: 1119 });
    assert.deepEqual(res.returns[6], { position: 7, containerNumber: 7, weight: 1116 });
    assert.deepEqual(res.rejected, []);
  });

  it("сообщение без заголовка, пробел вместо точки («7  024. 936») тоже разбирается", () => {
    const res = parseContainerReturnMessage("7. 027. 993\n1. 001. 893\n7  024. 936\n2. 015. 1086");
    assert.equal(res.locationNote, null);
    assert.equal(res.returns.length, 4);
    assert.deepEqual(res.returns[2], { position: 7, containerNumber: 24, weight: 936 });
  });

  it("числа вне диапазонов не чинятся, а уходят в rejected", () => {
    const res = parseContainerReturnMessage("9. 010. 500\n1. 030. 700\n2. 012. 555");
    assert.equal(res.returns.length, 1);
    assert.deepEqual(res.returns[0], { position: 2, containerNumber: 12, weight: 555 });
    assert.equal(res.rejected.length, 2);
  });

  it("обычный текст без числовых строк — не сообщение о возвратах", () => {
    const res = parseContainerReturnMessage("Привет, завтра приедем позже");
    assert.deepEqual(res, { returns: [], locationNote: null, rejected: [] });
  });
});

describe("matchReturnsToRefills — расход по наборам (заливка − возврат)", () => {
  const fill = (over: Partial<ContainerFillEvent> = {}): ContainerFillEvent => ({
    date: "2026-01-10",
    position: 7,
    containerNumber: 5,
    netWeight: 1000,
    locationId: "loc-1",
    locationName: "AH",
    ...over,
  });
  const ret = (over: Partial<ContainerReturnEvent> = {}): ContainerReturnEvent => ({
    date: "2026-01-17",
    position: 7,
    containerNumber: 5,
    netWeight: 400,
    ...over,
  });

  it("возврат закрывает предыдущую заливку той же пары: расход = fillNet − returnNet", () => {
    const rows = matchReturnsToRefills([fill()], [ret()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.consumedGrams, 600);
    assert.equal(rows[0]!.locationName, "AH", "расход относится к точке заливки");
  });

  it("цикл заливка→возврат→заливка→возврат: каждая пара считается отдельно", () => {
    const rows = matchReturnsToRefills(
      [fill(), fill({ date: "2026-01-20", netWeight: 900, locationName: "Кпп", locationId: "loc-2" })],
      [ret(), ret({ date: "2026-01-27", netWeight: 300 })],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.consumedGrams, 600);
    assert.equal(rows[1]!.consumedGrams, 600);
    assert.equal(rows[1]!.locationName, "Кпп", "второй период — уже на новой точке");
  });

  it("возврат тяжелее заливки — противоречие: consumedGrams=null, не отрицательный расход", () => {
    const rows = matchReturnsToRefills([fill({ netWeight: 300 })], [ret({ netWeight: 700 })]);
    assert.equal(rows[0]!.consumedGrams, null);
  });

  it("нет тары (netWeight null с любой стороны) — расход честно неизвестен", () => {
    assert.equal(matchReturnsToRefills([fill({ netWeight: null })], [ret()])[0]!.consumedGrams, null);
    assert.equal(matchReturnsToRefills([fill()], [ret({ netWeight: null })])[0]!.consumedGrams, null);
  });

  it("возврат без предыдущей заливки (история началась с возврата) — пропускается", () => {
    const rows = matchReturnsToRefills([fill({ date: "2026-02-01" })], [ret({ date: "2026-01-05" })]);
    assert.equal(rows.length, 0);
  });

  it("другая пара (набор, позиция) не подхватывается", () => {
    const rows = matchReturnsToRefills([fill({ containerNumber: 6 })], [ret()]);
    assert.equal(rows.length, 0);
  });

  it("два возврата после одной заливки: второй остаётся без пары, а не делит её", () => {
    const rows = matchReturnsToRefills([fill()], [ret(), ret({ date: "2026-01-25", netWeight: 100 })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.returnDate, "2026-01-17");
  });
});
