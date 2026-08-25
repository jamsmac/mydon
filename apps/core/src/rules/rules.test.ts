import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyRules, formatAmount, immediateOnly, RULES } from "./rules";

const ctx = (type: string, payload: Record<string, unknown> = {}) => ({
  source: "test",
  type,
  payload,
});

describe("Правила уведомлений (FR-2)", () => {
  it("правил не меньше 10 — требование DoD Фазы 6", () => {
    assert.ok(RULES.length >= 10, `правил ${RULES.length}, нужно ≥10`);
  });

  it("у правил уникальные идентификаторы", () => {
    const ids = RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("все четыре тревоги владельца (Ф11) доставляются немедленно", () => {
    const alarms = ["money.overdue", "machine.idle", "lead.new", "contract.expiring"];
    for (const id of alarms) {
      const rule = RULES.find((r) => r.id === id);
      assert.ok(rule, `нет правила ${id}`);
      assert.equal(rule.urgency, "immediate", `${id} должно быть немедленным`);
    }
  });

  it("оформляет просроченный платёж понятной фразой", () => {
    const [n] = applyRules(ctx("money.overdue", { counterparty: "Olma", amount: 1500000, daysOverdue: 12 }));
    assert.match(n.text, /Olma/);
    assert.match(n.text, /1 500 000 UZS/);
    assert.match(n.text, /12 дн/);
  });

  it("условные правила молчат, когда условие не выполнено", () => {
    assert.equal(applyRules(ctx("machine.idle", { machine: "A1", hours: 2 })).length, 0);
    assert.equal(applyRules(ctx("machine.idle", { machine: "A1", hours: 8 })).length, 1);
  });

  it("незначительное изменение курса не беспокоит", () => {
    assert.equal(applyRules(ctx("fx.changed", { currency: "USD", changePercent: 0.2 })).length, 0);
    assert.equal(applyRules(ctx("fx.changed", { currency: "USD", changePercent: 2.5 })).length, 1);
  });

  it("неизвестное событие не порождает уведомлений и не падает", () => {
    assert.deepEqual(applyRules(ctx("что-то.новое", { x: 1 })), []);
  });

  it("пустой payload не роняет оформление", () => {
    const n = applyRules(ctx("machine.offline"));
    assert.equal(n.length, 1);
    assert.match(n[0].text, /не на связи/);
  });

  it("битое правило не мешает остальным", () => {
    const broken = [
      {
        id: "broken",
        eventType: "test.event",
        urgency: "immediate" as const,
        format: () => {
          throw new Error("сломалось");
        },
      },
      {
        id: "healthy",
        eventType: "test.event",
        urgency: "immediate" as const,
        format: () => "всё хорошо",
      },
    ];
    const out = applyRules(ctx("test.event"), broken);
    assert.equal(out.length, 2, "оба правила должны дать результат");
    assert.match(out[0].text, /не смогло его оформить/);
    assert.equal(out[1].text, "всё хорошо");
  });

  it("фильтр немедленных отбирает только срочное", () => {
    const mixed = [
      ...applyRules(ctx("money.overdue", { amount: 1 })),
      ...applyRules(ctx("sales.drop", { percent: 10 })),
    ];
    assert.equal(mixed.length, 2);
    assert.equal(immediateOnly(mixed).length, 1);
  });

  it("суммы показываются по-русски", () => {
    assert.equal(formatAmount(1234567), "1 234 567 UZS");
    assert.equal(formatAmount("не число"), "0 UZS");
  });

  it("недолив бункера: почти пустой — немедленно, обычный — в брифинг", () => {
    const critical = applyRules(
      ctx("coffee.underfill", { location: "AH", position: 7, ingredient: "Кофе", netFillWeight: 80, targetFillWeight: 600, fillRatio: 0.13 }),
    );
    assert.equal(critical.length, 1);
    assert.equal(critical[0].urgency, "immediate");
    assert.match(critical[0].text, /AH/);
    assert.match(critical[0].text, /бункер 7/);

    const watch = applyRules(
      ctx("coffee.underfill", { location: "AH", position: 7, ingredient: "Кофе", netFillWeight: 400, targetFillWeight: 600, fillRatio: 0.67 }),
    );
    assert.equal(watch.length, 1);
    assert.equal(watch[0].urgency, "briefing");
  });

  it("расхождение расхода: сильное — немедленно, умеренное — в брифинг", () => {
    const critical = applyRules(
      ctx("coffee.anomaly", { location: "AH", ingredient: "Кофе", actualGrams: 570, expectedGrams: 90, deltaRatio: 5.33 }),
    );
    assert.equal(critical.length, 1);
    assert.equal(critical[0].urgency, "immediate");

    const watch = applyRules(
      ctx("coffee.anomaly", { location: "AH", ingredient: "Кофе", actualGrams: 360, expectedGrams: 330, deltaRatio: 0.15 }),
    );
    assert.equal(watch.length, 1);
    assert.equal(watch[0].urgency, "briefing");
  });

  it("усушка за порогом: товар, штуки и сумма одной строкой брифинга", () => {
    const notes = applyRules(
      ctx("vending.shrinkage_alert", {
        serial: "2508160376",
        name: "Olma",
        product: "Kinder Bueno",
        lossUnits: 9,
        lossValue: 99000,
        days: 7,
      }),
    );
    assert.equal(notes.length, 1);
    assert.equal(notes[0].urgency, "briefing");
    assert.equal(notes[0].text, "📉 Усушка Olma: Kinder Bueno −9 шт ≈ 99 000 сум за 7 дн.");
  });

  it("заливка без записи зовёт оформить её в боте; подтверждённая — молчит", () => {
    const payload = {
      serial: "2508160376",
      name: "Olma",
      units: 43,
      // 04:00 UTC = 09:00 Ташкента: владелец не должен читать со сдвигом.
      windowTo: "2026-08-24T04:00:00.000Z",
      recorded: false,
    };
    const notes = applyRules(ctx("vending.refill_detected", payload));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].urgency, "briefing");
    assert.equal(
      notes[0].text,
      "🍫 Заливка без записи: Olma +43 шт 09:00 — оформи в боте «Заполнил автомат»",
    );

    assert.equal(
      applyRules(ctx("vending.refill_detected", { ...payload, recorded: true })).length,
      0,
      "заливка, которую оператор записал, — не новость",
    );

    // Время БЕЗ зоны читается ташкентскими настенными часами, а не часами
    // процесса: иначе строка брифинга ехала бы на пять часов в контейнере с
    // TZ=UTC — ровно тот баг, на котором погорел донор VendCash.
    assert.match(
      applyRules(ctx("vending.refill_detected", { ...payload, windowTo: "2026-08-24 09:00:00" }))[0]!.text,
      / 09:00 /,
    );
  });
});
