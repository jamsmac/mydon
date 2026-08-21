import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationPipe } from "@nestjs/common";
import { parseBankStatement } from "@mydon/shared";
import { ImportBankStatementDto, ImportBankStatementItemDto } from "./finance.controller";

/**
 * Проверки на уровне DTO ЧЕРЕЗ НАСТОЯЩИЙ `ValidationPipe` — тот же приём, что
 * `stock.controller.test.ts` завёл для среза D, и тот же урок: сервисные
 * тесты (`finance.service.test.ts`) зовут `importBankStatement` напрямую,
 * минуя слой DTO, и слепы к тому, что реально решает `main.ts`.
 *
 * Здесь используются ТЕ ЖЕ опции, что в `main.ts` (`whitelist: true,
 * forbidNonWhitelisted: true, transform: true`), а не голый `validate()` из
 * class-validator (у него `forbidNonWhitelisted` по умолчанию выключен —
 * тест на одном `validate()` без опций эту ловушку тоже не увидел бы).
 *
 * Ловушка (ревью среза К, 1.5): `parseBankStatement` отдаёт 13 полей
 * (`BankStatementRow`), а старое ДТО объявляло только 8 — `account`, `name`,
 * `docType`, `branch`, `inn` были «лишними» с точки зрения `forbidNonWhitelisted`,
 * и ЦЕЛАЯ пачка (2440 строк живой выписки) отбивалась 400 ещё ДО контроллера.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

const HEADER_NAMES = [
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

/** Строит {@link BankStatementRow}[] по-настоящему — через parseBankStatement, а не руками. */
function realParsedItems(): ReturnType<typeof parseBankStatement> {
  const titleRow = ["Информация об операциях по счёту за период"];
  const accountRow = ["", "20208000900000000001", "ООО ТЕСТ КОМПАНИЯ", "", "", "", "", "", "", "", "999999999"];
  const dataRow = [
    "12.06.25",
    "20208000900000000001",
    "Наличные деньги в оборотной кассе",
    "3009296",
    "Приходный кассовый ордер",
    "Головной офис",
    "",
    "9000000.0",
    "Взнос наличных денежных средств",
    "0200",
    "999999999",
  ];
  return parseBankStatement({ columns: titleRow, rows: [titleRow, HEADER_NAMES, accountRow, dataRow] });
}

describe("ImportBankStatementDto через ValidationPipe (main.ts: whitelist + forbidNonWhitelisted)", () => {
  it("настоящая строка parseBankStatement (все 13 полей) проходит пайп целиком, а не отбивается 400", async () => {
    const items = realParsedItems();
    assert.equal(items.length, 1, "фикстура должна дать ровно одну операцию");

    const result = await pipe.transform(
      { items },
      { type: "body", metatype: ImportBankStatementDto, data: "" },
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].account, "20208000900000000001");
    assert.equal(result.items[0].extId, items[0]!.extId);
  });

  it("поле, которого НЕТ ни в parseBankStatement, ни в ДТО, — по-прежнему отбивается (forbidNonWhitelisted живой)", async () => {
    const items = realParsedItems().map((r) => ({ ...r, совсемЛишнееПоле: "мусор" }));
    await assert.rejects(
      () => pipe.transform({ items }, { type: "body", metatype: ImportBankStatementDto, data: "" }),
      /BadRequestException|Bad Request/,
    );
  });

  it("тип по-прежнему проверяется: дебет строкой вместо числа — ошибка, а не молчаливый проход", async () => {
    const items = realParsedItems().map((r) => ({ ...r, debit: "пятьдесят" }));
    await assert.rejects(() =>
      pipe.transform({ items }, { type: "body", metatype: ImportBankStatementDto, data: "" }),
    );
  });

  it("минимальный набор полей ImportBankStatementItemDto (без account/name/docType/branch/inn) отбивается — они теперь ОБЯЗАТЕЛЬНЫ, как и у настоящего парсера", async () => {
    const minimal = { date: "2026-06-01", docNo: "1", extId: "1::2026-06-01" };
    await assert.rejects(() =>
      pipe.transform({ items: [minimal] }, { type: "body", metatype: ImportBankStatementDto, data: "" }),
    );
  });
});

// Тип реэкспортирован — проверяем, что использование в вызывающем коде типизируется без `any`.
function assertShape(dto: ImportBankStatementItemDto): void {
  void dto.account;
  void dto.extId;
}
void assertShape;
