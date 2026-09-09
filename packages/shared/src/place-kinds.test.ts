import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PLACE_ATTR,
  PLACE_TYPES,
  PLACE_TYPE_HINTS,
  PLACE_TYPE_LABELS,
  isPlaceType,
  placeSells,
  placeStatusConflict,
  placeTypeLabel,
  STATUS_FOR_PLACE_TYPE,
} from "./place-kinds";

describe("виды места", () => {
  it("три вида, названные владельцем", () => {
    assert.deepEqual([...PLACE_TYPES], ["location", "warehouse", "workshop"]);
  });

  it("у каждого есть подпись и подсказка", () => {
    for (const t of PLACE_TYPES) {
      assert.ok(PLACE_TYPE_LABELS[t]?.length > 0, `нет подписи для ${t}`);
      assert.ok(PLACE_TYPE_HINTS[t]?.length > 0, `нет подсказки для ${t}`);
    }
  });

  it("узнаёт своё и отвергает чужое", () => {
    assert.ok(isPlaceType("workshop"));
    // Карточки реестра, которые местом НЕ являются.
    assert.ok(!isPlaceType("machine"));
    assert.ok(!isPlaceType("contractor"));
    assert.ok(!isPlaceType(null));
  });
});

describe("где автомат продаёт", () => {
  it("только на точке продаж", () => {
    assert.ok(placeSells("location"));
    assert.ok(!placeSells("warehouse"), "на складе автомат хранится, а не торгует");
    assert.ok(!placeSells("workshop"), "в мастерской тем более");
  });

  it("неизвестное место не считается торговым", () => {
    // Ошибка в сторону «не продаёт» безопасна: выручка не припишется месту,
    // которого мы не понимаем. Обратная ошибка исказила бы отчёты.
    assert.ok(!placeSells("что-то новое"));
    assert.ok(!placeSells(null));
  });
});

describe("подпись вида", () => {
  it("переводит известные", () => {
    assert.equal(placeTypeLabel("warehouse"), "Склад");
    assert.equal(placeTypeLabel("workshop"), "Мастерская");
  });

  it("неизвестное отдаёт как есть — видно, что в базе неожиданное", () => {
    assert.equal(placeTypeLabel("garage"), "garage");
  });

  it("пусто — нейтральное «Место», а не пустая строка", () => {
    assert.equal(placeTypeLabel(null), "Место");
  });
});

describe("ключи координат", () => {
  it("те же, что читает coordFromAttrs", () => {
    // Форма и карта-пикер обязаны писать в одни ключи, иначе точка вводится,
    // а на карте не появляется.
    assert.equal(PLACE_ATTR.lat, "широта");
    assert.equal(PLACE_ATTR.lng, "долгота");
  });
});

describe("состояние по виду места", () => {
  it("у каждого вида есть подсказываемое состояние", () => {
    assert.equal(STATUS_FOR_PLACE_TYPE.location, "in_service");
    assert.equal(STATUS_FOR_PLACE_TYPE.warehouse, "warehouse");
    assert.equal(STATUS_FOR_PLACE_TYPE.workshop, "repair");
  });

  it("подсказка есть для ВСЕХ видов — иначе форма молча оставит старое", () => {
    for (const t of PLACE_TYPES) {
      assert.ok(STATUS_FOR_PLACE_TYPE[t], `нет состояния для ${t}`);
    }
  });
});

describe("совместимость места и состояния", () => {
  it("в эксплуатации — только точка продаж", () => {
    assert.equal(placeStatusConflict("in_service", "location", "CardioLife"), null);
    assert.match(
      placeStatusConflict("in_service", "warehouse", "Основной склад") ?? "",
      /точке продаж/,
    );
    assert.match(placeStatusConflict("in_service", "workshop", "Мастерская") ?? "", /точке продаж/);
  });

  it("на складе — только склад", () => {
    assert.equal(placeStatusConflict("warehouse", "warehouse", "Основной склад"), null);
    assert.match(
      placeStatusConflict("warehouse", "location", "CardioLife") ?? "",
      /требует склада/,
    );
  });

  it("в ремонте — где угодно: чинят и на точке, и на складе, и в мастерской", () => {
    // Слово владельца 07.08.2026: «места ремонта могут быть разные». Разбитый
    // экран не переносит автомат в мастерскую сам по себе.
    assert.equal(placeStatusConflict("repair", "location", "Parus F4"), null);
    assert.equal(placeStatusConflict("repair", "warehouse", "Основной склад"), null);
    assert.equal(placeStatusConflict("repair", "workshop", "Мастерская"), null);
  });

  it("в тексте отказа названо и место, и его вид — иначе непонятно, что не так", () => {
    const текст = placeStatusConflict("in_service", "warehouse", "Основной склад") ?? "";
    assert.match(текст, /Основной склад/);
    assert.match(текст, /склад/);
  });

  it("состояния нет (карточка без machine_card) — противоречия нет", () => {
    assert.equal(placeStatusConflict(null, "warehouse", "Основной склад"), null);
  });
});
