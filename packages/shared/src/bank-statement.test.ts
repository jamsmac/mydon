import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH_DEPOSIT_SYMBOL, parseBankStatement, type BankStatementRow } from "./bank-statement";

/**
 * Тесты на РЕАЛЬНОЙ ПО ФОРМЕ выписке (R-K12): формат даты `дд.мм.гг`, научная
 * запись числа, символ `0200`, строка-итог без даты, шапка не в нулевой
 * строке — всё как в живом файле `AccReferenceReport20260821223037.xlsx`
 * (проверено 22.08.2026). Номер счёта и ИНН — заведомо поддельные (реквизиты
 * счёта в репозитории лежать не должны), на разбор они не влияют.
 */

const FAKE_ACCOUNT = "20208000900000000001"; // поддельный, для теста формата разбора
const FAKE_INN = "999999999";

/** Шапка справки — строка 0 файла, `columns` из `parseXlsx`: разбор её игнорирует целиком. */
const TITLE_ROW = ["Информация об операциях по счёту за период"];

/** Настоящая шапка таблицы — строка 1 (см. ловушку №1 модуля): порядок колонок как в живом файле. */
const HEADER_ROW = [
  "Дата документа",
  "Счёт",
  "Наименование",
  "Номер документа",
  "Тип документа",
  "Филиал",
  "Оборот Дебет",
  "Оборот кредит",
  "Назначение платежа",
  "Кассовый символ",
  "ИНН",
];

/** Служебная строка счёта — строка 2 файла: своей даты не несёт, разбор отбрасывает её фильтром по дате. */
const ACCOUNT_ROW = ["", FAKE_ACCOUNT, "ООО ТЕСТ КОМПАНИЯ", "", "", "", "", "", "", "", FAKE_INN];

function dataRow(over: {
  date?: string;
  docNo?: string;
  name?: string;
  debit?: string;
  credit?: string;
  cashSymbol?: string;
  branch?: string;
  docType?: string;
  purpose?: string;
}): string[] {
  return [
    over.date ?? "12.06.25",
    FAKE_ACCOUNT,
    over.name ?? "Наличные деньги в оборотной кассе",
    over.docNo ?? "3009296",
    over.docType ?? "Приходный кассовый ордер",
    over.branch ?? "Головной офис",
    over.debit ?? "",
    over.credit ?? "9000000.0",
    over.purpose ?? "Взнос наличных денежных средств",
    over.cashSymbol ?? "0200",
    FAKE_INN,
  ];
}

/** Строка-итог: без даты, сумма — научная запись (реальное значение из брифа). */
const TOTAL_ROW = ["", "", "Итого оборот за период:", "", "", "", "", "1.57328068051E9", "", "", ""];

function table(rows: string[][]): { columns: string[]; rows: string[][] } {
  return { columns: TITLE_ROW, rows };
}

