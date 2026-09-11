import { describe, expect, it } from "vitest";
import type { CoffeePlacementRow, Entity } from "./core";
import { placeMapCounts, placePoints } from "./place-points";

function ent(id: string, type: string, over: Partial<Entity> = {}): Entity {
  return {
    id,
    type,
    name: id,
    externalRef: null,
    attrs: {},
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...over,
  };
}

const geo = (lat: number, lng: number) => ({ geo: { lat, lng, address: null } });

function stay(machine: string, place: string, endDate: string | null = null): CoffeePlacementRow {
  return {
    id: `${machine}-${place}`,
    locationId: place,
    locationName: place,
    entityId: machine,
    machineName: machine,
    machineRef: null,
    startDate: "2026-09-01",
    endDate,
    note: null,
  };
}

const coffee = (id: string) => ent(id, "machine", { attrs: { категория: 10 } });
const snack = (id: string) => ent(id, "machine", { attrs: { категория: 20 } });

describe("точки карты — места (М-4)", () => {
  it("автомат показан на своём месте координатами места, а не своими", () => {
    const place = ent("olma", "location", geo(41.33, 69.28));
    const m = ent("m1", "machine", { attrs: { категория: 10, широта: 40.1, долгота: 70.1 } });
    const [p] = placePoints([place], [m], [stay("m1", "olma")]);
    expect(p).toMatchObject({ id: "olma", lat: 41.33, lng: 69.28, kind: "coffee" });
    expect(p!.machines).toEqual([{ id: "m1", name: "m1" }]);
  });

  it("увезли автомат — точка места остаётся на карте пустой, а не исчезает", () => {
    const place = ent("olma", "location", geo(41.33, 69.28));
    const [p] = placePoints([place], [coffee("m1")], [stay("m1", "olma", "2026-09-10")]);
    expect(p).toMatchObject({ id: "olma", kind: "empty", machines: [] });
  });

  it("кофе и снек на одном месте — смешанная точка", () => {
    const place = ent("kiut", "location", geo(41.34, 69.33));
    const [p] = placePoints([place], [coffee("m1"), snack("m2")], [stay("m1", "kiut"), stay("m2", "kiut")]);
    expect(p!.kind).toBe("mixed");
  });

  it("два места по одному адресу с разными координатами — две точки, не дубликат (М-10)", () => {
    const lib = ent("kiut-lib", "location", { geo: { lat: 41.3401, lng: 69.3301, address: "ул. Шота Руставели, 156" } });
    const dorm = ent("kiut-dorm", "location", { geo: { lat: 41.3409, lng: 69.3312, address: "ул. Шота Руставели, 156" } });
    expect(placePoints([lib, dorm], [], [])).toHaveLength(2);
  });

  it("не место и перепутанные широта/долгота на карту не попадают", () => {
    const swapped = ent("x", "location", geo(69.28, 41.33));
    const contractor = ent("c", "contractor", geo(41.3, 69.2));
    expect(placePoints([swapped, contractor], [], [])).toEqual([]);
  });

  it("слитая карточка (М-9) — не место на земле: точки нет", () => {
    const merged = ent("dup", "location", { ...geo(41.32, 69.3), attrs: { "слита в": "real", выключена: true } });
    expect(placePoints([merged], [], [])).toEqual([]);
  });

  it("пока geo нет — координаты места из attrs", () => {
    const place = ent("old", "warehouse", { attrs: { широта: "41.30", долгота: "69.25" } });
    expect(placePoints([place], [], [])[0]).toMatchObject({ lat: 41.3, lng: 69.25 });
  });
});

describe("подпись под картой называет обе причины раздельно", () => {
  it("автомат на месте без координат ≠ автомат без места", () => {
    const withCoords = ent("a", "location", geo(41.3, 69.2));
    const noCoords = ent("b", "location");
    const emptyNoCoords = ent("c", "warehouse");
    const c = placeMapCounts(
      [withCoords, noCoords, emptyNoCoords],
      [coffee("m1"), coffee("m2"), snack("m3")],
      [stay("m1", "a"), stay("m2", "b")],
    );
    expect(c.machinesTotal).toBe(3);
    expect(c.machinesOnMap).toBe(1);
    expect(c.machinesOnPlacesNoCoords).toBe(1);
    expect(c.placesNoCoords.map((p) => p.id)).toEqual(["b"]);
    expect(c.placesNoCoordsTotal).toBe(2);
    expect(c.machinesNoPlace.map((m) => m.id)).toEqual(["m3"]);
  });
});
