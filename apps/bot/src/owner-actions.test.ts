import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActionRow } from "./core-client";
import { actionsPeriod, formatActions, isActionsQuery, summarizeActions } from "./owner-actions";

const row = (over: Partial<ActionRow> = {}): ActionRow => ({
  ts: "2026-08-18T07:15:00.000Z",
  kind: "coffee_refill",
  label: "☕ Заливка: Olma office · бункер 7 · 1600 г",
  personId: "11111111-1111-4111-8111-111111111111",
  personName: "Алишер",
  ...over,
});

describe("Итоги для владельца: разбор запроса", () => {
  it("узнаёт свои фразы и не трогает чужие", () => {
    assert.equal(isActionsQuery("итоги"), true);
    assert.equal(isActionsQuery("Итоги вчера"), true);
    assert.equal(isActionsQuery("действия"), true);
    assert.equal(isActionsQuery("кто что сделал"), true);
    assert.equal(isActionsQuery("расход кофе"), false);
    assert.equal(isActionsQuery("продажи"), false);
  });

  it("период: сегодня / вчера / неделя (дни по Ташкенту)", () => {
    // 20:00 UTC 17-го = 01:00 18-го по Ташкенту — день уже «18-е».
    const now = new Date("2026-08-17T20:00:00Z");
    assert.deepEqual(actionsPeriod("итоги", now), { from: "2026-08-18", to: "2026-08-18", label: "сегодня" });
    assert.deepEqual(actionsPeriod("итоги вчера", now), { from: "2026-08-17", to: "2026-08-17", label: "вчера" });
    assert.equal(actionsPeriod("итоги за неделю", now).from, "2026-08-12");
    assert.equal(actionsPeriod("итоги за неделю", now).to, "2026-08-18");
  });
});

describe("Итоги для владельца: отчёт по людям", () => {
  it("группирует по людям, деятельные сверху, время по Ташкенту", () => {
    const rows = [
      row({ ts: "2026-08-18T05:30:00.000Z", personName: "Рустам", label: "📦 Приход: Зёрна +10 кг" }),
      row({ ts: "2026-08-18T04:00:00.000Z" }),
      row({ ts: "2026-08-18T03:00:00.000Z", label: "↩️ Возврат набора 027 · поз. 1 · 787 г" }),
    ];
    const text = formatActions(rows, "сегодня");
    assert.match(text, /Действия сотрудников \(сегодня\): 3/);
    assert.ok(text.indexOf("Алишер — 2") < text.indexOf("Рустам — 1"), "у кого больше — тот выше");
    assert.match(text, /08:00 ↩️ Возврат/, "время в поясе Ташкента (+05) и хронологически");
    assert.match(text, /10:30 📦 Приход/);
  });

  it("пустой день — честное «не записано», а не пустой заголовок", () => {
    assert.match(formatActions([], "сегодня"), /не записано/);
  });

  it("сводка для брифинга: имена с числом действий, подсказка «итоги вчера»", () => {
    const line = summarizeActions([row(), row(), row({ personName: "Рустам" })]);
    assert.match(line ?? "", /Алишер — 2, Рустам — 1/);
    assert.match(line ?? "", /итоги вчера/);
    assert.equal(summarizeActions([]), null, "пустой день не добавляет строку в брифинг");
  });
});
