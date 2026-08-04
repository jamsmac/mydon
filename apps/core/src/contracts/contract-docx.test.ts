import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fmtMoney } from "@mydon/shared";
import {
  buildContractTexts,
  contractTitle,
  dateRu,
  paymentClauseTexts,
  renderContractDocx,
  type ContractDocParams,
  type ContractDocxInput,
  type ContractParty,
} from "./contract-docx";

/**
 * Golden-тесты DOCX-слоя (§11 спеки, п.17–19): фиксируют тексты пунктов
 * донора PROMACH до/после переноса. Чистый текстовый слой проверяется без
 * docx; сборка Document — smoke-тестом на Buffer.
 */

/** Продавец из параметра (замена хардкода донора) — нейтральные реквизиты. */
const seller: ContractParty = {
  name: "ООО «ПРОДАВЕЦ ТЕСТ»",
  director: "Иванов И.И.",
  inn: "123456789",
  address: "г. Ташкент, ул. Тестовая, 1",
  account: "2020 0000 0000 0000 0001",
  bank: "АКБ «Тест Банк»",
  mfo: "00000",
  oked: "45191",
  nds: "000000000001",
  phone: "+998 90 000 00 00",
};

const docParams = (over: Partial<ContractDocParams> = {}): ContractDocParams => ({
  payDays: 5,
  prepayPct: 0,
  installMonths: 0,
  installInterest: 0,
  partialTranches: [],
  penaSeller: 0.1,
  penaBuyer: 0.1,
  penaMax: 15,
  copies: 2,
  warrantyMode: "spec",
  ...over,
});

/** Фикс. вход §11 п.17: №15, 04.08.2026, 1×HELI CPCD30, 112 000 000, 100%, payDays=5. */
const baseInput = (over: Partial<ContractDocxInput> = {}): ContractDocxInput => ({
  contractNo: "15",
  contractDate: "2026-08-04",
  buyer: { name: "ООО «ПОКУПАТЕЛЬ»", director: "Петров П.П.", inn: "987654321" },
  seller,
  items: [{ name: "HELI CPCD30, 2025 г.в., VIN: LC0C99999", unit: "шт", qty: 1, price: 112_000_000 }],
  payType: "100",
  docParams: docParams(),
  deliveryDays: 10,
  ...over,
});

describe("contract-docx: заголовок и дата (§11 п.17)", () => {
  it("заголовок — «ДОГОВОР КУПЛИ-ПРОДАЖИ № 15/ОП»", () => {
    assert.equal(contractTitle("15"), "ДОГОВОР КУПЛИ-ПРОДАЖИ № 15/ОП");
  });

  it("пустой номер — прочерк «__» как у донора", () => {
    assert.equal(contractTitle(""), "ДОГОВОР КУПЛИ-ПРОДАЖИ № __/ОП");
  });

  it("dateRu('2026-08-04') → «4» августа 2026 г. (кавычки-ёлочки донора)", () => {
    assert.equal(dateRu("2026-08-04"), "«4» августа 2026 г.");
  });
});

describe("contract-docx: п.2.1 общая сумма (§11 п.17)", () => {
  it("112 000 000 → «112 000 000,00 сум, включая НДС 12% — 12 000 000,00 сум.»", () => {
    const t = buildContractTexts(baseInput());
    // Формат донора: toLocaleString('ru-RU') — разряды через NBSP.
    assert.equal(fmtMoney(112_000_000), "112 000 000,00");
    assert.equal(
      t.sumClause,
      `Общая сумма: ${fmtMoney(112_000_000)} сум, включая НДС 12% — ${fmtMoney(12_000_000)} сум.`,
    );
    assert.ok(t.sumClause.includes("НДС 12%"));
  });
});

