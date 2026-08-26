import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSalesSummary, isSalesQuery, type SalesSummary } from "./sales-brief";

const S: SalesSummary = {
  today: { qty: 42, amount: 1260000 },
  yesterday: { qty: 55, amount: 1650000 },
  days30: { qty: 1400, amount: 42000000 },
  lastSaleDt: "2026-08-04",
  configured: true,
};

describe("Сводка продаж в боте", () => {
  it("триггер: «продажи», «выручка», «сколько продали»; не срабатывает на закуп", () => {
    assert.equal(isSalesQuery("продажи"), true);
    assert.equal(isSalesQuery("Выручка за сегодня"), true);
    assert.equal(isSalesQuery("сколько продали вчера"), true);
    assert.equal(isSalesQuery("оформить закуп"), false);
    assert.equal(isSalesQuery("что заказать"), false);
  });

  it("сводка: сегодня/вчера/30 дней и дата последней продажи", () => {
    const text = formatSalesSummary(S).replace(/\u00A0/g, " ");
    assert.match(text, /Сегодня: 1 260 000 сум · 42 шт/);
    assert.match(text, /Вчера: 1 650 000 сум · 55 шт/);
    assert.match(text, /30 дней: 42 000 000 сум/);
    assert.match(text, /Последняя продажа в журнале: 2026-08-04/);
  });

  it("синк не настроен — честно говорим, а не показываем нули", () => {
    const text = formatSalesSummary({ ...S, configured: false, lastSaleDt: null });
    assert.match(text, /не настроен/);
    assert.doesNotMatch(text, /0 сум/);
  });

  it("режим own — зовём чинить агента, а не задавать удалённую переменную (M2)", () => {
    // После шага 3 рунбука катовера `STOCK_DATABASE_URL` УДАЛЕНА, и
    // `configured: false` значит «снапшот за сутки не пришёл». Старый совет
    // отправлял владельца заводить переменную, которую он только что снёс.
    const text = formatSalesSummary({ ...S, configured: false, lastSaleDt: null, source: "own" });
    assert.match(text, /ourvend:accounting/);
    assert.match(text, /снапшота за сутки нет/);
    assert.doesNotMatch(text, /STOCK_DATABASE_URL/);
  });

  it("режим не назван (Core прошлой сборки) — прежний текст про зеркало", () => {
    const text = formatSalesSummary({ ...S, configured: false, lastSaleDt: null });
    assert.match(text, /STOCK_DATABASE_URL/);
  });

  it("синк настроен, но данных нет — отдельная честная фраза", () => {
    const text = formatSalesSummary({ ...S, lastSaleDt: null });
    assert.match(text, /данных ещё не приносил/);
  });
});
