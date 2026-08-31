import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { entity, person, task, vendingRefill } from "@mydon/db";
import { ActionsService, personIdOf, type ActionRow } from "./actions.service";

/** Рендер WHERE-узла в SQL — так же, как в tasks.test.ts / entities.test.ts. */
const renderSql = (node: unknown): string => new PgDialect().sqlToQuery(node as never).sql;

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

describe("Лента действий: приёмка работы (П7)", () => {
  it("task_confirmed существует рядом с task_done", () => {
    const kinds: ActionRow["kind"][] = ["task_done", "task_confirmed"];
    assert.equal(new Set(kinds).size, 2);
  });

  it("автор приёмки разбирается тем же personIdOf", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(personIdOf(`person:${id}`), id);
    assert.equal(personIdOf("owner"), null);
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

/**
 * Стаб, ЗАХВАТЫВАЮЩИЙ предикат WHERE task/entity-подзапросов ленты. Гард полноты
 * (personal-read-surfaces.guard.test.ts) лишь проверяет наличие подстроки
 * `excludePersonal` в файле; он НЕ ловит регресс, снявший taskGate/entityGate из
 * конкретного `and(...)`. Здесь рендерим сам предикат: при флаге ВКЛ каждый
 * из четырёх owner-facing подзапросов (закрытые/принятые/заведённые задачи и
 * заведённые карточки) обязан нести гейт personal, при выключенном — не нести.
 * `person` читается без where (лента людей) — стаб отдаёт его thenable-пустым.
 */
function captureActionsDb() {
  const captured = { task: [] as unknown[], entity: [] as unknown[] };
  const node = (bucket?: unknown[]) => {
    const p = Promise.resolve([] as unknown[]);
    return {
      then: p.then.bind(p),
      where: async (c: unknown) => {
        bucket?.push(c);
        return [];
      },
      innerJoin: () => ({ where: async () => [] }),
    };
  };
  const db = {
    select: () => ({
      from: (t: unknown) =>
        t === task ? node(captured.task) : t === entity ? node(captured.entity) : node(),
    }),
  } as never;
  return { captured, db };
}

describe("Лента действий: гейт личного контура вшит в SQL, а не только в имя параметра (R-P5-7a)", () => {
  it("флаг выключен (дефолт) — WHERE задач/карточек не упоминает personal (лента как сегодня)", async () => {
    const { captured, db } = captureActionsDb();
    await new ActionsService(db).actions("2026-08-26", "2026-08-26");
    assert.equal(captured.task.length, 3, "три task-подзапроса: закрытые, принятые, заведённые");
    assert.equal(captured.entity.length, 1, "один entity-подзапрос: заведённые карточки");
    for (const c of [...captured.task, ...captured.entity])
      assert.doesNotMatch(renderSql(c), /personal/);
  });

  it("excludePersonal=true — каждый task/entity-подзапрос вырезает personal", async () => {
    const { captured, db } = captureActionsDb();
    await new ActionsService(db).actions("2026-08-26", "2026-08-26", undefined, true);
    assert.equal(captured.task.length, 3);
    assert.equal(captured.entity.length, 1);
    for (const c of captured.task)
      assert.match(renderSql(c), /personal/, "task-подзапрос ленты потерял гейт personal");
    for (const c of captured.entity)
      assert.match(renderSql(c), /personal/, "entity-подзапрос ленты потерял гейт personal");
  });
});