describe("contract-docx: п.3.1 порядок расчётов (§11 п.17–18)", () => {
  it("100% с payDays=5 — содержит «в течение 5 банковских»", () => {
    const p = paymentClauseTexts(112_000_000, "100", docParams({ payDays: 5 }));
    assert.ok(p.lead.includes("в течение 5 банковских"));
    assert.ok(p.lead.includes(`оплату 100% (${fmtMoney(112_000_000)} сум)`));
    assert.equal(p.items.length, 0);
  });

  it("рассрочка 3 мес — «— первый платеж», «— второй платеж», «— третий платеж»", () => {
    const p = paymentClauseTexts(
      112_000_000,
      "install",
      docParams({ prepayPct: 10, installMonths: 3, installFirstDate: "2026-09-01" }),
    );
    assert.ok(p.lead.includes("Первоначальный взнос 10%"));
    assert.equal(p.items.length, 3);
    assert.ok(p.items[0].includes("— первый платеж"));
    assert.ok(p.items[1].includes("— второй платеж"));
    assert.ok(p.items[2].includes("— третий платеж"));
    // Даты — start + i месяцев (семантика setMonth донора).
    assert.ok(p.items[0].includes("01.09.2026"));
    assert.ok(p.items[1].includes("01.10.2026"));
    assert.ok(p.items[2].includes("01.11.2026"));
    // Ставка 0 → равные платежи: остаток 100 800 000 / 3.
    assert.ok(p.items[0].includes(fmtMoney(100_800_000 / 3)));
  });

  it("транши partial — доли от суммы с событиями", () => {
    const p = paymentClauseTexts(
      100_000_000,
      "partial",
      docParams({
        partialTranches: [
          { pct: 30, days: 3, event: "after_signing" },
          { pct: 70, days: 10, event: "after_delivery" },
        ],
      }),
    );
    assert.ok(p.lead.startsWith("Оплата производится траншами:"));
    assert.ok(p.lead.includes(`(1) 30% (${fmtMoney(30_000_000)} сум) в течение 3 банковских дней с даты подписания Договора`));
    assert.ok(p.lead.includes(`(2) 70% (${fmtMoney(70_000_000)} сум) в течение 10 банковских дней после поставки Товара`));
  });
});

describe("contract-docx: реквизиты продавца из параметра (§11 п.19)", () => {
  it("в собранных текстах продавец — из входа, хардкода донора нет", () => {
    const t = buildContractTexts(baseInput());
    const all = JSON.stringify(t);
    assert.ok(all.includes("ООО «ПРОДАВЕЦ ТЕСТ»"));
    assert.ok(all.includes("Иванов И.И."));
    assert.ok(!all.includes("TEXNIKA ADVANS SERVIS"));
    assert.ok(!all.includes("Мираюбов"));
  });

  it("строки «TEXNIKA ADVANS SERVIS» нет в коде модуля вовсе", () => {
    // Читаем собранный модуль рядом с тестом (dist/contracts/contract-docx.js).
    const source = readFileSync(join(__dirname, "contract-docx.js"), "utf8");
    assert.ok(!source.includes("TEXNIKA"));
    assert.ok(!source.includes("ADVANS"));
  });

  it("гарантийный сервис — из параметра serviceCompany", () => {
    const t = buildContractTexts(baseInput({ serviceCompany: "ООО «СЕРВИС ПЛЮС»" }));
    assert.equal(t.serviceClause, "Гарантийное обслуживание — ООО «СЕРВИС ПЛЮС».");
  });
});

describe("contract-docx: гарантия, поставка, пеня, экземпляры", () => {
  it("warrantyMode='spec' — текст донора про 1 год / 2000 моточасов", () => {
    const t = buildContractTexts(baseInput());
    assert.equal(
      t.warrantyClause,
      "Гарантийный срок: 1 год или 2000 моточасов для спецтехники; 6 месяцев для самоходной техники. Подробные условия — в Приложении №1.",
    );
  });

  it("п.6.1 — самовывоз в течение N банковских дней", () => {
    const t = buildContractTexts(baseInput({ deliveryDays: 7 }));
    assert.equal(t.deliveryClause, "Самовывоз со склада Продавца в течение 7 банковских дней с момента 100% оплаты.");
  });

  it("п.8.1/8.2 — пеня из docParams", () => {
    const t = buildContractTexts(baseInput());
    assert.equal(t.penaltySeller, "Пеня Продавца за просрочку: 0.1%/день, не более 15%.");
    assert.equal(t.penaltyBuyer, "Пеня Покупателя за просрочку: 0.1%/день, не более 15%.");
  });

  it("п.11.2 — число экземпляров", () => {
    const t = buildContractTexts(baseInput());
    assert.equal(t.copiesClause, "Составлен в 2 экземплярах. ГК РУз, Закон №670-I от 29.08.1998 г.");
  });
});

describe("contract-docx: renderContractDocx (smoke)", () => {
  it("возвращает Buffer длиной > 5000 байт", async () => {
    const buf = await renderContractDocx(baseInput());
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 5000, `ожидали > 5000 байт, получили ${buf.length}`);
    // DOCX — это zip: сигнатура PK.
    assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  });

  it("рассрочка рендерится без ошибок", async () => {
    const buf = await renderContractDocx(
      baseInput({
        payType: "install",
        docParams: docParams({ prepayPct: 10, installMonths: 3, installFirstDate: "2026-09-01" }),
      }),
    );
    assert.ok(buf.length > 5000);
  });
});
