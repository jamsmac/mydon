import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commissionFlatBonus,
  commissionMarginRate,
  commissionTiers,
  computeCommission,
  DEFAULT_COMMISSION_TIERS,
  pickTier,
  type CommissionTier,
} from "./commission";

/**
 * Golden-тесты трёх методов комиссии — формулы донора дословно.
 * Какой метод действует — выбирает владелец тумблером; здесь фиксируется,
 * что каждый метод считает ровно как его исходник в PROMACH.
 */

describe("метод 1: margin_rate (sales-analytics)", () => {
  it("Math.round(margin × rate) / 100 — округление ПОСЛЕ умножения", () => {
    // margin = 12 345.678; rate 1.5% → 12345.678×1.5 = 18 518.517 → 18519 → 185.19
    assert.equal(
      commissionMarginRate({ salePrice: 22_345.678, costTotal: 10_000, ratePct: 1.5 }),
      185.19,
    );
  });
  it("маржа 100 млн × 2.5% → 2 500 000 (числа порядка сделки HELI)", () => {
    assert.equal(
      commissionMarginRate({ salePrice: 500_000_000, costTotal: 400_000_000, ratePct: 2.5 }),
      2_500_000,
    );
  });
  it("отрицательная маржа даёт отрицательную комиссию (как у донора), нулевая цена — null", () => {
    assert.equal(commissionMarginRate({ salePrice: 90, costTotal: 100, ratePct: 10 }), -1);
    assert.equal(commissionMarginRate({ salePrice: 0, costTotal: 100, ratePct: 10 }), null);
  });
});

describe("метод 2: tiers (commission engine v2)", () => {
  it("границы полуоткрытые [from, to): 4.99 → 0.5%, ровно 5 → 1.5%, ровно 15 → 3.5%", () => {
    assert.equal(pickTier(DEFAULT_COMMISSION_TIERS, 4.99)?.ratePct, 0.5);
    assert.equal(pickTier(DEFAULT_COMMISSION_TIERS, 5)?.ratePct, 1.5);
    assert.equal(pickTier(DEFAULT_COMMISSION_TIERS, 15)?.ratePct, 3.5);
  });
  it("отрицательная маржа — тир не подобран", () => {
    assert.equal(pickTier(DEFAULT_COMMISSION_TIERS, -1), null);
  });
  it("персональный тир должности бьёт общий", () => {
    const tiers: CommissionTier[] = [
      ...DEFAULT_COMMISSION_TIERS,
      { positionId: "senior", marginPctFrom: 0, marginPctTo: null, ratePct: 5, baseType: "margin" },
    ];
    assert.equal(pickTier(tiers, 7, "senior")?.ratePct, 5);
    assert.equal(pickTier(tiers, 7, null)?.ratePct, 1.5, "без должности — общий тир");
  });
  it("маржа считается ОТ СЕБЕСТОИМОСТИ; база net_pocket × qty", () => {
    // sale 460, cost 400 → margin_pct 15 → тир 3.5%; net_pocket 30/ед × 2 = 60 → 2.1
    const r = commissionTiers({
      salePrice: 460,
      costOfficialTotal: 400,
      qty: 2,
      netPocketPerUnit: 30,
    });
    assert.ok(r !== null);
    assert.equal(r.marginPct, 15);
    assert.equal(r.tier.ratePct, 3.5);
    assert.equal(r.commission, 2.1);
  });
  it("guard донора: sale ≤ 0 или cost ≤ 0 → null, не выдуманный ноль", () => {
    assert.equal(commissionTiers({ salePrice: 0, costOfficialTotal: 100 }), null);
    assert.equal(commissionTiers({ salePrice: 100, costOfficialTotal: 0 }), null);
  });
  it("base_type margin: комиссия от разницы, net_pocket не нужен", () => {
    const tiers: CommissionTier[] = [
      { positionId: null, marginPctFrom: 0, marginPctTo: null, ratePct: 2, baseType: "margin" },
    ];
    const r = commissionTiers({ salePrice: 500, costOfficialTotal: 400, tiers });
    assert.equal(r?.commission, 2); // (500−400) × 2%
  });
});

describe("метод 3: flat_bonus (бонус калькулятора)", () => {
  it("8% от фактической прибыли; отрицательная прибыль — ноль", () => {
    assert.equal(commissionFlatBonus({ netProfitTotal: 36_564_637 }), 2_925_170.96);
    assert.equal(commissionFlatBonus({ netProfitTotal: -6_946_117 }), 0);
  });
  it("ставка сценария (3/6/10%) заменяет дефолт", () => {
    assert.equal(commissionFlatBonus({ netProfitTotal: 1_000_000, ratePct: 3 }), 30_000);
  });
});

describe("computeCommission — диспетчер по выбору владельца", () => {
  it("недостающие входы дают note словами, а не тихий ноль", () => {
    assert.match(computeCommission("margin_rate", {}).note ?? "", /нет цены/);
    assert.match(computeCommission("tiers", { salePrice: 100 }).note ?? "", /себестоимости/);
    assert.match(computeCommission("flat_bonus", {}).note ?? "", /фактической прибыли/);
  });
  it("каждый метод доступен через диспетчер и считает как исходник", () => {
    assert.equal(
      computeCommission("margin_rate", { salePrice: 500, costTotal: 400, ratePct: 10 }).commission,
      10,
    );
    assert.equal(
      computeCommission("tiers", {
        salePrice: 460,
        costOfficialTotal: 400,
        netPocketPerUnit: 30,
        qty: 2,
      }).commission,
      2.1,
    );
    assert.equal(
      computeCommission("flat_bonus", { netProfitTotal: 1_000_000 }).commission,
      80_000,
    );
  });
});
