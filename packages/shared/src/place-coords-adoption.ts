import { coordFromAttrs, type Coord } from "./geo";
import { isPlaceType, PLACE_ATTR } from "./place-kinds";
import { isMergedPlace } from "./place-merge";

/**
 * Разовый перенос координат с автоматов на их места (волна 2, М-4).
 *
 * До волны 2 координаты вводили у АВТОМАТА. Теперь их носит место — и у части
 * мест координат нет, хотя у автомата, который там стоит, они есть (на проде
 * 11.09: мест 33, с координатами 25; у автомата Olma Администрация координаты
 * есть, у самого места — нет).
 *
 * Правила — «не угадывать» (М-10):
 * - берём только ТЕКУЩЕЕ место автомата (открытый период): где стоял раньше —
 *   не про это место сейчас;
 * - у места координаты уже есть — не трогаем: координаты места главнее;
 * - на месте автоматы с РАЗНЫМИ координатами — конфликт, не выбираем;
 * - координаты автомата вне Узбекистана — конфликт («перепутаны местами»),
 *   а не перенос ошибки на место;
 * - координаты СТАРШЕ приезда автомата сюда — не переносим: их вводили, пока
 *   он стоял на прежней точке. Так на проде 11.09 оба автомата «Основного
 *   склада» приехали 09.09 с координатами от 19.08 — это координаты точек
 *   продаж, а не склада. Дата координат — последняя правка карточки
 *   (`geo_point.updated_at`): «правка раньше приезда» ДОКАЗЫВАЕТ, что
 *   координаты старше периода; обратное не доказывает ничего, но и
 *   опровергнуть нечем — такой случай переносим.
 *
 * Перенесённое помечается источником (R-H-8): это не слово человека о месте,
 * а след ввода у автомата.
 */

export interface AdoptionPlace {
  id: string;
  name: string;
  type: string;
  attrs: Record<string, unknown> | null;
  /** Типизированная точка места, если есть. */
  hasGeo: boolean;
}

export interface AdoptionMachine {
  id: string;
  name: string;
  attrs: Record<string, unknown> | null;
  geo: Coord | null;
  /** День последней записи координат автомата (YYYY-MM-DD), если известен. */
  coordsSetOn?: string | null;
}

export interface Adoption {
  placeId: string;
  placeName: string;
  lat: number;
  lng: number;
  /** Адрес автомата — только если у места адреса нет. */
  address: string | null;
  fromMachineId: string;
  fromMachineName: string;
}

export interface AdoptionConflict {
  placeId: string;
  placeName: string;
  reason: string;
  machines: { id: string; name: string; lat: number; lng: number }[];
}

export interface AdoptionPlan {
  adopt: Adoption[];
  conflicts: AdoptionConflict[];
  /** Места без координат, где сейчас нет автомата с координатами, — переносить нечего. */
  nothingToAdopt: { id: string; name: string }[];
}

/** Рамка Узбекистана — ловит перепутанные широту и долготу. */
function inUzbekistan(c: Coord): boolean {
  return c.lat >= 30 && c.lat <= 55 && c.lng >= 55 && c.lng <= 80;
}

/** Один и тот же пункт на земле: 4 знака ≈ 11 м — дальше это уже другое место. */
function sameSpot(a: Coord, b: Coord): boolean {
  return Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lng - b.lng) < 1e-4;
}

function machineCoord(m: AdoptionMachine): Coord | null {
  return m.geo ?? coordFromAttrs(m.attrs).coord;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function planCoordAdoption(input: {
  places: AdoptionPlace[];
  machines: AdoptionMachine[];
  /** Открытые периоды: какой автомат стоит на каком месте сейчас и с какого дня (null — неизвестно). */
  open: { placeId: string; machineId: string; since?: string | null }[];
}): AdoptionPlan {
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  const onPlace = new Map<string, { m: AdoptionMachine; since: string | null }[]>();
  for (const o of input.open) {
    const m = machines.get(o.machineId);
    if (m) onPlace.set(o.placeId, [...(onPlace.get(o.placeId) ?? []), { m, since: o.since ?? null }]);
  }

  const plan: AdoptionPlan = { adopt: [], conflicts: [], nothingToAdopt: [] };
  for (const place of input.places) {
    if (!isPlaceType(place.type) || isMergedPlace(place.attrs)) continue;
    if (place.hasGeo || coordFromAttrs(place.attrs).coord !== null) continue;

    const allWithCoords = (onPlace.get(place.id) ?? [])
      .map(({ m, since }) => ({ m, since, c: machineCoord(m) }))
      .filter((x): x is { m: AdoptionMachine; since: string | null; c: Coord } => x.c !== null);
    if (allWithCoords.length === 0) {
      plan.nothingToAdopt.push({ id: place.id, name: place.name });
      continue;
    }
    const listed = allWithCoords.map(({ m, c }) => ({ id: m.id, name: m.name, lat: c.lat, lng: c.lng }));
    const olderThanArrival = (x: { m: AdoptionMachine; since: string | null }) =>
      x.m.coordsSetOn != null && x.since !== null && x.m.coordsSetOn < x.since;
    const withCoords = allWithCoords.filter((x) => !olderThanArrival(x));
    if (withCoords.length === 0) {
      const x = allWithCoords[0]!;
      plan.conflicts.push({
        placeId: place.id,
        placeName: place.name,
        reason: `координаты автомата старше его приезда сюда (записаны ${ruDay(x.m.coordsSetOn!)}, стоит здесь с ${ruDay(x.since!)}) — вероятно, от прежней точки`,
        machines: listed,
      });
      continue;
    }

    const outside = withCoords.filter(({ c }) => !inUzbekistan(c));
    if (outside.length > 0) {
      plan.conflicts.push({
        placeId: place.id,
        placeName: place.name,
        reason: "у автомата координаты вне Узбекистана — похоже, широта и долгота перепутаны",
        machines: listed,
      });
      continue;
    }
    const first = withCoords[0]!;
    if (!withCoords.every(({ c }) => sameSpot(c, first.c))) {
      plan.conflicts.push({
        placeId: place.id,
        placeName: place.name,
        reason: "у автоматов на этом месте разные координаты — какие верны, решает человек",
        machines: listed,
      });
      continue;
    }
    plan.adopt.push({
      placeId: place.id,
      placeName: place.name,
      lat: first.c.lat,
      lng: first.c.lng,
      address: nonEmpty(place.attrs?.[PLACE_ATTR.address]) === null ? nonEmpty(first.m.attrs?.[PLACE_ATTR.address]) : null,
      fromMachineId: first.m.id,
      fromMachineName: first.m.name,
    });
  }
  return plan;
}

function ruDay(dayIso: string): string {
  const [y, m, d] = dayIso.split("-");
  return `${d}.${m}.${y}`;
}

/** Текст пометки у перенесённых координат: откуда и когда. */
export function adoptedCoordsSource(machineName: string, dayIso: string): string {
  return `перенесено с автомата «${machineName}» ${ruDay(dayIso)}`;
}
