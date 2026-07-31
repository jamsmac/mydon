import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cellValue,
  isBlank,
  parseLabelledPairs,
  parseOfficeReport,
  parseOrderInfo,
} from "./vendinghub";

/**
 * Кусок настоящей страницы кабинета, снятой 31.07.2026.
 * Разметка сокращена (кнопки и svg выброшены), структура сохранена.
 */
const CELL = `
  <svg data-row-id="39384" class="vhj-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"></path></svg>
  <span data-target="for-excel">39384</span>
  <div class="vhj-df">
    <span class="vhj-dl">№ заказа</span>
    <span class="vhj-dv"><span class="vhj-mono">ff000018bf202607311936383266181f0000</span>
      <button class="vhj-copy" data-c="ff000018bf202607311936383266181f0000" title="Копировать"></button></span>
  </div>
  <div class="vhj-df">
    <span class="vhj-dl">order Info <svg class="vhj-chev-order"></svg></span>
    <pre class="order-container hide">{"orderNo":"ff000018bf202607311936383266181f0000"<br/>"orderGoodsNo":null<br/>"salesStatus":"2"<br/>"machineCode":"3266181f0000"<br/>"remark":null<br/>"goodsId":440<br/>"tasteId":"3"<br/>"orderType":"normal"<br/>"orderSource":"cash"<br/>"goodsName":"Ice Cappuccino"<br/>"tasteName":"ICE Cappuccino без сахара"<br/>"orderPrice":25000<br/>"vipCardNum":null<br/>"amount":25000}</pre>
  </div>
  <div class="vhj-df">
    <span class="vhj-dl">Источник</span>
    <span class="vhj-dv"><span class="vhj-mono">Наличные</span>
      <button class="vhj-copy" data-c="Наличные"></button></span>
  </div>
  <div class="vhj-df"><span class="vhj-dl">Упаковка</span><span class="vhj-dv">Шт Новый ИКПУ<button class="vhj-copy" data-c="Шт Новый ИКПУ"></button></span></div>
  <div class="vhj-df"><span class="vhj-dl">ИКПУ</span><span class="vhj-dv">08476001003000000<button class="vhj-copy" data-c="08476001003000000"></button></span></div>
  <div class="vhj-df"><span class="vhj-dl">Штрих-код</span><span class="vhj-dv">—</span></div>
  <div class="vhj-df"><span class="vhj-dl">Слот</span><span class="vhj-dv">—</span></div>`;

const PAGE = `<div class="main-panel"><table class="table">
  <thead><tr>
    <th>ID</th><th>Время</th><th>Товар</th><th>Сумма</th><th>Точка</th><th>Оплата</th>
  </tr></thead>
  <tbody>
    <tr><td>${CELL}</td><td>2026-07-31 16:38:21</td><td>Ice Cappuccino</td>
        <td>25 000.00</td><td>American hospital</td><td>Наличные</td></tr>
    <tr><td><span data-target="for-excel">39383</span> <div class="vhj-df"><span class="vhj-dl">ИКПУ</span><span class="vhj-dv">08476001003000009<button class="vhj-copy" data-c="08476001003000009"></button></span></div></td>
        <td>2026-07-31 16:17:12</td><td>Ice WildFruit Tea</td>
        <td>15 000.00</td><td>KIUT Общежитие</td><td>Наличные</td></tr>
  </tbody>
</table></div>`;

describe("Кабинет VendHub office: JSON заказа из ячейки", () => {
  it("запятые в JSON заменены на <br/> — без обратной замены он не читается", () => {
    const info = parseOrderInfo(CELL);
    assert.equal(info?.orderNo, "ff000018bf202607311936383266181f0000");
    assert.equal(info?.machineCode, "3266181f0000");
    assert.equal(info?.goodsName, "Ice Cappuccino");
    assert.equal(info?.tasteName, "ICE Cappuccino без сахара");
    assert.equal(info?.orderPrice, 25000);
  });

  it("нет блока — null, а не пустой объект: это разные вещи", () => {
    assert.equal(parseOrderInfo("<td>просто ячейка</td>"), null);
  });

  it("нечитаемый блок не роняет разбор и не выдумывает содержимое", () => {
    assert.equal(parseOrderInfo('<pre class="order-container">{это не json</pre>'), null);
  });
});

