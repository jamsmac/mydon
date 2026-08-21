import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRegisterRows, type RegisterRow } from "./purchase-register";

const TODAY = "2026-08-21";

/** Одна строка-товар с настраиваемыми полями даты/чисел — остальное заполнено нейтральными значениями. */
function one(overrides: {
  invoice?: string | null;
  paydate?: string | null;
  price?: string;
  cost?: string;
  qty?: string;
}): RegisterRow {
  const columns = [
    "",
    "",
    "Поставщик",
    "",
    "Наименование",
    "Ед",
    "Кол",
    "Цена",
    "Стоимость",
    "Счёт",
    "Оплата",
    "Дата оплаты",
    "Прим",
  ];
  const row = [
    "1",
    "2025",
    "ПОСТАВЩИК ТЕСТОВЫЙ",
    "123456789",
    "Товар тестовый",
    "шт",
    overrides.qty ?? "1",
    overrides.price ?? "1000",
    overrides.cost ?? "1000",
    overrides.invoice === undefined ? "1 от 01.01.2025" : (overrides.invoice ?? ""),
    "",
    overrides.paydate === undefined ? "" : (overrides.paydate ?? ""),
    "",
  ];
  const rows = parseRegisterRows({ columns, rows: [row] }, TODAY);
  return rows[0]!;
}

describe("parseRegisterRows — тесты из брифа (значения дословные)", () => {
  it("поставщик и ИНН тянутся вниз по группе", () => {
    // В реестре поставщик стоит только у первой строки группы; без протяжки
    // теряются 28 строк снек-напитков и итог не сходится со 183 454 462 сум.
    const t = {
      columns: [
        "",
        "",
        "Поставщик",
        "",
        "Наименование",
        "Ед",
        "Кол",
        "Цена",
        "Стоимость",
        "Счёт",
        "Оплата",
        "Дата оплаты",
        "Прим",
      ],
      rows: [
        [
          "1",
          "2025",
          "TULYAGANOV DMITRIY GRO",
          "304193350",
          "Сироп «Малина» 1л",
          "шт",
          "6",
          "75000",
          "450000",
          "№ 477 от 17.05.2025",
          "1350000",
          "2025-05-13",
          "",
        ],
        ["", "", "", "", "Сироп «Клубника» 1л", "шт", "6", "75000", "450000", "", "", "", ""],
      ],
    };
    const rows = parseRegisterRows(t, "2026-08-21");
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.supplier, "TULYAGANOV DMITRIY GRO");
    assert.equal(rows[1]!.inn, "304193350");
    assert.equal(rows[1]!.year, 2025);
  });

  it("дата прихода берётся из текста счёта, а не из оплаты", () => {
    // Счёт от 17.10.2025, а оплата записана «2026-10-17» — год на единицу больше,
    // день и месяц те же. Это опечатка владельца: таких строк в реестре 29.
    const r = one({ invoice: "233 от 17.10.2025", paydate: "2026-10-17" });
    assert.equal(r.invoiceNo, "233");
    assert.equal(r.invoiceDate, "2025-10-17");
    assert.equal(r.receivedOn, "2025-10-17");
    assert.equal(r.payDate, null, "дата оплаты в будущем — не дата");
  });

  it("нет даты вовсе — строка не импортируется, но объясняет почему", () => {
    const r = one({ invoice: null, paydate: null });
    assert.equal(r.receivedOn, null);
    assert.ok(r.dateProblem && r.dateProblem.length > 0);
  });

  it("текст вместо даты оплаты не ломает разбор", () => {
    // В колонке «Дата оплаты» встречается «25-29 авг».
    const r = one({ invoice: "176 от 22.08.2025", paydate: "25-29 авг" });
    assert.equal(r.receivedOn, "2025-08-22");
    assert.equal(r.payDate, null);
  });

  it("числа с пробелами и запятой читаются", () => {
    const r = one({ price: "239 000", cost: "11 950 000", qty: "50" });
    assert.equal(r.priceGross, 239000);
    assert.equal(r.costGross, 11950000);
    assert.equal(r.qty, 50);
  });
});

