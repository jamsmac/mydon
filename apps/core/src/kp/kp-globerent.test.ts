import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KP_DEFAULT_CONDITIONS,
  KP_DEFAULT_FOOTER,
  KP_DEFAULT_WARRANTY,
  KP_INTRO,
  kpConditions,
  kpDate,
  kpNumber,
  kpPriceText,
  kpSubtitle,
  renderKpGloberent,
} from "./kp-globerent";

/**
 * Golden-тесты КП по РЕАЛЬНЫМ образцам владельца (2026-08-04):
 * CPD15 (КП-2026/0507-1), CPD20 (КП-2026/0507-2), BF30-1 (КП-2026/0720-1),
 * CBD30-170HA. Эталонные строки взяты из PDF дословно.
 */

describe("номер и дата КП — схема образцов", () => {
  it("КП-ГГГГ/ММДД-N: первый и второй за 7 мая, первый за 20 июля", () => {
    assert.equal(kpNumber("2026-05-07", 1), "КП-2026/0507-1");
    assert.equal(kpNumber("2026-05-07", 2), "КП-2026/0507-2");
    assert.equal(kpNumber("2026-07-20", 1), "КП-2026/0720-1");
  });
  it("дата и подзаголовок как в образце: «№ КП-2026/0507-1 · 07.05.2026»", () => {
    assert.equal(kpDate("2026-05-07"), "07.05.2026");
    assert.equal(kpSubtitle("КП-2026/0507-1", "2026-05-07"), "№ КП-2026/0507-1 · 07.05.2026");
  });
});

describe("цена с НДС — формат образцов", () => {
  it("227 360 000 сум (CPD15), 247 520 000 сум (CPD20), 3 808 000 сум (BF30-1)", () => {
    // локаль ru-RU разделяет разряды неразрывным пробелом — сравниваем, приведя к обычному
    const plain = (s: string): string => s.replace(/[\u00A0\u202F]/g, " ");
    assert.equal(plain(kpPriceText(227_360_000)), "227 360 000 сум");
    assert.equal(plain(kpPriceText(247_520_000)), "247 520 000 сум");
    assert.equal(plain(kpPriceText(3_808_000)), "3 808 000 сум");
  });
});

describe("дефолтные блоки — дословно с образцов", () => {
  it("вводный абзац начинается с «Компания Globerent Finance предлагает поставку складской техники HELI»", () => {
    assert.ok(KP_INTRO.startsWith("Компания Globerent Finance предлагает поставку складской техники HELI"));
  });
  it("условия оплаты: «50% предоплата, 50% по факту готовности…»", () => {
    assert.ok(KP_DEFAULT_CONDITIONS.payment.startsWith("50% предоплата, 50% по факту готовности"));
    assert.equal(KP_DEFAULT_CONDITIONS.included, "Предпродажная подготовка, ЗИП ящик, зарядное устройство");
    assert.equal(KP_DEFAULT_CONDITIONS.delivery, "Доставка до склада Покупателя в Ташкенте");
    assert.equal(KP_DEFAULT_CONDITIONS.leadTime, "В наличии");
  });
  it("гарантия HELI: 2 года / 4 000 мото-часов и 5 лет на Li-Ion", () => {
    assert.equal(KP_DEFAULT_WARRANTY.title, "ГАРАНТИЙНЫЕ ОБЯЗАТЕЛЬСТВА HELI");
    assert.ok(KP_DEFAULT_WARRANTY.lines[0]?.includes("2 года или 4 000 мото/часов"));
    assert.ok(KP_DEFAULT_WARRANTY.lines[1]?.includes("5 лет"));
  });
  it("футер несёт адрес, телефон и почту с бланка", () => {
    assert.ok(KP_DEFAULT_FOOTER.includes("Шохимардон, 17"));
    assert.ok(KP_DEFAULT_FOOTER.includes("+998 71 200 1 201"));
    assert.ok(KP_DEFAULT_FOOTER.includes("globerefin@gmail.com"));
  });
  it("перекрытие условий не трогает остальные поля (короткие КП: «Гарантия 6 месяцев»)", () => {
    const c = kpConditions({ leadTime: "3 дня", payment: "100 % предоплата" });
    assert.equal(c.leadTime, "3 дня");
    assert.equal(c.payment, "100 % предоплата");
    assert.equal(c.included, KP_DEFAULT_CONDITIONS.included);
  });
});

describe("рендер DOCX", () => {
  const base = {
    kpNo: "КП-2026/0507-1",
    date: "2026-05-07",
    tagline: "Электрический вилочный погрузчик 1 500 кг · 4 500 мм",
    tableTitle: "ЭЛЕКТРИЧЕСКИЙ ВИЛОЧНЫЙ ПОГРУЗЧИК  LI-ION  ·  G3 СЕРИЯ  ·  CPD 15-GB3LI-S",
    rows: [
      { label: "Модель", value: "CPD 15-GB3Li" },
      { label: "Грузоподъёмность, кг", value: "1 500" },
      { label: "Высота подъёма груза, мм", value: "4 500" },
      { label: "Мачта", value: "ZSM 450" },
    ],
    priceWithVat: 227_360_000,
  };

  it("smoke: полный КП (с характеристиками второй страницей) — валидный docx-буфер", async () => {
    const buf = await renderKpGloberent({
      ...base,
      aboutModel:
        "В предложении представлен электрический вилочный погрузчик CPD 15-GB3LI-S серии G3 в литий-ионном исполнении.",
      specGroups: [
        {
          title: "ИДЕНТИФИКАЦИЯ",
          rows: [
            { label: "Производитель", value: "HELI" },
            { label: "Серия", value: "G3 Series" },
          ],
        },
      ],
    });
    assert.ok(buf.length > 5000, `буфер ${buf.length} байт`);
    assert.equal(buf.subarray(0, 2).toString("latin1"), "PK", "docx — это zip");
  });

  it("короткий КП без условий и гарантии (как BF30-1) тоже собирается", async () => {
    const buf = await renderKpGloberent({
      kpNo: "КП-2026/0720-1",
      date: "2026-07-20",
      tableTitle: "ГИДРАВЛИЧЕСКАЯ ТЕЛЕЖКА  ·  BF30-1",
      rows: [
        { label: "Модель", value: "BF30-1" },
        { label: "Грузоподъёмность, кг", value: "3 000" },
      ],
      priceWithVat: 3_808_000,
      conditions: null,
      warranty: { title: "ГАРАНТИЯ", lines: ["6 месяцев"] },
    });
    assert.ok(buf.length > 4000);
  });

  it("кривая цена — отказ словами", async () => {
    await assert.rejects(() => renderKpGloberent({ ...base, priceWithVat: 0 }), /больше нуля/);
  });
});
