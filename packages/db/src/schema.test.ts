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

  // Служебные таблицы вне §7. Держим отдельным списком, чтобы состав реестра
  // оставался под охраной, а новые служебные добавлялись осознанно.
  const SERVICE = ["agent"];

  it("содержит все 11 таблиц реестра", () => {
    for (const name of REQUIRED) {
      assert.ok(name in schema, `в схеме нет таблицы ${name}`);
    }
    assert.equal(REQUIRED.length, 11, "состав реестра §7 не должен меняться молча");
  });

  it("служебные таблицы объявлены явно, лишних в схеме нет", () => {
    for (const name of SERVICE) {
      assert.ok(name in schema, `в схеме нет служебной таблицы ${name}`);
    }
    assert.equal(
      Object.keys(schema).length,
      REQUIRED.length + SERVICE.length,
      "появилась таблица, не внесённая ни в реестр §7, ни в список служебных",
    );
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
