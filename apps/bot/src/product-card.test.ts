import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendingProductCard } from "./core-client";
import { formatProductCard, isProductCardTrigger, parseProductCardCommand } from "./product-card";

const СТРОКА: VendingProductCard = {
  id: "p-snick",
  name: "Snickers 50gr",
  category: "snack",
  purchasePrice: 7000,
  salePrice: 15000,
  packSize: 10,
  isActive: true,
  excludedFromPurchase: false,
  fixedPurchaseQty: 48,
  fiscal: {
    ikpu: "01806001001086002",
    mxik: null,
    vatPct: 12,
    barcode: null,
    packageCode: "796",
    marked: false,
  },
};

describe("Команда «карточка <товар>»", () => {
  it("«карточка Snickers 50gr» разобрана, «что закупать» — нет", () => {
    assert.equal(isProductCardTrigger("карточка Snickers 50gr"), true);
    assert.equal(parseProductCardCommand("карточка Snickers 50gr"), "Snickers 50gr");
    assert.equal(parseProductCardCommand("карточка: Snickers 50gr"), "Snickers 50gr");
    assert.equal(isProductCardTrigger("что закупать"), false);
    assert.equal(isProductCardTrigger("новая карточка"), false, "заведение карточки сотрудника — чужой поток");
  });

  it("голая «карточка» — подсказка, а не запрос в Core", () => {
    assert.equal(parseProductCardCommand("карточка"), null);
    assert.equal(parseProductCardCommand("карточка   "), null);
  });
});

describe("Печать карточки товара", () => {
  it("печатает фискальный блок целиком и подписывает ОКЕИ словом", () => {
    const текст = formatProductCard(СТРОКА);
    assert.match(текст, /Snickers 50gr/);
    assert.match(текст, /ИКПУ.*01806001001086002/);
    assert.match(текст, /НДС.*12 %/);
    assert.match(текст, /796.*Штука/, "код ОКЕИ без подписи владельцу ничего не говорит");
    assert.match(текст, /Маркировка.*Не требуется/);
    assert.doesNotMatch(текст, /Править фискальные поля/, "готовую карточку незачем отправлять в редактор");
  });

  it("пустое поле печатается как «—», а не пропускается", () => {
    const текст = formatProductCard(СТРОКА);
    assert.match(текст, /МХИК.*—/);
    assert.match(текст, /Штрихкод.*—/);
  });

  it("дыры печатаются списком, а «чек соберётся» — одной строкой", () => {
    assert.match(formatProductCard(СТРОКА), /Чек соберётся/);
    const дырявый = { ...СТРОКА, fiscal: { ...СТРОКА.fiscal, ikpu: null } };
    const текст = formatProductCard(дырявый);
    assert.match(текст, /Чек не соберётся/);
    assert.match(текст, /ИКПУ.*код не выяснен/);
    assert.match(текст, /Править фискальные поля.*VendHub.*Правила закупа.*Править/);
  });

  it("правила закупа и цены — в той же карточке, чтобы за ними не ходить второй командой", () => {
    const текст = formatProductCard({ ...СТРОКА, excludedFromPurchase: true });
    assert.match(текст, /7 000/);
    assert.match(текст, /блок 10/i);
    assert.match(текст, /фикс 48/i);
    assert.match(текст, /не закупаем/i);
  });

  it("неизвестные цены и фикс печатает явно, а не прячет", () => {
    const текст = formatProductCard({ ...СТРОКА, purchasePrice: null, salePrice: null, fixedPurchaseQty: null });
    assert.match(текст, /Закуп — сум/);
    assert.match(текст, /витрина — сум/);
    assert.match(текст, /фикс —/);
  });
});