describe("parseBankStatement — реальные ловушки формата (R-K12)", () => {
  it("шапка ищется по имени в rows[1], а не по позиции; columns из parseXlsx игнорируется", () => {
    const rows = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, dataRow({})]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.account, FAKE_ACCOUNT);
    assert.equal(rows[0]!.inn, FAKE_INN);
  });

  it("дата дд.мм.гг с двузначным годом читается как 20xx (12.06.25 → 2025-06-12)", () => {
    const rows = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, dataRow({ date: "12.06.25" })]));
    assert.equal(rows[0]!.date, "2025-06-12");
  });

  it("строка-итог без даты отбрасывается фильтром по формату — без отдельной проверки на текст «Итого»", () => {
    const rows = parseBankStatement(
      table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, dataRow({}), TOTAL_ROW]),
    );
    assert.equal(rows.length, 1, "строка-итог не должна попасть в результат");
    assert.ok(!rows.some((r) => r.name.includes("Итого")));
  });

  it("научная запись числа читается через Number(), а не превращается в мусор чисткой регуляркой", () => {
    // Реальное значение из брифа (строка итога) — 1,57 млрд. Чистка вида
    // replace(/[^\d.-]/g, "") съела бы "E9" и дала бы 1.57328068051 — ошибка
    // в миллиард раз, молча. Проверяем на ОБЫЧНОЙ (не итоговой) строке —
    // строка итога и так отбрасывается по дате и её сумму парсить не нужно.
    const rows = parseBankStatement(
      table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, dataRow({ credit: "1.57328068051E9", debit: "" })]),
    );
    assert.equal(rows[0]!.credit, 1573280680.51);
  });

  it("кассовый символ 0200 читается как есть; пустой символ — null, а не пустая строка", () => {
    const rows = parseBankStatement(
      table([
        TITLE_ROW,
        HEADER_ROW,
        ACCOUNT_ROW,
        dataRow({ docNo: "1", cashSymbol: "0200" }),
        dataRow({ docNo: "2", date: "13.06.25", cashSymbol: "" }),
      ]),
    );
    assert.equal(rows[0]!.cashSymbol, "0200");
    assert.equal(rows[1]!.cashSymbol, null, "пустой кассовый символ — норма у большинства строк, не ошибка");
  });

  it("взносы наличных 0200 отбираются и суммируются верно (критерий приёмки шага 1 — форма проверки)", () => {
    const rows = parseBankStatement(
      table([
        TITLE_ROW,
        HEADER_ROW,
        ACCOUNT_ROW,
        dataRow({ docNo: "1", date: "12.06.25", credit: "9000000.0", cashSymbol: "0200" }),
        dataRow({ docNo: "2", date: "13.06.25", credit: "5000000", cashSymbol: "66" }), // не взнос — другой символ
        dataRow({ docNo: "3", date: "14.06.25", credit: "3000000", cashSymbol: "0200" }),
      ]),
    );
    const deposits = rows.filter((r) => r.cashSymbol === CASH_DEPOSIT_SYMBOL);
    assert.equal(deposits.length, 2);
    assert.equal(
      deposits.reduce((s, r) => s + (r.credit ?? 0), 0),
      12000000,
    );
  });

  it("ключ идемпотентности extId — счёт+docNo+дата+содержимое строки; коллизия ПОЛНОСТЬЮ одинаковых строк разруливается счётчиком", () => {
    const rows = parseBankStatement(
      table([
        TITLE_ROW,
        HEADER_ROW,
        ACCOUNT_ROW,
        dataRow({ docNo: "3009296", date: "12.06.25" }),
        dataRow({ docNo: "3009296", date: "12.06.25" }), // тот же номер документа, дата и всё содержимое — законный повтор в файле
      ]),
    );
    assert.ok(rows[0]!.extId.startsWith(`${FAKE_ACCOUNT}::3009296::2025-06-12::`), "счёт, docNo и дата — часть ключа");
    assert.equal(rows[1]!.extId, `${rows[0]!.extId}::2`, "вторая полностью одинаковая строка получает суффикс счётчика, а не схлопывается молча");
    assert.notEqual(rows[0]!.extId, rows[1]!.extId);
  });

  it("две строки, отличающиеся ТОЛЬКО счётом, — разные ключи (без этого ревью нашло 30 совпадений GLOBERENT/VENDHUB)", () => {
    const rowA = dataRow({ docNo: "500", date: "12.06.25", credit: "1000000" });
    const rowB = [...rowA];
    const accountIdx = HEADER_ROW.indexOf("Счёт");
    rowB[accountIdx] = "10208000900000000099"; // другой счёт компании — остальное совпадает один-в-один

    const rows = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, rowA, rowB]));
    assert.equal(rows.length, 2);
    assert.notEqual(
      rows[0]!.extId,
      rows[1]!.extId,
      "разные счета компании с тем же docNo/датой — разные ключи, иначе импорт второй выписки молча теряет строки как «повтор»",
    );
  });

  it("порядок строк в выгрузке не меняет набор уже присвоенных ключей (старый ключ по позиции ломался при перестановке)", () => {
    const rowA = dataRow({ docNo: "1", date: "12.06.25", credit: "1000000" });
    const rowB = dataRow({ docNo: "2", date: "13.06.25", credit: "2000000" });
    const forward = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, rowA, rowB]));
    const reversed = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, rowB, rowA]));
    assert.deepEqual(
      new Set(forward.map((r) => r.extId)),
      new Set(reversed.map((r) => r.extId)),
      "ключ строится по содержимому строки, а не по позиции в файле — переэкспорт с другим порядком строк обязан дать те же ключи",
    );
  });

  it("регистр и лишние пробелы в назначении не меняют ключ — переэкспорт той же операции не создаёт дубль", () => {
    const purposeIdx = HEADER_ROW.indexOf("Назначение платежа");
    const rowA = dataRow({ docNo: "700", date: "12.06.25", credit: "9000000" });
    rowA[purposeIdx] = "Наличные деньги в оборотной кассе";
    const rowB = [...rowA];
    // Тот же платёж в повторной выгрузке банка: двойной пробел и другой регистр.
    rowB[purposeIdx] = "НАЛИЧНЫЕ  деньги в оборотной   кассе";

    const a = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, rowA]));
    const b = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, rowB]));
    assert.equal(
      a[0]!.extId,
      b[0]!.extId,
      "ключ ЗАПЕКАЕТСЯ В ДАННЫЕ: удаления записей нет, и разъехавшийся на пробеле ключ создал бы молчаливый дубль, который потом уже не разгрести",
    );
    assert.equal(a[0]!.purpose, "Наличные деньги в оборотной кассе", "причёсывается ТОЛЬКО ключ — само назначение хранится как в банке");
  });

  it("номер документа пуст — extId строится без него, а не падает", () => {
    const rows = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, dataRow({ docNo: "" })]));
    assert.ok(rows[0]!.extId.startsWith(`${FAKE_ACCOUNT}::без-номера::2025-06-12::`));
  });

  it("шапка с другим порядком колонок читается верно — по имени, не по позиции", () => {
    const shuffled = [...HEADER_ROW].reverse();
    const rowValues = new Map(HEADER_ROW.map((name, i) => [name, dataRow({})[i]]));
    const reversedRow = shuffled.map((name) => rowValues.get(name) ?? "");
    const rows = parseBankStatement(table([TITLE_ROW, shuffled, ACCOUNT_ROW, reversedRow]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.date, "2025-06-12");
    assert.equal(rows[0]!.credit, 9000000);
  });

  it("колонка не найдена в шапке — явная ошибка, а не тихий сдвиг индексов", () => {
    const brokenHeader = HEADER_ROW.filter((n) => n !== "ИНН");
    assert.throws(
      () => parseBankStatement(table([TITLE_ROW, brokenHeader, ACCOUNT_ROW, dataRow({})])),
      /ИНН/,
    );
  });

  it("выписка короче двух строк — явная ошибка, а не пустой результат вслепую", () => {
    assert.throws(() => parseBankStatement(table([TITLE_ROW])), /меньше 2 строк/);
  });

  it("пустая ячейка суммы — null, а не 0 (нет оборота ≠ оборот на ноль сумов)", () => {
    const rows = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, dataRow({ debit: "", credit: "" })]));
    assert.equal(rows[0]!.debit, null);
    assert.equal(rows[0]!.credit, null);
  });

  it("нечисловая ячейка суммы — null, а не NaN, утёкший наружу", () => {
    const rows = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, dataRow({ credit: "н/д" })]));
    assert.equal(rows[0]!.credit, null);
  });

  it("fileRow — позиция строки в rows (для отчёта), не смещённая от заголовков", () => {
    const rows = parseBankStatement(table([TITLE_ROW, HEADER_ROW, ACCOUNT_ROW, dataRow({})]));
    assert.equal(rows[0]!.fileRow, 3);
  });
});

// Тип реэкспортирован — проверяем, что использование в вызывающем коде типизируется без `any`.
function assertShape(r: BankStatementRow): void {
  void r.date;
  void r.extId;
}
void assertShape;