describe("Кабинет VendHub office: подписи и значения", () => {
  it("фискальные поля вытаскиваются — их нет ни в одной другой системе", () => {
    const p = parseLabelledPairs(CELL);
    assert.equal(p["ИКПУ"], "08476001003000000");
    assert.equal(p["Упаковка"], "Шт Новый ИКПУ");
  });

  it("подпись не склеивается со значением соседней строки", () => {
    // Сквозной жадный поиск давал «№ заказа → Наличные»: подпись одной пары и
    // значение следующей. Разбор идёт поблочно именно поэтому.
    const p = parseLabelledPairs(CELL);
    assert.equal(p["№ заказа"], "ff000018bf202607311936383266181f0000");
    assert.equal(p["Источник"], "Наличные");
  });

  it("прочерк и «Нет данных» — это «источник ничего не дал», а не значение", () => {
    const p = parseLabelledPairs(CELL);
    assert.equal(p["Штрих-код"], "");
    assert.equal(p["Слот"], "");
    // Кабинет для одних полей ставит «—», для других «Нет данных» — оба пусто.
    assert.equal(
      parseLabelledPairs('<div class="vhj-df"><span class="vhj-dl">ИКПУ</span><span class="vhj-dv">Нет данных</span></div>')["ИКПУ"],
      "",
    );
    assert.equal(isBlank("—"), true);
    assert.equal(isBlank("Нет данных"), true);
    assert.equal(isBlank("08476001003000000"), false);
  });

  it("подпись раскрывающегося блока значением не считается", () => {
    assert.equal(parseLabelledPairs(CELL)["order Info"], undefined);
  });
});

describe("Кабинет VendHub office: страница отчёта", () => {
  const r = parseOfficeReport(PAGE);

  it("видимые колонки идут первыми и в порядке источника", () => {
    assert.deepEqual(r.columns.slice(0, 6), ["ID", "Время", "Товар", "Сумма", "Точка", "Оплата"]);
  });

  it("развёрнутые из ячейки поля добавляются своими же именами источника", () => {
    for (const k of ["orderNo", "machineCode", "goodsName", "orderPrice", "ИКПУ", "Упаковка"]) {
      assert.ok(r.columns.includes(k), `нет колонки ${k}`);
    }
  });

  it("состав колонок собран по всем строкам, а не по первой", () => {
    // У второй строки нет JSON, но её ИКПУ обязан попасть в свою колонку.
    const i = r.columns.indexOf("ИКПУ");
    assert.equal(r.rows[1][i], "08476001003000009");
  });

  it("в первой колонке номер строки, а не весь раскрывающийся блок", () => {
    assert.equal(r.rows[0][0], "39384");
    assert.equal(r.rows[1][0], "39383");
  });

  it("берётся та часть ячейки, которую кабинет сам пометил как выгружаемую", () => {
    // `data-target="for-excel"` — его собственное решение о том, где здесь
    // данные, а где оформление. Лучшего указания у нас нет.
    assert.equal(cellValue('<svg data-row-id="7"></svg><span data-target="for-excel">42</span><div>хлам</div>'), "42");
    assert.equal(cellValue('<svg data-row-id="7"></svg><div>хлам</div>'), "7", "без пометки — номер строки");
    assert.equal(cellValue("просто текст"), "просто текст");
    // Плоский отчёт кабинета оборачивает значение в тег, а блока в ячейке нет.
    assert.equal(cellValue("<nobr>39384</nobr>"), "39384");
    // А вот при вложенном блоке берётся только то, что стоит до него.
    assert.equal(cellValue('<span>7</span><div class="vhj-df">разворот</div>'), "7");
  });

  it("значения не приводятся к типам: цена остаётся строкой источника", () => {
    assert.equal(r.rows[0][r.columns.indexOf("orderPrice")], "25000");
    assert.equal(r.rows[0][r.columns.indexOf("Сумма")], "25 000.00");
  });

  it("строки без JSON считаются: молча их терять нельзя", () => {
    assert.equal(r.withoutJson, 1);
  });

  it("длина строки равна числу колонок — иначе таблица разъедется", () => {
    for (const row of r.rows) assert.equal(row.length, r.columns.length);
  });

  it("страница без таблицы — пустой отчёт, а не ошибка", () => {
    assert.deepEqual(parseOfficeReport("<div>вход</div>"), {
      columns: [],
      rows: [],
      withoutJson: 0,
    });
  });
});
