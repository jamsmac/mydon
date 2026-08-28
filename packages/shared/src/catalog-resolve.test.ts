import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productIndex, resolveCatalogName, type AliasRow, type ProductRow } from "./stock-history";

/**
 * Правило каталога живёт в `stock-history.ts` рядом с индексом (выносить его в
 * свой модуль значило бы завести пару «значение туда, типы обратно» ради
 * двадцати строк фасада), но тесты у него СВОИ: `stock-history.test.ts` — про
 * донорский импорт, а это правило теперь исполняет и живой Core на горячем
 * пути ингеста снека.
 */
const карточка = (id: string, name: string): ProductRow => ({ id, name });
const алиас = (productId: string, alias: string): AliasRow => ({ productId, alias });

describe("Резолв каталога: имя карточки главнее алиаса (R-G-1)", () => {
  it("точное имя карточки бьёт алиас, указывающий на ЧУЖОЙ товар", () => {
    // Раньше живой резолвер спрашивал алиас первым, и строка с именем
    // карточки B молча уезжала на карточку A. Имя — то, что владелец видит в
    // прайсе; алиас — вспомогательное написание, перекрывать им прямое
    // попадание нельзя.
    const индекс = productIndex(
      [карточка("p1", "Fanta CAN 0,25"), карточка("p2", "Sprite CAN 0,25")],
      [алиас("p2", "Fanta CAN 0,25")],
    );
    assert.deepEqual(resolveCatalogName(индекс, "Fanta CAN 0,25"), {
      kind: "conflict",
      raw: "Fanta CAN 0,25",
      byName: "Fanta CAN 0,25",
      byAlias: "Sprite CAN 0,25",
    });
  });

  it("алиас на СВОЮ же карточку спором не считается — обе дороги ведут в одно место", () => {
    const индекс = productIndex([карточка("p1", "Coca-Cola Classic 0,5")], [алиас("p1", "Coca-cola classic 0,5")]);
    const о = resolveCatalogName(индекс, "coca-cola  CLASSIC 0,5");
    assert.deepEqual(о, { kind: "hit", canon: "Coca-Cola Classic 0,5", id: "p1", source: "name" });
  });

  it("алиаса хватает, когда имени карточки нет: источник назван «alias»", () => {
    const индекс = productIndex([карточка("p1", "Montella Вода минеральная 330ml")], [алиас("p1", "18+")]);
    assert.deepEqual(resolveCatalogName(индекс, "18+"), {
      kind: "hit",
      canon: "Montella Вода минеральная 330ml",
      id: "p1",
      source: "alias",
    });
  });

  it("промах несёт СЫРОЕ имя — из него владельцу собирают список на разбор", () => {
    const индекс = productIndex([карточка("p1", "Snickers")], []);
    assert.deepEqual(resolveCatalogName(индекс, "Пирожок с чем-то"), { kind: "miss", raw: "Пирожок с чем-то" });
  });

  it("пустое и пробельное имя — промах, а не карточка с пустым каноном", () => {
    const индекс = productIndex([карточка("p1", "Snickers")], []);
    assert.equal(resolveCatalogName(индекс, "").kind, "miss");
    assert.equal(resolveCatalogName(индекс, "   ").kind, "miss");
  });

  it("алиас на удалённый товар в индекс не попадает — привязывать к чему попало нельзя", () => {
    const индекс = productIndex([карточка("p1", "Snickers")], [алиас("p-нет", "Сникерс")]);
    assert.equal(resolveCatalogName(индекс, "Сникерс").kind, "miss");
  });

  it("нормализация одна на всех: запятая, «ё», лишние пробелы, регистр", () => {
    const индекс = productIndex([карточка("p1", "Fanta CAN 0,25"), карточка("p2", "Тёплый чай 0,5")], []);
    for (const raw of ["Fanta CAN 0.25", "fanta  can 0,25", " Fanta CAN 0,25 "]) {
      assert.equal(resolveCatalogName(индекс, raw).kind, "hit", raw);
    }
    const чай = resolveCatalogName(индекс, "Теплый  чай 0.5");
    assert.equal(чай.kind === "hit" ? чай.canon : null, "Тёплый чай 0,5");
  });
});

