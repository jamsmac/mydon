import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { Table, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DEFAULT_MACHINE_STATUS, MACHINE_KINDS, MACHINE_STATUSES } from "@mydon/shared";
import * as mod from "./schema";
import { schema, TASK_SOURCE_DAY_PREDICATE } from "./schema";

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
    assert.ok(prod.includes("salePrice"), "эталон витрины — в базе: без него price_gap не с чем сравнивать (R-P5b-6)");

    const count = Object.keys(schema.vendingStockCount as unknown as Record<string, unknown>);
    // История склада — предмет П8a: `vending_stock` перезаписной, и до этой
    // таблицы «сколько было в июне» не отвечало ничто.
    assert.ok(count.includes("countedAt") && count.includes("dt"), "момент пересчёта и его сутки");
    assert.ok(count.includes("source") && count.includes("extId"), "источник строки и id донора — ключ идемпотентности импорта");
    assert.ok(count.includes("personId"), "кто считал: строка без человека законна, но поле обязано быть");
  });

  it("СТРАЖ: у целей ретенции есть индекс ПО КОЛОНКЕ ВРЕМЕНИ (0070/0071)", () => {
    // Ретенция чистит пачками `where <время> < cutoff order by <время> limit N`.
    // У снимков составной индекс начинается с `machine_serial` и под это условие
    // не годится (seq scan + сортировка на каждую пачку), у журнала прогонов
    // индекса не было вовсе. Снять индекс — значит вернуть полный скан на
    // растущей таблице, и заметить это будет нечем: чистка идёт раз в неделю
    // ночью.
    const конфиг = (t: unknown): unknown[] => {
      const извлечь = (t as Record<symbol, unknown>)[Symbol.for("drizzle:ExtraConfigBuilder")];
      const колонки = (t as Record<symbol, unknown>)[Symbol.for("drizzle:ExtraConfigColumns")];
      return typeof извлечь === "function" ? ((извлечь as (c: unknown) => unknown[])(колонки) ?? []) : [];
    };
    const имена = (t: unknown): string[] =>
      конфиг(t).map((i) => String((i as { config?: { name?: string } }).config?.name ?? ""));

    for (const [таблица, индекс] of [
      [schema.slotSnapshot, "slot_snapshot_captured_idx"],
      [schema.productSale, "product_sale_captured_idx"],
      [schema.machineSale, "machine_sale_captured_idx"],
      [schema.vendingSyncRun, "vending_sync_run_started_idx"],
      // Пятая цель (R-H-8): у истории склада составной индекс начинается с
      // `product_name`, и под `where dt < cutoff order by dt limit N` он так же
      // не годится, как составные индексы снимков.
      [schema.vendingStockCount, "vending_stock_count_dt_idx"],
    ] as const) {
      assert.ok(имена(таблица).includes(индекс), `нет индекса ${индекс} — ретенция уйдёт в полный скан`);
    }
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

  /** Приёмка — отметка поверх done, а не пятое состояние PostgreSQL. */
  it("СТРАЖ: task_status остаётся четырёхзначным (R-P7-6)", () => {
    assert.deepEqual(
      [...mod.taskStatusEnum.enumValues].sort(),
      ["cancelled", "done", "in_progress", "todo"],
    );
  });

  it("у task есть отметки приёмки и доставки назначения", () => {
    const columns = Object.keys(schema.task);
    for (const column of ["confirmedAt", "confirmedBy", "assignNotifiedAt"]) {
      assert.ok(columns.includes(column), `в task нет ${column} — миграция и схема разошлись`);
    }
  });
});

describe("Предикат частичного индекса task_source_key (R-G-2)", () => {
  it("константа дословно совпадает с миграцией 0040 — иначе вставка снова получит 42P10", () => {
    // Индекс уже в проде, миграция — единственная запись о том, КАК он выглядит
    // в базе. Разойдясь с ней, константа не сломает ни сборку, ни тесты
    // схемы: сломается вставка, и ровно тем же молчаливым 500.
    const { sql: предикат } = new PgDialect().sqlToQuery(TASK_SOURCE_DAY_PREDICATE);
    const миграция = readFileSync(
      path.resolve(__dirname, "../drizzle/0040_task_entity_photo_stage.sql"),
      "utf8",
    );
    assert.ok(
      миграция.includes(`WHERE ${предикат}`),
      `предикат «${предикат}» не найден в 0040 — схема и вставка разошлись`,
    );
  });
});
