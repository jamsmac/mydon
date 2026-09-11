import { coordFromAttrs, isMergedPlace, isPlaceType } from "@mydon/shared";
import type { CoffeePlacementRow, Entity } from "./core";
import { KIND_COLOR, machineKindOf, type MachineKind } from "./machine-points";

/**
 * Точки карты парка — МЕСТА, а не автоматы (М-4, волна 2).
 *
 * Координата описывает место: место стоит на земле, автомат переезжает. Пока
 * карта рисовала автоматы, при каждом переезде координаты надо было вводить
 * заново, а увезённый на склад автомат стирал с карты точку, которая никуда не
 * делась. Теперь точка — место с координатами, а автоматы — то, что на нём
 * стоит сейчас (открытый период `machine_placement`).
 *
 * Место без автоматов тоже на карте — пунктиром: это правда о земле («здесь
 * наша точка, сейчас пусто»), а не шум.
 */
export type PointKind = MachineKind | "mixed" | "empty";

export interface PlacePoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: PointKind;
  address: string | null;
  machines: { id: string; name: string }[];
}

/** Рамка Узбекистана: ловит перепутанные широту и долготу (находка 2026-07-30). */
function inUzbekistan(lat: number, lng: number): boolean {
  return lat >= 30 && lat <= 55 && lng >= 55 && lng <= 80;
}

/** Координаты места: типизированная точка, пока её нет — attrs. */
function placeCoord(p: Entity): { lat: number; lng: number } | null {
  const c = p.geo ? { lat: p.geo.lat, lng: p.geo.lng } : coordFromAttrs(p.attrs).coord;
  if (!c || !inUzbekistan(c.lat, c.lng)) return null;
  return c;
}

function pointKind(kinds: MachineKind[]): PointKind {
  if (kinds.length === 0) return "empty";
  const first = kinds[0]!;
  return kinds.every((k) => k === first) ? first : "mixed";
}

/** Кто стоит где сейчас: место → автоматы с открытым периодом. */
function machinesByPlace(machines: Entity[], open: CoffeePlacementRow[]): Map<string, Entity[]> {
  const byId = new Map(machines.map((m) => [m.id, m]));
  const out = new Map<string, Entity[]>();
  for (const row of open) {
    if (row.endDate !== null) continue;
    const m = byId.get(row.entityId);
    if (!m) continue;
    out.set(row.locationId, [...(out.get(row.locationId) ?? []), m]);
  }
  return out;
}

export function placePoints(places: Entity[], machines: Entity[], placements: CoffeePlacementRow[]): PlacePoint[] {
  const onPlace = machinesByPlace(machines, placements);
  const out: PlacePoint[] = [];
  for (const p of places) {
    // Слитая карточка (М-9) — не место на земле, а закрытый дубль: его история
    // переехала на целевую, точки на карте у него быть не должно.
    if (!isPlaceType(p.type) || isMergedPlace(p.attrs)) continue;
    const c = placeCoord(p);
    if (!c) continue;
    const here = onPlace.get(p.id) ?? [];
    const addr = p.geo?.address ?? p.attrs?.["адрес"];
    out.push({
      id: p.id,
      name: p.name,
      lat: c.lat,
      lng: c.lng,
      kind: pointKind(here.map(machineKindOf)),
      address: typeof addr === "string" && addr.length > 0 ? addr : null,
      machines: here.map((m) => ({ id: m.id, name: m.name })),
    });
  }
  return out;
}

/**
 * Честная подпись под картой: сколько автоматов видно и ПОЧЕМУ остальных нет.
 * «Без места» и «место без координат» — разные поломки с разными починками:
 * первое чинится в «Где стоит» автомата, второе — в карточке места.
 */
export function placeMapCounts(allPlaces: Entity[], machines: Entity[], placements: CoffeePlacementRow[]) {
  const places = allPlaces.filter((p) => !isMergedPlace(p.attrs));
  const pts = placePoints(places, machines, placements);
  const onMapPlaces = new Set(pts.map((p) => p.id));
  const onPlace = machinesByPlace(machines, placements);
  const placed = new Set([...onPlace.values()].flat().map((m) => m.id));
  const machinesOnMap = pts.flatMap((p) => p.machines);
  const kindOnMap = (k: MachineKind) =>
    pts.flatMap((p) => onPlace.get(p.id) ?? []).filter((m) => machineKindOf(m) === k).length;
  const placesNoCoords = places.filter((p) => isPlaceType(p.type) && !onMapPlaces.has(p.id) && onPlace.has(p.id));
  return {
    machinesTotal: machines.length,
    machinesOnMap: machinesOnMap.length,
    coffee: kindOnMap("coffee"),
    snack: kindOnMap("snack"),
    unknown: kindOnMap("unknown"),
    /** Автоматы без открытого периода — не знаем, где стоят. */
    machinesNoPlace: machines.filter((m) => !placed.has(m.id)),
    /** Места, где стоят автоматы, но координат нет — эти автоматы на карте не видны. */
    placesNoCoords,
    machinesOnPlacesNoCoords: placesNoCoords.flatMap((p) => onPlace.get(p.id) ?? []).length,
    /** Все места без координат, включая пустые, — для счёта в «Местах». */
    placesNoCoordsTotal: places.filter((p) => isPlaceType(p.type) && !onMapPlaces.has(p.id)).length,
    emptyPlacesOnMap: pts.filter((p) => p.kind === "empty").length,
  };
}

/**
 * Цвета точек: вид автоматов на месте. Смешанное место и пустое — свои цвета:
 * «пусто» — светлее и пунктиром, чтобы не спутать с «вид не указан».
 */
export const POINT_COLOR: Record<PointKind, string> = {
  ...KIND_COLOR,
  mixed: "#6b5a8e",
  empty: "#b3b8ae",
};

export function pointKindLabel(kind: PointKind): string {
  switch (kind) {
    case "coffee":
      return "☕ кофе";
    case "snack":
      return "🥤 снеки и напитки";
    case "mixed":
      return "кофе и снеки";
    case "empty":
      return "сейчас автоматов нет";
    default:
      return "тип не указан";
  }
}
