import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { person, vendingRefill } from "@mydon/db";
import { ActionsService, personIdOf } from "./actions.service";

describe("Лента действий: разбор автора", () => {
  it("person:/staff: дают uuid, всё прочее — null", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(personIdOf(`person:${id}`), id);
    assert.equal(personIdOf(`staff:${id}`), id);
    assert.equal(personIdOf("owner"), null, "действия владельца — не полевая лента");
    assert.equal(personIdOf("agent:vendhub"), null);
    assert.equal(personIdOf("import:telegram"), null);
    assert.equal(personIdOf(null), null);
    assert.equal(personIdOf("person:не-uuid"), null);
  });
});

/**
 * Стаб под `ActionsService.actions()`: 12 независимых чтений в `Promise.all`.
 * `person`/`vendingRefill` различаются по ссылке на таблицу, все прочие
 * источники стаб отдаёт пустыми — тестам ниже нужны только заправки снека.
 */
function actionsDb(opts: { people?: { id: string; name: string }[]; snackRefills?: Record<string, unknown>[] }) {
  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows);
    return { where: async () => rows, innerJoin: () => ({ where: async () => rows }), then: p.then.bind(p) };
  };
  return {
    select: () => ({
      from: (t: unknown) => {
        if (t === person) return chain(opts.people ?? []);
        if (t === vendingRefill) return chain(opts.snackRefills ?? []);
        return chain([]);
      },
    }),
  } as never;
}

describe("Лента действий: сторно снек-заправки подписывается отдельно (Task 7, R-P6-13)", () => {
  it("сторно-заправка подписана «Отмена заправки», а не заправкой на минус", async () => {
    const отменил = "22222222-2222-4222-8222-222222222222";
    const db = actionsDb({
      people: [{ id: отменил, name: "Технолог" }],
      snackRefills: [
        {
          at: new Date("2026-08-26T10:00:00+05:00"),
          pid: отменил,
          by: `person:${отменил}`,
          product: "Snickers 50gr",
          qty: -6,
          serial: "2508160376",
          source: "storno",
        },
      ],
    });
    const rows = await new ActionsService(db).actions("2026-08-26", "2026-08-26");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "vending_refill_cancelled");
    assert.match(rows[0]!.label, /Отмена заправки/);
    assert.ok(!rows[0]!.label.includes("×-6"), "минус не должен доехать до витрины как «×-6»");
    assert.match(rows[0]!.label, /×6\b/, "abs(qty) — количество, а не знак отмены");
  });

  it("автор сторно-строки — тот, кто отменил (personId сторно-строки), а не автор оригинала", async () => {
    const автор = "11111111-1111-4111-8111-111111111111";
    const отменил = "22222222-2222-4222-8222-222222222222";
    const db = actionsDb({
      people: [
        { id: автор, name: "Автор" },
        { id: отменил, name: "Отменил" },
      ],
      snackRefills: [
        {
          at: new Date("2026-08-26T10:00:00+05:00"),
          // RecordCancelService пишет personId=actor.personId в сторно-строку
          // (Task 7) — та, кто отменил, а не автор оригинальной заправки.
          pid: отменил,
          by: `person:${отменил}`,
          product: "Snickers 50gr",
          qty: -6,
          serial: "2508160376",
          source: "storno",
        },
      ],
    });
    const rows = await new ActionsService(db).actions("2026-08-26", "2026-08-26");
    assert.equal(rows[0]!.personId, отменил);
    assert.equal(rows[0]!.personName, "Отменил");
  });

  it("обычная заправка (source ≠ storno) остаётся kind vending_refill, как раньше", async () => {
    const автор = "11111111-1111-4111-8111-111111111111";
    const db = actionsDb({
      people: [{ id: автор, name: "Автор" }],
      snackRefills: [
        {
          at: new Date("2026-08-26T10:00:00+05:00"),
          pid: автор,
          by: `person:${автор}`,
          product: "Snickers 50gr",
          qty: 6,
          serial: "2508160376",
          source: "bot",
        },
      ],
    });
    const rows = await new ActionsService(db).actions("2026-08-26", "2026-08-26");
    assert.equal(rows[0]!.kind, "vending_refill");
    assert.match(rows[0]!.label, /^🍫 Заправка/);
  });
});
