import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESERVE_ALLOWED,
  SALE_START_ALLOWED,
  UNIT_GROUPS,
  UNIT_STATUSES,
  UNIT_TRANSITIONS,
  unitTransitionError,
  VIN_UNBIND_ALLOWED,
} from "./unit-status";

/**
 * Transition-matrix тесты статусной машины единицы (§ сверки переноса):
 * каждый разрешённый переход + по одному запрещённому на действие.
 * fromStatuses — дословно из warehouse-pipeline PROMACH.
 */

describe("матрица переходов единицы техники", () => {
  it("каждый разрешённый исходный статус проходит", () => {
    for (const [action, t] of Object.entries(UNIT_TRANSITIONS)) {
      for (const from of t.from) {
        assert.equal(unitTransitionError(action, from), null, `${action} из ${from}`);
      }
    }
  });

  it("запрещённые исходные статусы отбиваются словами", () => {
    for (const [action, t] of Object.entries(UNIT_TRANSITIONS)) {
      const forbidden = UNIT_STATUSES.find((s) => !t.from.includes(s));
      assert.ok(forbidden, action);
      const err = unitTransitionError(action, forbidden);
      assert.ok(err !== null && err.includes("невозможен"), `${action} из ${forbidden}: ${err}`);
    }
  });

  it("ключевые fromStatuses донора — дословно", () => {
    assert.deepEqual(UNIT_TRANSITIONS["mark-ready-to-ship"].from, [
      "CONTRACT_SIGNED",
      "IN_PRODUCTION",
    ]);
    assert.deepEqual(UNIT_TRANSITIONS["mark-in-transit"].from, [
      "CUSTOMS_CLEARANCE",
      "AT_BORDER",
      "READY_FOR_SHIPMENT",
      "IN_TRANSIT_TO_BORDER",
    ]);
    assert.deepEqual(UNIT_TRANSITIONS["mark-customs-im74"].from, [
      "IN_TRANSIT_TO_UZ",
      "AT_BORDER",
      "CUSTOMS_CLEARANCE",
    ]);
    // ИМ-40 достижим и из ИМ-74 (временный ввоз → свободное обращение).
    assert.ok(UNIT_TRANSITIONS["mark-customs-im40"].from.includes("IM74"));
    assert.deepEqual(UNIT_TRANSITIONS["mark-delivered"].from, [
      "IM74",
      "IM40",
      "IN_TRANSIT_TO_UZ",
      "AT_BORDER",
    ]);
  });

  it("продвинутые статусы не откатываются: доставленную нельзя вернуть «в путь»", () => {
    assert.ok(unitTransitionError("mark-in-transit", "DELIVERED_TO_WH") !== null);
    assert.ok(unitTransitionError("mark-customs-im74", "IM40") !== null, "ИМ-40 назад в ИМ-74 нельзя");
  });

  it("неизвестное действие и неизвестный статус — отказ, не тихий пропуск", () => {
    assert.ok(unitTransitionError("teleport", "IN_STOCK") !== null);
    assert.ok(unitTransitionError("mark-sold", "НА_ЛУНЕ") !== null);
  });
});

describe("границы смежных правил", () => {
  it("откат VIN — только из IN_TRANSIT_TO_UZ и CONTRACT_SIGNED (skipped_advanced)", () => {
    assert.deepEqual([...VIN_UNBIND_ALLOWED], ["IN_TRANSIT_TO_UZ", "CONTRACT_SIGNED"]);
  });
  it("резерв — только со склада; старт продажи — склад или резерв", () => {
    assert.deepEqual([...RESERVE_ALLOWED], ["IN_STOCK", "DELIVERED_TO_WH"]);
    assert.deepEqual([...SALE_START_ALLOWED], ["IN_STOCK", "DELIVERED_TO_WH", "RESERVED"]);
  });
  it("групповые вкладки покрывают все 17 статусов без пересечений", () => {
    const seen = new Map<string, string>();
    for (const g of UNIT_GROUPS) {
      for (const s of g.statuses) {
        assert.ok(!seen.has(s), `статус ${s} в двух группах: ${seen.get(s)} и ${g.key}`);
        seen.set(s, g.key);
      }
    }
    assert.equal(seen.size, UNIT_STATUSES.length, "каждый статус — ровно в одной группе");
  });
});
