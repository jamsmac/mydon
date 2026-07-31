import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { csvCell, normalizeRowsQuery, parseColumnFilters, toCsv } from "./raw.service";

describe("Сырой слой: разбор параметров страницы", () => {
  it("номера колонок и страниц берутся только целыми и положительными", () => {
    const q = normalizeRowsQuery({ page: "3", size: "50", sort: "4", dir: "desc" });
    assert.equal(q.page, 3);
    assert.equal(q.size, 50);
    assert.equal(q.offset, 100);
    assert.equal(q.sort, 4);
    assert.equal(q.dir, "desc");
  });

  it("мусор в адресе не роняет страницу, а откатывается к умолчаниям", () => {
    const q = normalizeRowsQuery({ page: "-2", size: "abc", sort: "1.5", dir: "вниз" });
    assert.equal(q.page, 1);
    assert.equal(q.size, 100);
    assert.equal(q.sort, null, "дробный номер колонки — не колонка");
    assert.equal(q.dir, "asc");
  });

  it("размер страницы ограничен сверху: одним запросом всю выгрузку не вытянуть", () => {
    assert.equal(normalizeRowsQuery({ size: "999999" }).size, 1000);
  });

  it("попытка подставить в номер колонки не-число отбрасывается", () => {
    // Номер колонки — единственное, что уходит в текст SQL-запроса,
    // поэтому проверяем его отдельно и придирчиво.
    for (const bad of ["0; drop table raw_row", "1e3", "-1", "99999", ""]) {
      assert.equal(normalizeRowsQuery({ sort: bad }).sort, null, `пропущено: ${bad}`);
    }
    assert.equal(normalizeRowsQuery({ sort: "0" }).sort, 0, "нулевая колонка допустима");
  });
});

describe("Сырой слой: фильтры по колонкам", () => {
  it("читаются только ключи вида f<число>, остальное игнорируется", () => {
    const f = parseColumnFilters({ f0: "cash", f12: "paid", q: "поиск", foo: "bar", fx: "1" });
    assert.deepEqual([...f.entries()], [
      [0, "cash"],
      [12, "paid"],
    ]);
  });

  it("пустой фильтр не считается фильтром", () => {
    assert.equal(parseColumnFilters({ f0: "   ", f1: "" }).size, 0);
  });

  it("номер колонки за пределами разумного отбрасывается", () => {
    assert.equal(parseColumnFilters({ f9999: "x" }).size, 0);
  });
});

describe("Сырой слой: выгрузка в CSV", () => {
  it("разделитель — точка с запятой, значения со спецсимволами в кавычках", () => {
    assert.equal(csvCell("Americano"), "Americano");
    assert.equal(csvCell("цена; со скидкой"), '"цена; со скидкой"');
    assert.equal(csvCell('он сказал "да"'), '"он сказал ""да"""');
    assert.equal(csvCell("две\nстроки"), '"две\nстроки"');
  });

  it("шапка повторяет колонки источника, порядок сохраняется", () => {
    const csv = toCsv(
      ["Order number", "Goods name", "Order price"],
      [
        { idx: 1, cells: ["ff0001", "Ice Lemon Tea", "15000"] },
        { idx: 2, cells: ["ud1782", "MacCoffee 3in1", "15000.00"] },
      ],
    );
    const lines = csv.split("\r\n");
    assert.equal(lines[0], "﻿#;Order number;Goods name;Order price");
    assert.equal(lines[1], "1;ff0001;Ice Lemon Tea;15000");
    assert.equal(lines[2], "2;ud1782;MacCoffee 3in1;15000.00");
  });

  it("цифры не приводятся к числу: «15000.00» остаётся как в источнике", () => {
    const csv = toCsv(["Order price"], [{ idx: 1, cells: ["15000.00"] }]);
    assert.ok(csv.includes("15000.00"), "приведение типов на сыром слое запрещено");
  });
});
