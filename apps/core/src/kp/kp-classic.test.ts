import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KP_TITLE,
  buildSpecPairs,
  dayWord,
  fmtDateLong,
  fmtKpMoney,
  getPartnerBrand,
  kpSubtitle,
  legalLineText,
  priceBreakdownPairs,
  renderKpClassic,
  termsPairs,
  totalsText,
  type KpClassicInput,
} from "./kp-classic";

/** Intl для ru-RU разделяет разряды неразрывными пробелами — нормализуем. */
function sp(s: string): string {
  return s.replace(/[\u00A0\u202F]/g, " ");
}

/** Полный вход КП для тестов (продавец — параметр, не хардкод). */
function sampleInput(): KpClassicInput {
  return {
    estimation_no: "EST-2026-00012",
    date: "2026-05-11",
    quantity: 2,
    vehicle: {
      brand: "XCMG",
      model: "LW300FN",
      configuration: "ковш 1.8 м³",
      manufacture_year: 2026,
      engine_volume_cc: 6750,
      engine_power_kw: 92,
      load_capacity_kg: 3000,
      fuel_tank_liters: 165,
      extra_specs: [{ label: "Трансмиссия", value: "гидромеханическая" }],
    },
    client: {
      name: "ООО «Клиент»",
      contact_person: "Иванов И.И.",
      inn: "301234567",
    },
    prices: {
      sale_price: 12_500_000,
      sale_price_currency: "UZS",
      factory_price_usd: 38_000,
      transport_price_usd: 2_500,
      discount_percent: 5,
      rate_conversion: 12_500,
    },
    terms: {
      validity_days: 14,
      planned_delivery_days: 30,
    },
    seller: {
      name: "GLOBERENT",
      legal_form: "ООО",
      inn: "305000000",
      address: "г. Ташкент",
      phone: "+998 71 000 00 00",
      website: "globerent.uz",
      director_name: "Директор Д.Д.",
      director_position: "Генеральный директор",
    },
  };
}

describe("КП Classic — заголовок", () => {
  it("заголовок документа — «КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ»", () => {
    assert.equal(KP_TITLE, "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ");
  });

  it("подзаголовок собирается из бренда, модели и конфигурации через « — »", () => {
    assert.equal(kpSubtitle(sampleInput()), "XCMG — LW300FN — ковш 1.8 м³");
  });

  it("явный title важнее собранного подзаголовка", () => {
    const input = { ...sampleInput(), title: "Спецпредложение месяца" };
    assert.equal(kpSubtitle(input), "Спецпредложение месяца");
  });

  it("дата в шапке — длинный русский формат", () => {
    assert.equal(fmtDateLong("2026-05-11"), "11 мая 2026 г.");
  });
});

describe("КП Classic — строка позиции и формат цены донора", () => {
  it("цена без копеек с кодом валюты: «12 500 000 UZS»", () => {
    assert.equal(sp(fmtKpMoney(12_500_000, "UZS")), "12 500 000 UZS");
  });

  it("цена в USD с копейками (разбивка): «38 000,00 USD»", () => {
    assert.equal(sp(fmtKpMoney(38_000, "USD", 2)), "38 000,00 USD");
  });

  it("строки характеристик: пустые пропущены, единицы измерения донора", () => {
    const pairs = buildSpecPairs(sampleInput().vehicle);
    const byLabel = new Map(pairs.map((p) => [p.label, sp(p.value)]));
    assert.equal(byLabel.get("Бренд"), "XCMG");
    assert.equal(byLabel.get("Объём двигателя"), "6 750 см³");
    assert.equal(byLabel.get("Мощность двигателя"), "92 кВт");
    assert.equal(byLabel.get("Грузоподъёмность"), "3 000 кг");
    assert.equal(byLabel.get("Трансмиссия"), "гидромеханическая");
    // Полная масса и габариты не заданы — строк нет.
    assert.equal(byLabel.has("Полная масса"), false);
    assert.equal(byLabel.has("Габариты Д×Ш×В"), false);
  });

  it("разбивка цены: только заданные компоненты, в USD", () => {
    const rows = priceBreakdownPairs(sampleInput().prices);
    assert.deepEqual(
      rows.map((r) => [r.label, sp(r.value)]),
      [
        ["Заводская цена", "38 000,00 USD"],
        ["Транспорт до Узбекистана", "2 500,00 USD"],
      ],
    );
  });
});

describe("КП Classic — итоги", () => {
  it("итог за партию = цена × количество, склонение «единицы»", () => {
    const t = totalsText(sampleInput().prices, 2);
    assert.equal(sp(t.unit), "12 500 000 UZS");
    assert.equal(sp(t.total), "25 000 000 UZS");
    assert.equal(t.qty, "Количество: 2 единицы");
  });

  it("скидка и курс — как у донора; без них строки отсутствуют", () => {
    const withAll = totalsText(sampleInput().prices, 2);
    assert.equal(withAll.discount, "Скидка: −5.0%");
    assert.equal(sp(withAll.rate ?? ""), "Курс конвертации: 12 500 UZS/USD");

    const bare = totalsText({ sale_price: 100, sale_price_currency: "USD" }, 1);
    assert.equal(bare.discount, null);
    assert.equal(bare.rate, null);
  });

  it("склонение дней и условия с дефолтами донора", () => {
    assert.equal(dayWord(14), "дней");
    assert.equal(dayWord(2), "дня");
    assert.equal(dayWord(21), "день");
    const pairs = termsPairs(sampleInput().terms);
    assert.deepEqual(
      pairs.map((p) => [p.label, p.value]),
      [
        ["Срок действия КП", "14 дней"],
        ["Срок поставки", "30 дней"],
        ["Условия оплаты", "Аванс 30%, остаток после поставки"],
        ["Гарантия", "12 месяцев / 1 500 моточасов"],
        ["Условия поставки", "DAP Ташкент, Incoterms 2020"],
      ],
    );
  });

  it("юридическая строка собирается из реквизитов продавца-параметра", () => {
    assert.equal(
      legalLineText(sampleInput().seller),
      "ООО «GLOBERENT» · ИНН: 305000000 · г. Ташкент · +998 71 000 00 00",
    );
  });

  it("каталог партнёрских брендов донора сохранён (поиск без регистра)", () => {
    assert.equal(getPartnerBrand("xcmg")?.display_name, "XCMG Construction Machinery");
    assert.equal(getPartnerBrand("HELI"), null);
  });
});

describe("КП Classic — рендер DOCX", () => {
  it("renderKpClassic возвращает Buffer больше 5000 байт", async () => {
    const buf = await renderKpClassic({ ...sampleInput(), show_breakdown: true });
    assert.ok(Buffer.isBuffer(buf), "ожидался Buffer");
    assert.ok(buf.length > 5000, `слишком маленький DOCX: ${buf.length} байт`);
    // Сигнатура ZIP-контейнера DOCX: «PK».
    assert.equal(buf.subarray(0, 2).toString("ascii"), "PK");
  });
});
