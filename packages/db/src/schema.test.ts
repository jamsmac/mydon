import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Table, is } from "drizzle-orm";
import * as mod from "./schema";
import { schema } from "./schema";

/**
 * Схема Core — договор с ТЗ §7. Тест ловит случайное удаление или
 * переименование таблицы: без него правка schema.ts не проверяется ничем.
 */
describe("Схема MYDON Core (ТЗ §7)", () => {
  const REQUIRED = [
    "org",
    "project",
    "entity",
    "person",
    "task",
    "approval",
    "event",
    "document",
    "moneyFlow",
    "note",
    "auditLog",
  ];

  // Служебные таблицы вне §7. Держим отдельным списком, чтобы состав реестра
  // оставался под охраной, а новые служебные добавлялись осознанно.
  // agent — настройки агентов; task_comment — переписка и отчёты по задачам.
  const SERVICE = ["agent", "taskComment"];

  it("содержит все 11 таблиц реестра", () => {
    for (const name of REQUIRED) {
      assert.ok(name in schema, `в схеме нет таблицы ${name}`);
    }
    assert.equal(REQUIRED.length, 11, "состав реестра §7 не должен меняться молча");
  });

  it("служебные таблицы объявлены явно", () => {
    for (const name of SERVICE) {
      assert.ok(name in schema, `в схеме нет служебной таблицы ${name}`);
    }
  });

  /**
   * Раньше здесь стоял строгий счётчик таблиц, но операционные (движения,
   * продажи, сырьё), сырой слой и вложения экспортировались, НЕ попадая в объект
   * `schema` — а значит были невидимы для `db.query.*` и интроспекции. Считать
   * руками — та же ловушка. Проверяем рефлексией: каждая экспортированная
   * drizzle-таблица обязана быть зарегистрирована в `schema`.
   */
  it("каждая экспортированная таблица зарегистрирована в schema", () => {
    const registered = new Set<unknown>(Object.values(schema));
    const missing = Object.entries(mod)
      .filter(([, v]) => is(v, Table))
      .filter(([, v]) => !registered.has(v))
      .map(([name]) => name);
    assert.deepEqual(missing, [], `таблицы экспортированы, но не внесены в schema: ${missing.join(", ")}`);
  });

  it("настройки агентов переживают обновление системы", () => {
    const cols = Object.keys(schema.agent as unknown as Record<string, unknown>);
    // Раньше настройки жили в файлах образа и слетали при пересборке.
    assert.ok(cols.includes("schedule"), "расписания должны храниться в базе");
    assert.ok(cols.includes("autonomyDefault"), "уровень самостоятельности — настройка владельца");
    assert.ok(cols.includes("nonGoals"), "границы агента: чего он НЕ делает");
    assert.ok(cols.includes("archivedAt"), "удаление — архивация, история должна оставаться");
  });

  it("у ключевых таблиц есть обязательные поля", () => {
    const cols = (t: unknown) => Object.keys(t as Record<string, unknown>);

    assert.ok(cols(schema.entity).includes("externalRef"), "entity.externalRef — ключ сведения справочника");
    assert.ok(cols(schema.entity).includes("attrs"));
    assert.ok(cols(schema.approval).includes("tier"));
    assert.ok(cols(schema.approval).includes("decision"));
    assert.ok(cols(schema.moneyFlow).includes("currency"), "без валюты суммы складывать нельзя");
    assert.ok(cols(schema.moneyFlow).includes("direction"));
    assert.ok(cols(schema.auditLog).includes("actorKind"), "журнал должен различать человека и агента");
    assert.ok(cols(schema.auditLog).includes("before"));
    assert.ok(cols(schema.auditLog).includes("after"));
  });
});
