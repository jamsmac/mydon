import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

  it("содержит все 11 таблиц реестра", () => {
    for (const name of REQUIRED) {
      assert.ok(name in schema, `в схеме нет таблицы ${name}`);
    }
    assert.equal(Object.keys(schema).length, REQUIRED.length);
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
