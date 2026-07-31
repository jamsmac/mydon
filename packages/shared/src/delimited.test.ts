import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeUpload, parseDelimited, sniffDelimiter } from "./delimited";

describe("Выгрузка файлом: разделитель", () => {
  it("точка с запятой — Excel в русской локали сохраняет так", () => {
    assert.equal(sniffDelimiter("a;b;c\n1;2;3"), ";");
  });

  it("запятая внутри значения не делает запятую разделителем", () => {
    // Настоящий случай: адрес «2 корпус, кардиология» в файле через «;».
    const text = "Machine Code;Address;Order price\naaa1;2 корпус, кардиология;20000";
    assert.equal(sniffDelimiter(text), ";");
  });

  it("табуляция читается — так отдают выгрузки «скопировать в буфер»", () => {
    assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  });

  it("ровность строк важнее числа колонок", () => {
    // По запятой первая строка бьётся на 4, но дальше вразнобой; по «;» — ровно.
    const text = "a;b\n1,2,3,4;x\n5;y\n6;z";
    assert.equal(sniffDelimiter(text), ";");
  });
});

describe("Выгрузка файлом: разбор", () => {
  it("первая строка — заголовки, порядок сохраняется", () => {
    const r = parseDelimited("Order number;Goods name;Order price\nff01;Ice Lemon Tea;15000");
    assert.deepEqual(r.columns, ["Order number", "Goods name", "Order price"]);
    assert.deepEqual(r.rows, [["ff01", "Ice Lemon Tea", "15000"]]);
  });

  it("значения не приводятся к типам: «15000.00» остаётся как в источнике", () => {
    const r = parseDelimited("Order price\n15000.00");
    assert.deepEqual(r.rows, [["15000.00"]]);
  });

  it("кавычки: разделитель и перевод строки внутри них — обычные символы", () => {
    const r = parseDelimited('a;b\n"цена; со скидкой";"две\nстроки"');
    assert.deepEqual(r.rows, [["цена; со скидкой", "две\nстроки"]]);
  });

  it("удвоенная кавычка внутри значения — это одна кавычка", () => {
    const r = parseDelimited('a\n"он сказал ""да"""');
    assert.deepEqual(r.rows, [['он сказал "да"']]);
  });

  it("BOM в начале не попадает в первый заголовок", () => {
    const r = parseDelimited("\uFEFFOrder number;Goods name\nff01;Tea");
    assert.equal(r.columns[0], "Order number");
  });

  it("перевод строки Windows не даёт пустых строк", () => {
    const r = parseDelimited("a;b\r\n1;2\r\n3;4\r\n");
    assert.equal(r.rows.length, 2);
  });

  it("хвост из пустых строк отбрасывается, а разрыв в середине сохраняется", () => {
    const r = parseDelimited("a;b\n1;2\n;\n3;4\n\n\n");
    assert.equal(r.rows.length, 3, "пустая строка в середине — это данные источника");
  });

  it("неровные строки считаются, а не чинятся молча", () => {
    const r = parseDelimited("a;b;c\n1;2;3\n4;5\n6;7;8;9");
    assert.equal(r.ragged, 2);
    assert.deepEqual(r.rows[1], ["4", "5", ""], "короткая дополнена пустыми");
    assert.deepEqual(r.rows[2], ["6", "7", "8", "9"], "длинная сохранена целиком");
  });

  it("пустой файл — не ошибка, а пустая выгрузка", () => {
    assert.deepEqual(parseDelimited("").rows, []);
    assert.deepEqual(parseDelimited("\n\n").columns, []);
  });

  it("разделитель можно задать явно, если чутьё ошиблось", () => {
    const r = parseDelimited("a,b\n1,2", ",");
    assert.deepEqual(r.columns, ["a", "b"]);
  });
});

describe("Выгрузка файлом: кодировка", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);

  it("UTF-8 читается как UTF-8", () => {
    const r = decodeUpload(new TextEncoder().encode("Товар;Цена"));
    assert.equal(r.text, "Товар;Цена");
    assert.equal(r.encoding, "utf-8");
  });

  it("BOM прямо называет кодировку и важнее проверки", () => {
    const r = decodeUpload(bytes(0xef, 0xbb, 0xbf, 0xd0, 0xa2));
    assert.equal(r.encoding, "utf-8 (с BOM)");
    assert.equal(r.text, "Т");
  });

  it("cp1251 узнаётся: Excel в русской локали сохраняет так", () => {
    // «Привет» в cp1251. Как UTF-8 эти байты не читаются вовсе — на том и ловим.
    const r = decodeUpload(bytes(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2));
    assert.equal(r.encoding, "windows-1251");
    assert.equal(r.text, "Привет");
  });

  it("латиница одинакова в обеих кодировках и читается как UTF-8", () => {
    const r = decodeUpload(new TextEncoder().encode("Order number;Goods name"));
    assert.equal(r.encoding, "utf-8");
  });
});