describe("parseRegisterRows — реальный объём (11 строк группы TULYAGANOV из register_full.json)", () => {
  // Заголовки — как в боевом файле «вендхаб.xlsx», лист «Лист1» (длиннее,
  // чем в брифе: «Ед. изм» вместо «Ед», «Счет-фактура» вместо «Счёт» и т.д.) —
  // проверяет, что позиционный разбор не зависит от точного текста заголовка.
  const columns = [
    "",
    "",
    "Поставщик",
    "",
    "Наименование товара",
    "Ед. изм",
    "Кол-во",
    "Цена сум с НДС",
    "Стоимость сум с НДС",
    "Счет-фактура",
    "Оплата",
    "Дата оплаты",
    "Примечание",
  ];
  // Строки 3–13 файла (группа 1, вся группа TULYAGANOV DMITRIY GROUP), значения
  // вписаны вручную из register_full.json — файл в код не читается.
  const rows = [
    [
      "1",
      "2025",
      "TULYAGANOV DMITRIY GROUP",
      "304193350",
      'Сироп "Малина" 1л',
      "шт",
      "6",
      "75000",
      "450000",
      "№ 477 от 17.05.2025",
      "1350000",
      "2025-05-13",
      "",
    ],
    ["", "", "", "", 'Сироп "Клубника" 1л', "шт", "6", "75000", "450000", "", "", "", ""],
    ["", "", "", "", 'Сироп "Смородина" 1л', "шт", "6", "75000", "450000", "", "", "", ""],
    [
      "",
      "",
      "",
      "",
      'Сироп "Ягодный" 1л',
      "шт",
      "10",
      "75000",
      "750000",
      "608 от 31.05.2025",
      "1125000",
      "2025-05-29",
      "",
    ],
    ["", "", "", "", 'Сироп "Ваниль" 1л', "шт", "5", "75000", "375000", "", "", "", ""],
    [
      "",
      "",
      "",
      "",
      'Сироп "Земляника" 1л',
      "шт",
      "5",
      "75000",
      "375000",
      "853 от 20.07.2025",
      "1125000",
      "2025-07-18",
      "",
    ],
    ["", "", "", "", 'Сироп "Дюшес" 1л', "шт", "5", "75000", "375000", "", "", "", ""],
    ["", "", "", "", 'Сироп "Гренадин" 1л', "шт", "5", "75000", "375000", "", "", "", ""],
    [
      "",
      "",
      "",
      "",
      'Сироп "Гренадин" 1л',
      "шт",
      "5",
      "75000",
      "375000",
      "1396 от 21.11.2025",
      "1125000",
      "2026-11-20",
      "",
    ],
    ["", "", "", "", 'Сироп "Карамель" 1л', "шт", "5", "75000", "375000", "", "", "", ""],
    ["", "", "", "", 'Сироп "Кюрасао" 1л', "шт", "5", "75000", "375000", "", "", "", ""],
  ];

  it("вся группа тянет группу/год/поставщика/ИНН от первой строки", () => {
    const out = parseRegisterRows({ columns, rows }, TODAY);
    assert.equal(out.length, 11);
    for (const r of out) {
      assert.equal(r.group, "1");
      assert.equal(r.year, 2025);
      assert.equal(r.supplier, "TULYAGANOV DMITRIY GROUP");
      assert.equal(r.inn, "304193350");
    }
  });

  it("сумма количества и стоимости по группе сходится с реестром", () => {
    const out = parseRegisterRows({ columns, rows }, TODAY);
    const totalQty = out.reduce((s, r) => s + (r.qty ?? 0), 0);
    const totalCost = out.reduce((s, r) => s + (r.costGross ?? 0), 0);
    assert.equal(totalQty, 63);
    assert.equal(totalCost, 4725000);
  });

  it("дата прихода — из счёта; строки без счёта и без оплаты уходят в «нет даты»", () => {
    const out = parseRegisterRows({ columns, rows }, TODAY);
    // Малина: счёт № 477 от 17.05.2025, оплата 2025-05-13 (правдоподобна, но приход — по счёту).
    assert.equal(out[0]!.invoiceNo, "477");
    assert.equal(out[0]!.receivedOn, "2025-05-17");
    assert.equal(out[0]!.payDate, "2025-05-13");
    // Клубника/Смородина/Ваниль/Дюшес/Гренадин#1/Карамель/Кюрасао: ни счёта, ни оплаты — даты нет.
    for (const i of [1, 2, 4, 6, 7, 9, 10]) {
      assert.equal(out[i]!.receivedOn, null, `строка ${i}`);
      assert.ok(out[i]!.dateProblem && out[i]!.dateProblem!.length > 0, `строка ${i}`);
    }
  });

  it("Гренадин #2 — та самая строка с опечаткой года в оплате (счёт 21.11.2025 / оплата 2026-11-20)", () => {
    const out = parseRegisterRows({ columns, rows }, TODAY);
    const grenadin2 = out[8]!;
    assert.equal(grenadin2.name, 'Сироп "Гренадин" 1л');
    assert.equal(grenadin2.invoiceNo, "1396");
    assert.equal(grenadin2.invoiceDate, "2025-11-21");
    assert.equal(grenadin2.receivedOn, "2025-11-21");
    assert.equal(grenadin2.payDate, null, "оплата в будущем относительно today — отброшена");
  });
});

describe("Реестр закупок: строка заголовков не должна стать записью", () => {
  it("строка без количества и стоимости отбрасывается", () => {
    // parseXlsx принимает за заголовок ПЕРВУЮ строку книги, а в живом реестре
    // первая строка — титул «OOO VENDHUB». Настоящая шапка приходит уже как
    // данные, и без этой защиты давала 136 записей вместо 135 и 14 поставщиков
    // вместо 13 (проверено сквозным прогоном по файлу владельца).
    const t = {
      columns: ["", "", "OOO VENDHUB", "", "", "", "", "", "", "", "", "", ""],
      rows: [
        ["", "", "Поставщик", "", "Наименование товара", "Ед. изм", "Кол-во", "Цена сум с НДС", "Стоимость сум с НДС", "Счет-фактура", "Оплата", "Дата оплаты", "Примечание"],
        ["1", "2025", "KMS ROASTING TRADING", "306331154", "Кофе жареный в зёрнах KMS blend 1 (1кг)", "кг", "50", "239000", "11950000", "99 от 13.05.2025", "11950000", "2025-05-19", ""],
      ],
    };
    const rows = parseRegisterRows(t, "2026-08-21", 2);
    assert.equal(rows.length, 1, "осталась только товарная строка");
    assert.equal(rows[0]!.supplier, "KMS ROASTING TRADING");
    assert.equal(rows[0]!.name, "Кофе жареный в зёрнах KMS blend 1 (1кг)");
  });

  it("headerOffset делает fileRow номером строки в файле", () => {
    // Из fileRow строится ключ идемпотентности, и человек по нему ищет строку
    // глазами: смещение обязано учитывать титул и шапку.
    const t = {
      columns: [""],
      rows: [["1", "2025", "П", "1", "Товар", "кг", "1", "100", "100", "", "", "", ""]],
    };
    assert.equal(parseRegisterRows(t, "2026-08-21", 2)[0]!.fileRow, 3);
    assert.equal(parseRegisterRows(t, "2026-08-21")[0]!.fileRow, 1, "без смещения — позиция в таблице");
  });
});
