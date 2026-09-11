import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adoptedCoordsSource, planCoordAdoption, type AdoptionMachine, type AdoptionPlace } from "./place-coords-adoption";

const place = (id: string, over: Partial<AdoptionPlace> = {}): AdoptionPlace => ({
  id,
  name: id,
  type: "location",
  attrs: {},
  hasGeo: false,
  ...over,
});
const machine = (id: string, lat: number | null, lng: number | null, attrs: Record<string, unknown> = {}): AdoptionMachine => ({
  id,
  name: `автомат ${id}`,
  attrs,
  geo: lat !== null && lng !== null ? { lat, lng } : null,
});

describe("перенос координат с автомата на его место (М-4)", () => {
  it("на месте без координат стоит автомат с координатами — переносим", () => {
    const plan = planCoordAdoption({
      places: [place("olma-admin")],
      machines: [machine("m1", 41.3312, 69.2801)],
      open: [{ placeId: "olma-admin", machineId: "m1" }],
    });
    assert.deepEqual(plan.adopt.map((a) => [a.placeId, a.lat, a.lng, a.fromMachineId]), [["olma-admin", 41.3312, 69.2801, "m1"]]);
    assert.deepEqual(plan.conflicts, []);
  });

  it("у места координаты уже есть — не трогаем, даже если у автомата другие", () => {
    const plan = planCoordAdoption({
      places: [place("a", { hasGeo: true }), place("b", { attrs: { широта: "41.30", долгота: "69.20" } })],
      machines: [machine("m1", 41.4, 69.4), machine("m2", 41.5, 69.5)],
      open: [
        { placeId: "a", machineId: "m1" },
        { placeId: "b", machineId: "m2" },
      ],
    });
    assert.deepEqual(plan.adopt, []);
  });

  it("берём только текущее место: автомат, который отсюда уехал, координат не даёт", () => {
    const plan = planCoordAdoption({
      places: [place("old"), place("new")],
      machines: [machine("m1", 41.33, 69.28)],
      open: [{ placeId: "new", machineId: "m1" }],
    });
    assert.deepEqual(plan.adopt.map((a) => a.placeId), ["new"]);
    assert.deepEqual(plan.nothingToAdopt.map((p) => p.id), ["old"]);
  });

  it("два автомата с разными координатами — конфликт, не выбираем", () => {
    const plan = planCoordAdoption({
      places: [place("kiut")],
      machines: [machine("m1", 41.3401, 69.3301), machine("m2", 41.3450, 69.3390)],
      open: [
        { placeId: "kiut", machineId: "m1" },
        { placeId: "kiut", machineId: "m2" },
      ],
    });
    assert.deepEqual(plan.adopt, []);
    assert.equal(plan.conflicts.length, 1);
    assert.match(plan.conflicts[0]!.reason, /разные координаты/);
  });

  it("два автомата в одной точке (в пределах ~11 м) — это одно место, переносим", () => {
    const plan = planCoordAdoption({
      places: [place("sklad")],
      machines: [machine("m1", 41.300001, 69.250001), machine("m2", 41.300002, 69.250003)],
      open: [
        { placeId: "sklad", machineId: "m1" },
        { placeId: "sklad", machineId: "m2" },
      ],
    });
    assert.equal(plan.adopt.length, 1);
  });

  it("перепутанные широта и долгота — конфликт с этим словом, а не перенос ошибки", () => {
    const plan = planCoordAdoption({
      places: [place("p")],
      machines: [machine("m1", 69.28, 41.33)],
      open: [{ placeId: "p", machineId: "m1" }],
    });
    assert.match(plan.conflicts[0]!.reason, /перепутаны/);
  });

  it("координаты автомата из attrs, пока geo нет; адрес автомата — только если у места адреса нет", () => {
    const plan = planCoordAdoption({
      places: [place("p1"), place("p2", { attrs: { адрес: "ул. Олмачи" } })],
      machines: [
        machine("m1", null, null, { широта: "41.31", долгота: "69.24", адрес: "Олмазар, 1 этаж" }),
        machine("m2", 41.32, 69.25, { адрес: "другой адрес" }),
      ],
      open: [
        { placeId: "p1", machineId: "m1" },
        { placeId: "p2", machineId: "m2" },
      ],
    });
    assert.deepEqual(
      plan.adopt.map((a) => [a.placeId, a.lat, a.address]),
      [
        ["p1", 41.31, "Олмазар, 1 этаж"],
        ["p2", 41.32, null],
      ],
    );
  });

  it("слитая карточка в перенос не попадает — её история уже на целевой", () => {
    const plan = planCoordAdoption({
      places: [place("dup", { attrs: { "слита в": "real" } })],
      machines: [machine("m1", 41.3, 69.2)],
      open: [{ placeId: "dup", machineId: "m1" }],
    });
    assert.deepEqual(plan, { adopt: [], conflicts: [], nothingToAdopt: [] });
  });

  it("не места (контрагент) в перенос не попадают", () => {
    const plan = planCoordAdoption({
      places: [place("c", { type: "contractor" })],
      machines: [machine("m1", 41.3, 69.2)],
      open: [{ placeId: "c", machineId: "m1" }],
    });
    assert.deepEqual(plan, { adopt: [], conflicts: [], nothingToAdopt: [] });
  });

  it("координаты старше приезда — от прежней точки: не переносим, называем даты (склад 11.09)", () => {
    const plan = planCoordAdoption({
      places: [place("sklad", { type: "warehouse" })],
      machines: [{ ...machine("m1", 41.27251, 69.34989), coordsSetOn: "2026-08-19" }],
      open: [{ placeId: "sklad", machineId: "m1", since: "2026-09-09" }],
    });
    assert.deepEqual(plan.adopt, []);
    assert.match(plan.conflicts[0]!.reason, /старше его приезда сюда \(записаны 19\.08\.2026, стоит здесь с 09\.09\.2026\)/);
  });

  it("координаты записаны в день приезда или позже — переносим; дата приезда неизвестна — тоже", () => {
    const plan = planCoordAdoption({
      places: [place("ofb"), place("olma")],
      machines: [
        { ...machine("m1", 41.2827, 69.33678), coordsSetOn: "2026-08-19" },
        { ...machine("m2", 41.18234, 69.12856), coordsSetOn: "2026-09-09" },
      ],
      open: [
        { placeId: "ofb", machineId: "m1", since: "2026-08-19" },
        { placeId: "olma", machineId: "m2", since: null },
      ],
    });
    assert.deepEqual(plan.adopt.map((a) => a.placeId), ["ofb", "olma"]);
  });

  it("свежий и устаревший автомат на одном месте — решает свежий", () => {
    const plan = planCoordAdoption({
      places: [place("p")],
      machines: [
        { ...machine("old", 41.1, 69.1), coordsSetOn: "2026-08-01" },
        { ...machine("new", 41.33, 69.28), coordsSetOn: "2026-09-05" },
      ],
      open: [
        { placeId: "p", machineId: "old", since: "2026-09-01" },
        { placeId: "p", machineId: "new", since: "2026-09-01" },
      ],
    });
    assert.deepEqual(plan.adopt.map((a) => [a.fromMachineId, a.lat]), [["new", 41.33]]);
  });

  it("пометка источника называет автомат и день по-русски", () => {
    assert.equal(adoptedCoordsSource("Olma Администрация", "2026-09-11"), "перенесено с автомата «Olma Администрация» 11.09.2026");
  });
});
