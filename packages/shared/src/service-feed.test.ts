import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeServiceFeed,
  coffeeRefillToFeed,
  collectionToFeed,
  resolveActor,
  vendingRefillToFeed,
  type ServiceFeedItem,
} from "./service-feed";

describe("Лента полевых событий обслуживания", () => {
  describe("mergeServiceFeed", () => {
    it("сливает несколько лент и сортирует по времени убыванием", () => {
      const a: ServiceFeedItem[] = [
        { kind: "coffee", ts: "2026-08-20T09:00:00+05:00", место: "KIUT", текст: "…", кто: null },
      ];
      const b: ServiceFeedItem[] = [
        { kind: "cash", ts: "2026-08-20T10:00:00+05:00", место: "SKLAD 1C", текст: "…", кто: "Рустам" },
      ];
      const r = mergeServiceFeed([a, b]);
      assert.equal(r.length, 2);
      assert.equal(r[0].kind, "cash");
      assert.equal(r[1].kind, "coffee");
    });

    it("сортирует по фактическому времени, а не лексикографически строку ts — смешанные зоны Z и +05:00", () => {
      // 09:00+05:00 = 04:00Z — раньше 05:00Z, хотя строка "...+05:00" лексикографически больше "...Z".
      const earlier: ServiceFeedItem = {
        kind: "coffee",
        ts: "2026-08-20T09:00:00+05:00",
        место: "A",
        текст: "…",
        кто: null,
      };
      const later: ServiceFeedItem = { kind: "cash", ts: "2026-08-20T05:00:00Z", место: "B", текст: "…", кто: null };
      const r = mergeServiceFeed([[earlier], [later]]);
      assert.equal(r[0].место, "B");
      assert.equal(r[1].место, "A");
    });

    it("без явного лимита возвращает всё, отсортированное (C2: фильтр на service-tab не должен видеть уже обрезанную ленту)", () => {
      const items: ServiceFeedItem[] = Array.from({ length: 60 }, (_, i) => ({
        kind: "coffee" as const,
        ts: new Date(2026, 7, 1, 0, i).toISOString(),
        место: `M${i}`,
        текст: "…",
        кто: null,
      }));
      const r = mergeServiceFeed([items]);
      assert.equal(r.length, 60);
      // Порядок сохраняется убывающим по времени и без лимита.
      assert.equal(r[0].место, "M59");
      assert.equal(r[59].место, "M0");
    });

    it("уважает переданный лимит", () => {
      const items: ServiceFeedItem[] = Array.from({ length: 10 }, (_, i) => ({
        kind: "snack" as const,
        ts: new Date(2026, 7, 1, 0, i).toISOString(),
        место: `M${i}`,
        текст: "…",
        кто: null,
      }));
      const r = mergeServiceFeed([items], 3);
      assert.equal(r.length, 3);
    });
  });

  describe("coffeeRefillToFeed", () => {
    it("формирует текст «бункер N · ингредиент · залито X г»", () => {
      const item = coffeeRefillToFeed({
        locationName: "KIUT корпус 3",
        position: 7,
        ingredientName: "Кофе",
        filledWeight: 1628,
        createdAt: "2026-08-20T09:00:00+05:00",
        createdBy: "Азиз",
      });
      assert.equal(item.kind, "coffee");
      assert.equal(item.ts, "2026-08-20T09:00:00+05:00");
      assert.equal(item.место, "KIUT корпус 3");
      assert.equal(item.текст, `бункер 7 · Кофе · залито ${(1628).toLocaleString("ru-RU")} г`);
      assert.equal(item.кто, "Азиз");
    });

    it("ingredientName null → «без ингредиента», createdBy null остаётся null", () => {
      const item = coffeeRefillToFeed({
        locationName: "KIUT",
        position: 3,
        ingredientName: null,
        filledWeight: 500,
        createdAt: "2026-08-20T09:00:00+05:00",
        createdBy: null,
      });
      assert.equal(item.текст, `бункер 3 · без ингредиента · залито ${(500).toLocaleString("ru-RU")} г`);
      assert.equal(item.кто, null);
    });
  });

  describe("collectionToFeed", () => {
    it("формирует текст «инкассация N сум»", () => {
      const item = collectionToFeed({
        machineName: "SKLAD 1C",
        collectedAt: "2026-08-20T10:00:00+05:00",
        amount: 452000,
        operatorName: "Рустам",
      });
      assert.equal(item.kind, "cash");
      assert.equal(item.ts, "2026-08-20T10:00:00+05:00");
      assert.equal(item.место, "SKLAD 1C");
      assert.equal(item.текст, `инкассация ${(452000).toLocaleString("ru-RU")} сум`);
      assert.equal(item.кто, "Рустам");
    });

    it("amount null → «инкассация — сумма не введена»; machineName null → место «—»", () => {
      const item = collectionToFeed({
        machineName: null,
        collectedAt: "2026-08-20T10:00:00+05:00",
        amount: null,
        operatorName: null,
      });
      assert.equal(item.место, "—");
      assert.equal(item.текст, "инкассация — сумма не введена");
      assert.equal(item.кто, null);
    });
  });

  describe("vendingRefillToFeed", () => {
    it("формирует текст «спирали: M поз. · K шт»", () => {
      const item = vendingRefillToFeed({
        machineName: "Olma",
        createdAt: "2026-08-20T11:00:00+05:00",
        positions: 12,
        units: 84,
        createdBy: "Шерзод",
      });
      assert.equal(item.kind, "snack");
      assert.equal(item.ts, "2026-08-20T11:00:00+05:00");
      assert.equal(item.место, "Olma");
      assert.equal(item.текст, "спирали: 12 поз. · 84 шт");
      assert.equal(item.кто, "Шерзод");
    });

    it("machineName null → место «—», createdBy null остаётся null", () => {
      const item = vendingRefillToFeed({
        machineName: null,
        createdAt: "2026-08-20T11:00:00+05:00",
        positions: 5,
        units: 20,
        createdBy: null,
      });
      assert.equal(item.место, "—");
      assert.equal(item.кто, null);
    });
  });

  describe("resolveActor", () => {
    const people = [
      { id: "p1", name: "Азиз" },
      { id: "p2", name: "Рустам" },
    ];

    it("person:<uuid> — имя из people по id", () => {
      assert.equal(resolveActor("person:p1", people), "Азиз");
      assert.equal(resolveActor("person:p2", people), "Рустам");
    });

    it("person:<uuid>, которого нет в people — null, а не сырой UUID", () => {
      assert.equal(resolveActor("person:ghost", people), null);
    });

    it("import:* — «импорт»", () => {
      assert.equal(resolveActor("import:telegram-history", people), "импорт");
    });

    it("bot — «бот»", () => {
      assert.equal(resolveActor("bot", people), "бот");
    });

    it("остальное — как есть (уже разрешённое имя, owner, логин)", () => {
      assert.equal(resolveActor("owner", people), "owner");
      assert.equal(resolveActor("Рустам", people), "Рустам");
    });

    it("null и пустая строка — null", () => {
      assert.equal(resolveActor(null, people), null);
      assert.equal(resolveActor("", people), null);
      assert.equal(resolveActor("   ", people), null);
    });
  });
});