describe("Резолв каталога: прод-данные 26.08.2026", () => {
  /**
   * ОБА ключа-пересечения прода: нормализованный ключ алиаса равен ключу имени
   * карточки. Замер 26.08: таких ключей ровно два, и оба указывают на СВОЮ же
   * карточку — настоящих споров ноль. Порядок строк перебирается ЯВНО ради
   * самого замера (ответ не должен зависеть от того, как Postgres отдал
   * строки), но коллизии ключей в этих двух случаях нет ни в одном порядке —
   * «последний побеждает» здесь ничем не проверяется. Тот сценарий (два РАЗНЫХ
   * товара с одинаковым нормализованным ключом) — отдельный тест ниже.
   */
  const случаи: { имя: string; карточка: string; алиас: string }[] = [
    { имя: "Coca-cola classic 0,5", карточка: "Coca-Cola Classic 0,5", алиас: "Coca-cola classic 0,5" },
    { имя: "Red bull can 0.25", карточка: "Red Bull CAN 0,25", алиас: "Red bull can 0.25" },
  ];

  for (const с of случаи) {
    for (const порядок of ["карточка первой", "алиас первым"] as const) {
      it(`«${с.имя}»: ${порядок} — та же карточка, спора нет`, () => {
        const карточки = [карточка("p1", с.карточка), карточка("p2", "Snickers")];
        const алиасы = [алиас("p1", с.алиас), алиас("p2", "Сникерс")];
        const индекс =
          порядок === "карточка первой"
            ? productIndex(карточки, алиасы)
            : productIndex([...карточки].reverse(), [...алиасы].reverse());
        const о = resolveCatalogName(индекс, с.имя);
        assert.equal(о.kind, "hit", "оба ключа прода указывают на СВОЮ карточку — конфликта быть не должно");
        assert.equal(о.kind === "hit" ? о.canon : null, с.карточка);
        assert.equal(о.kind === "hit" ? о.id : null, "p1");
      });
    }
  }

  it("две карточки с одним нормализованным ключом — побеждает последняя в массиве (гигиена, m2)", () => {
    // Не спор (карточка+алиас), а дубль (карточка+карточка): `canonByKey`/
    // `idByKey` строятся как `new Map(products.map(...))`, и при совпавшем
    // ключе выигрывает ПОСЛЕДНЯЯ запись массива. Порядок разворачивается явно,
    // чтобы «последний побеждает» было доказанным свойством сборки, а не
    // совпадением: предыдущие два случая этого блока такой коллизии не имели.
    const а = карточка("p1", "Red Bull CAN 0,25");
    const б = карточка("p2", "Red bull can 0.25");
    for (const [первая, вторая] of [
      [а, б],
      [б, а],
    ] as const) {
      const индекс = productIndex([первая, вторая], []);
      const о = resolveCatalogName(индекс, "Red Bull CAN 0,25");
      assert.equal(о.kind, "hit");
      assert.equal(о.kind === "hit" ? о.canon : null, вторая.name, "последняя карточка в массиве обязана победить");
      assert.equal(о.kind === "hit" ? о.id : null, вторая.id);
    }
  });

  it("три строки истории склада с «неправильным» разделителем ложатся на карточки", () => {
    // Ровно эти три строки `vending_stock_count` (замер 26.08) сегодня живой
    // резолвер отдаёт СЫРЫМИ: алиаса у них нет, а имя карточки он не
    // спрашивает. Бэкфилл их уже привязывает — унификация делает живое
    // правило равным ему, и примерка бэкфилла после выкатки печатает
    // «обновилось БЫ 3».
    const пары: [string, string][] = [
      ["Fresh Tag Lemonade CAN 0.45", "Fresh Tag Lemonade CAN 0,45"],
      ["Lit Energy Blueberry CAN 0.45", "Lit Energy Blueberry CAN 0,45"],
      ["Royal Pomegranate CAN 0.3", "Royal Pomegranate CAN 0,3"],
    ];
    const индекс = productIndex(
      пары.map(([, канон], i) => карточка(`p${i + 1}`, канон)),
      [],
    );
    for (const [сырое, канон] of пары) {
      const о = resolveCatalogName(индекс, сырое);
      assert.equal(о.kind === "hit" ? о.canon : null, канон, сырое);
      assert.equal(о.kind === "hit" ? о.source : null, "name");
    }
  });
});
