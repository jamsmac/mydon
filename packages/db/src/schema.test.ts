import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Table, is } from "drizzle-orm";
import { DEFAULT_MACHINE_STATUS, MACHINE_KINDS, MACHINE_STATUSES } from "@mydon/shared";
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
    assert.deepEqual(
      missing,
      [],
      `таблицы экспортированы, но не внесены в schema: ${missing.join(", ")}`,
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

  it("вендинг: слот хранит ВМЕСТИМОСТЬ и остаток — основу расчёта дефицита", () => {
    const slot = Object.keys(schema.machineSlot as unknown as Record<string, unknown>);
    // Ради вместимости и заводилась таблица: machine_stock её не хранит.
    assert.ok(slot.includes("capacity"), "вместимость слота — без неё дефицит не посчитать");
    assert.ok(slot.includes("quantity"), "остаток слота");
    assert.ok(
      slot.includes("machineSerial") && slot.includes("coilId"),
      "ключ слота: автомат + пружина",
    );
    const prod = Object.keys(schema.vendingProduct as unknown as Record<string, unknown>);
    assert.ok(
      prod.includes("purchasePrice") && prod.includes("packSize"),
      "прайс и кратность — в базе, не в коде",
    );
  });

  it("у ключевых таблиц есть обязательные поля", () => {
    const cols = (t: unknown) => Object.keys(t as Record<string, unknown>);

    assert.ok(
      cols(schema.entity).includes("externalRef"),
      "entity.externalRef — ключ сведения справочника",
    );
    assert.ok(cols(schema.entity).includes("attrs"));
    assert.ok(cols(schema.approval).includes("tier"));
    assert.ok(cols(schema.approval).includes("decision"));
    assert.ok(cols(schema.moneyFlow).includes("currency"), "без валюты суммы складывать нельзя");
    assert.ok(cols(schema.moneyFlow).includes("direction"));
    assert.ok(
      cols(schema.auditLog).includes("actorKind"),
      "журнал должен различать человека и агента",
    );
    assert.ok(cols(schema.auditLog).includes("before"));
    assert.ok(cols(schema.auditLog).includes("after"));
    assert.ok(
      cols(schema.rawSnapshot).includes("completedAt"),
      "незавершённая пакетная выгрузка не должна попадать в отчёты",
    );
  });
});

describe("Перечисления схемы и словари @mydon/shared — один список, а не два", () => {
  /**
   * Значения enum'ов дублируются руками: в `schema.ts` как pgEnum, в
   * `@mydon/shared` как массив `as const`. Ничто их не связывает — можно
   * добавить состояние в словарь, забыть про миграцию, и Postgres отвергнет
   * запись значением, которое TypeScript считает законным.
   *
   * Тест — единственный шов между этими двумя списками.
   */
  it("вид автомата: machineKindEnum ↔ MACHINE_KINDS", () => {
    assert.deepEqual([...mod.machineKindEnum.enumValues].sort(), [...MACHINE_KINDS].sort());
  });

  it("состояние автомата: machineStatusEnum ↔ MACHINE_STATUSES", () => {
    assert.deepEqual([...mod.machineStatusEnum.enumValues].sort(), [...MACHINE_STATUSES].sort());
  });

  it("умолчание состояния существует в перечислении", () => {
    // Умолчание прописано и в колонке (DEFAULT 'in_service'), и в коде.
    assert.ok(
      (mod.machineStatusEnum.enumValues as readonly string[]).includes(DEFAULT_MACHINE_STATUS),
    );
  });
});
