import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { Table, is } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { DEFAULT_MACHINE_STATUS, MACHINE_KINDS, MACHINE_STATUSES } from "@mydon/shared";
import * as mod from "./schema";
import { collection, schema, TASK_SOURCE_DAY_PREDICATE } from "./schema";

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
  // agent — настройки агентов; task_comment — переписка и отчёты по задачам;
  // llm_* — версионный прайс и единый финансовый журнал LLM;
  // taskAgentExecution/outboxDelivery — durable outcome и его доставки;
  // agentTaskLlm* — durable provider dispatch/result task-mode Agents.
  const SERVICE = [
    "agent",
    "taskComment",
    "llmModelPrice",
    "llmSpend",
    "taskAgentExecution",
    "outboxDelivery",
    "agentTaskLlmJob",
    "agentTaskLlmAuthorization",
    "agentTaskLlmResult",
  ];

  // Извлечение состава индексов таблицы через внутренний символ drizzle —
  // единственный способ увидеть частичный/составной индекс без БД (интроспекция
  // «на бумаге»). Поднято на уровень describe: изначально жило внутри одного
  // теста (стр. 101), третий потребитель (сторно-индексы) заставил вынести.
  const конфиг = (t: unknown): unknown[] => {
    const извлечь = (t as Record<symbol, unknown>)[Symbol.for("drizzle:ExtraConfigBuilder")];
    const колонки = (t as Record<symbol, unknown>)[Symbol.for("drizzle:ExtraConfigColumns")];
    return typeof извлечь === "function"
      ? ((извлечь as (c: unknown) => unknown[])(колонки) ?? [])
      : [];
  };
  const имена = (t: unknown): string[] =>
    конфиг(t).map((i) => String((i as { config?: { name?: string } }).config?.name ?? ""));

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

  it("LLM-ledger хранит idempotency, price snapshot и USD с точностью 1e-9", () => {
    const spend = Object.keys(schema.llmSpend);
    for (const column of [
      "requestKey",
      "requestHash",
      "settlementHash",
      "priceSnapshot",
      "agentId",
      "agentName",
      "reservedAt",
      "settledAt",
      "failedAt",
      "releasedAt",
      "deniedAt",
    ]) {
      assert.ok(spend.includes(column), `llm_spend не хранит ${column}`);
    }
    assert.deepEqual(mod.llmSpendStatusEnum.enumValues, [
      "reserved",
      "settled",
      "failed",
      "released",
      "denied",
    ]);
    for (const column of [
      schema.llmSpend.reservedUsd,
      schema.llmSpend.actualUsd,
      schema.llmModelPrice.inputUsdPerMtok,
      schema.llmModelPrice.outputUsdPerMtok,
      schema.llmModelPrice.cacheReadUsdPerMtok,
      schema.llmModelPrice.cacheWrite5mUsdPerMtok,
      schema.llmModelPrice.cacheWrite1hUsdPerMtok,
      schema.llmModelPrice.fixedRequestUsd,
      schema.llmModelPrice.reservationCeilingUsd,
      schema.llmModelPrice.codeExecutionUsdPerRequest,
    ]) {
      assert.ok(
        (column as { scale?: number }).scale! >= 9,
        `${column.name}: scale должен быть >= 9`,
      );
    }
    assert.ok(
      spend.includes("cacheCreationInputTokens"),
      "aggregate cache creation нужен для аудита",
    );
    assert.ok(spend.includes("cacheCreation5mInputTokens"), "нужен cache write 5m breakdown");
    assert.ok(spend.includes("cacheCreation1hInputTokens"), "нужен cache write 1h breakdown");
    assert.ok(
      имена(schema.llmSpend).includes("llm_spend_request_key_idx"),
      "requestKey обязан быть уникальным на уровне БД",
    );
    assert.ok(
      имена(schema.llmSpend).includes("llm_spend_provider_failed_at_idx"),
      "provider circuit по settlement-day требует индекс provider/failed_at",
    );
  });

  it("agent-task разделяет lease worker и устойчивую оплачиваемую попытку", () => {
    const columns = Object.keys(schema.task);
    assert.ok(columns.includes("agentRunId"), "lease должен иметь CAS runId");
    assert.ok(
      columns.includes("agentExecutionAttemptId"),
      "stale takeover не должен создавать новый LLM requestKey",
    );
    assert.ok(
      columns.includes("agentExecutionRetryAt"),
      "pre-provider budget denial должен ждать новых ташкентских суток",
    );
    assert.ok(
      columns.includes("agentExecutionBlockedAt"),
      "unknown/replay должен блокировать task",
    );
    assert.ok(
      columns.includes("agentExecutionBlockedReason"),
      "владелец должен видеть причину ручного retry",
    );
  });

  it("durable agent outcome и outbox имеют полный fencing-контракт", () => {
    assert.deepEqual(mod.taskAgentExecutionStatusEnum.enumValues, [
      "active",
      "ready",
      "committed",
      "abandoned",
    ]);
    assert.deepEqual(mod.outboxDeliveryStatusEnum.enumValues, [
      "pending",
      "dispatching",
      "sent",
      "skipped",
      "unknown",
      "dead",
    ]);

    const executionColumns = Object.keys(schema.taskAgentExecution);
    for (const column of [
      "taskId",
      "executionAttemptId",
      "schemaVersion",
      "taskInputHash",
      "workflowVersion",
      "executionPlan",
      "executionPlanHash",
      "startedAt",
      "checkpointKind",
      "checkpointPayload",
      "checkpointHash",
      "status",
      "outcomePayload",
      "outcomeHash",
      "approvalId",
      "committedAt",
      "abandonedAt",
      "abandonReason",
    ]) {
      assert.ok(executionColumns.includes(column), `task_agent_execution не хранит ${column}`);
    }
    for (const name of [
      "task_agent_execution_attempt_key",
      "task_agent_execution_task_idx",
      "task_agent_execution_status_idx",
    ]) {
      assert.ok(имена(schema.taskAgentExecution).includes(name), `нет индекса ${name}`);
    }
    const executionChecks = getTableConfig(schema.taskAgentExecution).checks.map((c) => c.name);
    for (const name of [
      "task_agent_execution_schema_version_positive",
      "task_agent_execution_workflow_version_positive",
      "task_agent_execution_plan_bounded",
      "task_agent_execution_plan_hash_format",
      "task_agent_execution_terminal_fields_consistent",
    ]) {
      assert.ok(executionChecks.includes(name), `нет CHECK ${name}`);
    }
    assert.equal(
      schema.taskAgentExecution.executionPlanHash.default,
      "a5dd3ce7993c63ad01d8a9a45922bc5f17d2c41c5f21a10671ec8c05c5ffc4aa",
      "rolling deploy: Core v2 должен вставить execution без нового поля",
    );

    const outboxColumns = Object.keys(schema.outboxDelivery);
    for (const column of [
      "key",
      "taskAgentExecutionId",
      "destination",
      "payload",
      "payloadHash",
      "status",
      "attempts",
      "leaseToken",
      "claimedAt",
      "completedAt",
      "providerRef",
      "lastError",
    ]) {
      assert.ok(outboxColumns.includes(column), `outbox_delivery не хранит ${column}`);
    }
    for (const name of [
      "outbox_delivery_key",
      "outbox_delivery_destination_status_created_idx",
      "outbox_delivery_execution_idx",
    ]) {
      assert.ok(имена(schema.outboxDelivery).includes(name), `нет индекса ${name}`);
    }
    assert.ok(
      getTableConfig(schema.outboxDelivery).checks.some(
        (c) => c.name === "outbox_delivery_attempts_nonnegative",
      ),
      "нет CHECK outbox_delivery_attempts_nonnegative",
    );

    for (const [table, indexName] of [
      [schema.approval, "approval_client_key"],
      [schema.event, "event_client_key"],
    ] as const) {
      const clientKey = Object.values(table).find(
        (column) => (column as { name?: string }).name === "client_key",
      ) as { notNull?: boolean } | undefined;
      assert.ok(clientKey, `${indexName}: нет nullable client_key`);
      assert.equal(clientKey.notNull, false, `${indexName}: client_key обязан быть nullable`);
      assert.ok(имена(table).includes(indexName), `${indexName}: нет UNIQUE-индекса`);
    }
  });

  it("durable task LLM job фиксирует dispatch, daily authorization и immutable result", () => {
    assert.deepEqual(mod.agentTaskLlmJobStatusEnum.enumValues, [
      "waiting_budget",
      "ready",
      "dispatching",
      "succeeded",
      "rejected",
      "unknown",
      "cancelled",
    ]);
    assert.deepEqual(mod.agentTaskLlmJobKindEnum.enumValues, ["chat", "embedding"]);
    assert.deepEqual(mod.agentTaskLlmAuthorizationDecisionEnum.enumValues, ["denied", "granted"]);
    assert.deepEqual(mod.agentTaskLlmResultKindEnum.enumValues, ["success", "provider_rejection"]);

    const jobColumns = Object.keys(schema.agentTaskLlmJob);
    for (const column of [
      "taskAgentExecutionId",
      "stepKey",
      "providerAttemptNo",
      "kind",
      "feature",
      "adapter",
      "adapterVersion",
      "endpointProfile",
      "provider",
      "model",
      "inputTokenCeiling",
      "outputTokenCeiling",
      "jobKey",
      "operationHash",
      "requestPayload",
      "spendId",
      "status",
      "dispatchCount",
      "dispatchToken",
      "dispatchRunId",
      "dispatchGrantedAt",
      "dispatchDeadlineAt",
      "unknownAt",
      "completedAt",
      "cancelledAt",
      "lastError",
    ]) {
      assert.ok(jobColumns.includes(column), `agent_task_llm_job не хранит ${column}`);
    }
    assert.equal(schema.agentTaskLlmJob.requestPayload.notNull, false);
    assert.equal(schema.agentTaskLlmJob.spendId.notNull, false);
    for (const name of [
      "agent_task_llm_job_job_key",
      "agent_task_llm_job_execution_step_attempt_key",
      "agent_task_llm_job_spend_key",
      "agent_task_llm_job_execution_idx",
      "agent_task_llm_job_status_idx",
      "agent_task_llm_job_status_deadline_idx",
    ]) {
      assert.ok(имена(schema.agentTaskLlmJob).includes(name), `нет индекса ${name}`);
    }
    const jobChecks = getTableConfig(schema.agentTaskLlmJob).checks.map((c) => c.name);
    for (const name of [
      "agent_task_llm_job_attempt_version_positive",
      "agent_task_llm_job_token_ceilings_nonnegative",
      "agent_task_llm_job_dispatch_count_range",
      "agent_task_llm_job_operation_hash_format",
      "agent_task_llm_job_request_payload_bounded",
      "agent_task_llm_job_state_fields_consistent",
    ]) {
      assert.ok(jobChecks.includes(name), `нет CHECK ${name}`);
    }

    const authorizationColumns = Object.keys(schema.agentTaskLlmAuthorization);
    for (const column of ["id", "jobId", "day", "spendId", "decision", "createdAt"]) {
      assert.ok(
        authorizationColumns.includes(column),
        `agent_task_llm_authorization не хранит ${column}`,
      );
    }
    for (const name of [
      "agent_task_llm_authorization_job_day_key",
      "agent_task_llm_authorization_spend_key",
      "agent_task_llm_authorization_job_granted_key",
      "agent_task_llm_authorization_day_decision_idx",
    ]) {
      assert.ok(имена(schema.agentTaskLlmAuthorization).includes(name), `нет индекса ${name}`);
    }

    const resultColumns = Object.keys(schema.agentTaskLlmResult);
    for (const column of ["jobId", "kind", "payload", "resultHash", "receivedAt"]) {
      assert.ok(resultColumns.includes(column), `agent_task_llm_result не хранит ${column}`);
    }
    const resultChecks = getTableConfig(schema.agentTaskLlmResult).checks.map((c) => c.name);
    assert.ok(resultChecks.includes("agent_task_llm_result_hash_format"));
    assert.ok(resultChecks.includes("agent_task_llm_result_payload_bounded"));
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
    assert.ok(
      prod.includes("salePrice"),
      "эталон витрины — в базе: без него price_gap не с чем сравнивать (R-P5b-6)",
    );

    const count = Object.keys(schema.vendingStockCount as unknown as Record<string, unknown>);
    // История склада — предмет П8a: `vending_stock` перезаписной, и до этой
    // таблицы «сколько было в июне» не отвечало ничто.
    assert.ok(count.includes("countedAt") && count.includes("dt"), "момент пересчёта и его сутки");
    assert.ok(
      count.includes("source") && count.includes("extId"),
      "источник строки и id донора — ключ идемпотентности импорта",
    );
    assert.ok(
      count.includes("personId"),
      "кто считал: строка без человека законна, но поле обязано быть",
    );
  });

  it("вендинг: у карточки прайса есть ФИСКАЛЬНЫЙ БЛОК из шести полей (П6, R-P6-5)", () => {
    const prod = Object.keys(schema.vendingProduct as unknown as Record<string, unknown>);
    for (const поле of ["ikpu", "mxik", "vatPct", "barcode", "packageCode", "marked"]) {
      assert.ok(prod.includes(поле), `нет фискального поля ${поле} — чек по карточке не собрать`);
    }
    // `vat_pct` и `package_code` НЕ nullable: пустой ставки не бывает (R-P6-8),
    // пустой единицы измерения — тоже. Проверяем через сам столбец, а не через
    // список имён: notNull() — это и есть отличие «0 %» от «не выясняли».
    const колонки = schema.vendingProduct as unknown as {
      vatPct: { notNull: boolean };
      packageCode: { notNull: boolean };
      ikpu: { notNull: boolean };
    };
    assert.equal(колонки.vatPct.notNull, true, "ставка НДС обязана иметь значение всегда");
    assert.equal(колонки.packageCode.notNull, true, "код упаковки обязан иметь значение всегда");
    assert.equal(
      колонки.ikpu.notNull,
      false,
      "ИКПУ, наоборот, обязан уметь быть пустым: «не выясняли» — это ответ",
    );
  });

  it("СТРАЖ: CHECK «qty» заливки живёт в SQL-миграции, а не в drizzle-схеме (R-P6-6)", () => {
    // У сторно qty < 0, и старый check(«qty > 0») его бы отверг. Переопределение
    // стоит в SQL; объяви его здесь — и генератор выпустил бы ЕЩЁ ОДНУ миграцию
    // ради ограничения, которое уже поставлено, а снапшот разошёлся бы с файлом
    // (та же причина записана у fixedPurchaseQty, schema.ts:1394-1405).
    const исходник = readFileSync(path.join(__dirname, "..", "src", "schema.ts"), "utf8");
    assert.ok(
      !/check\(\s*"vending_refill_qty_positive"/.test(исходник),
      "CHECK вернулся в схему — при следующем db:generate появится миграция-призрак",
    );
  });

  it("сторно-индексы ЧАСТИЧНЫЕ: уникальность только при source='storno'", () => {
    // Сплошной unique(reverses_id) не нужен и вреден: у обычных строк он NULL
    // (в Postgres NULL уникальности не мешает), но частичность — это ДОГОВОР,
    // что вторая сторно-строка на тот же оригинал невозможна, и повторное
    // нажатие кнопки в боте безвредно. У пересчёта своего client_key нет —
    // вся идемпотентность держится ровно на этом индексе.
    for (const [таблица, индекс] of [
      [schema.vendingStockCount, "vending_stock_count_storno_key"],
      [schema.vendingCashSession, "vending_cash_session_storno_key"],
      [schema.vendingRefill, "vending_refill_reverses_idx"],
    ] as const) {
      assert.ok(имена(таблица).includes(индекс), `нет индекса ${индекс}`);
    }
  });

  it("СТРАЖ: у целей ретенции есть индекс ПО КОЛОНКЕ ВРЕМЕНИ (0070/0071)", () => {
    // Ретенция чистит пачками `where <время> < cutoff order by <время> limit N`.
    // У снимков составной индекс начинается с `machine_serial` и под это условие
    // не годится (seq scan + сортировка на каждую пачку), у журнала прогонов
    // индекса не было вовсе. Снять индекс — значит вернуть полный скан на
    // растущей таблице, и заметить это будет нечем: чистка идёт раз в неделю
    // ночью.
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
      assert.ok(
        имена(таблица).includes(индекс),
        `нет индекса ${индекс} — ретенция уйдёт в полный скан`,
      );
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
    assert.deepEqual([...mod.taskStatusEnum.enumValues].sort(), [
      "cancelled",
      "done",
      "in_progress",
      "todo",
    ]);
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

describe("Инкассация: ключ идемпотентности (R-I-2)", () => {
  it("у `collection` есть `clientKey` — без него повторный перенос удвоил бы 386 строк", () => {
    const cfg = getTableConfig(collection);
    const колонка = cfg.columns.find((c) => c.name === "client_key");
    assert.ok(колонка, "колонки client_key нет");
    assert.equal(
      колонка!.notNull,
      false,
      "ключ обязан быть nullable: у своих строк источника вне MYDON нет",
    );
  });

  it("индекс по ключу УНИКАЛЬНЫЙ — иначе колонка была бы украшением", () => {
    const cfg = getTableConfig(collection);
    const индекс = cfg.indexes.find((i) => i.config.name === "collection_client_key");
    assert.ok(индекс, "индекса collection_client_key нет");
    assert.equal(индекс!.config.unique, true);
  });
});
