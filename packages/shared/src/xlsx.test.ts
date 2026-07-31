import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseXlsx, looksLikeXlsx } from "./xlsx";

/**
 * Фикстура — настоящий .xlsx (openpyxl), закодированный base64. Лист «Отчёт»:
 *   Order Number | Product          | Price | Server Time         | Card Number
 *   26042418364631 | Латте & Ко      | 15000 | 2026-04-24 21:36:56 | (пусто)
 *   26042421071535 | Plus 18 <Energy>| 25000 | 2026-06-12 00:07:25 | 1234
 * Проверяет всё разом: общие строки, кириллицу, XML-сущности (& и <), число,
 * дату-серию, пустую хвостовую ячейку и имя листа.
 */
const FIXTURE_B64 =
  "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";

const bytes = () => Uint8Array.from(Buffer.from(FIXTURE_B64, "base64"));

describe("Excel: распознавание", () => {
  it("файл zip (PK) распознаётся как xlsx", () => {
    assert.equal(looksLikeXlsx(bytes()), true);
  });
  it("текст (CSV) не распознаётся как xlsx", () => {
    assert.equal(looksLikeXlsx(new TextEncoder().encode("a,b,c\n1,2,3")), false);
  });
});

describe("Excel: разбор листа", () => {
  it("заголовки и число строк", async () => {
    const s = await parseXlsx(bytes());
    assert.equal(s.sheet, "Отчёт");
    assert.deepEqual(s.columns, ["Order Number", "Product", "Price", "Server Time", "Card Number"]);
    assert.equal(s.rows.length, 2);
  });

  it("общие строки, кириллица и XML-сущности разворачиваются", async () => {
    const s = await parseXlsx(bytes());
    assert.equal(s.rows[0][1], "Латте & Ко");
    assert.equal(s.rows[1][1], "Plus 18 <Energy>");
  });

  it("число остаётся числом-строкой, без лишних нулей", async () => {
    const s = await parseXlsx(bytes());
    assert.equal(s.rows[0][2], "15000");
    assert.equal(s.rows[1][2], "25000");
  });

  it("дата-серия разворачивается в строку, как её видел человек", async () => {
    const s = await parseXlsx(bytes());
    assert.equal(s.rows[0][3], "2026-04-24 21:36:56");
    assert.equal(s.rows[1][3], "2026-06-12 00:07:25");
  });

  it("пустая ячейка остаётся пустой, а не сдвигает колонки", async () => {
    const s = await parseXlsx(bytes());
    // У первой строки Card Number пуст (хвостовая ячейка отсутствует в XML).
    assert.equal(s.rows[0][4], "");
    assert.equal(s.rows[1][4], "1234");
    // Ширина строки равна числу заголовков — колонки не разъехались.
    assert.equal(s.rows[0].length, 5);
  });

  it("текст-число (номер заказа) не превращается в число", async () => {
    const s = await parseXlsx(bytes());
    assert.equal(s.rows[0][0], "26042418364631");
  });
});
