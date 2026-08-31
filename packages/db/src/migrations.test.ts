import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Сторож ЦЕПОЧКИ миграций, а не их содержания.
 *
 * Ловит ровно один класс аварии: две ветки взяли один номер. Мигратор
 * drizzle идёт по `_journal.json`, а не по каталогу, поэтому файл без записи
 * НЕ применится вовсе (и это будет видно только в проде, когда колонки нет), а
 * запись без файла роняет автодеплой на ровном месте. Оба случая рождаются в
 * rebase и оба невидимы для `pnpm build`.
 *
 * Папка считается от расположения файла (`dist/../drizzle`), а не от cwd, —
 * тот же приём, что в `migrate.ts:33`: тесты зовут и из корня, и из пакета.
 *
 * Снапшоты (`meta/<NNNN>_snapshot.json`) НЕ проверяются намеренно: их 65 на 72
 * миграции — у семи рукописных (`0049`…`0055`) снапшота нет, и такая проверка
 * была бы красной с рождения, то есть её бы отключили в первый же день.
 */
const ПАПКА = path.resolve(__dirname, "..", "drizzle");

interface ЗаписьЖурнала {
  idx: number;
  tag: string;
}

function журнал(): ЗаписьЖурнала[] {
  const raw = readFileSync(path.join(ПАПКА, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: ЗаписьЖурнала[] }).entries;
}

describe("Цепочка миграций: файл ↔ журнал (сторож номера)", () => {
  const записи = журнал();
  const файлы = readdirSync(ПАПКА)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, -4));

  it("у каждого .sql есть запись журнала, у каждой записи — файл", () => {
    const теги = new Set(записи.map((e) => e.tag));
    for (const f of файлы)
      assert.ok(теги.has(f), `${f}.sql не записан в _journal.json — мигратор его не применит`);
    const наДиске = new Set(файлы);
    for (const e of записи)
      assert.ok(наДиске.has(e.tag), `в журнале есть ${e.tag}, а файла нет — автодеплой упадёт`);
  });

  it("idx идут подряд с нуля и не повторяются", () => {
    assert.deepEqual(
      записи.map((e) => e.idx),
      записи.map((_, i) => i),
      "дырка или дубль idx — верный признак того, что две ветки взяли один номер",
    );
  });

  it("префикс имени файла равен idx", () => {
    for (const e of записи) {
      assert.equal(
        e.tag.slice(0, 4),
        String(e.idx).padStart(4, "0"),
        `${e.tag}: имя и idx разошлись`,
      );
    }
  });

  it("теги уникальны", () => {
    assert.equal(new Set(записи.map((e) => e.tag)).size, записи.length);
  });

  it("0075 сеет текущие Anthropic-модели с раздельными 5m/1h cache-тарифами", () => {
    const sql = readFileSync(path.join(ПАПКА, "0075_llm_ledger.sql"), "utf8");
    assert.match(sql, /agent_execution_attempt_id/);
    assert.match(sql, /agent_execution_retry_at/);
    assert.match(sql, /agent_execution_blocked_at/);
    assert.match(sql, /agent_execution_blocked_reason/);
    assert.match(sql, /llm_spend_provider_failed_at_idx/);
    assert.match(sql, /cache_write_5m_usd_per_mtok/);
    assert.match(sql, /cache_write_1h_usd_per_mtok/);
    assert.match(sql, /'claude-opus-5'.*5, 25, 0\.5, 6\.25, 10/s);
    assert.match(sql, /'claude-sonnet-5'.*2, 10, 0\.2, 2\.5, 4/s);
    assert.doesNotMatch(sql, /'claude-sonnet-5'.*3, 15/s, "отменённого future-rate быть не должно");
    assert.match(sql, /0\.004166667/, "code execution: 5 минут × $0.05/ч");
  });

  it("0076 добавляет durable agent outcome, outbox и idempotency без побочных ALTER", () => {
    const sql = readFileSync(path.join(ПАПКА, "0076_agent_execution_outbox.sql"), "utf8");

    assert.match(
      sql,
      /CREATE TYPE "public"\."task_agent_execution_status" AS ENUM\('ready', 'committed', 'abandoned'\)/,
    );
    assert.match(
      sql,
      /CREATE TYPE "public"\."outbox_delivery_status" AS ENUM\('pending', 'dispatching', 'sent', 'skipped', 'unknown', 'dead'\)/,
    );
    assert.match(sql, /CREATE TABLE "task_agent_execution"/);
    assert.match(sql, /"execution_attempt_id" uuid NOT NULL/);
    assert.match(sql, /"task_agent_execution_attempt_key".*\("execution_attempt_id"\)/);
    assert.match(sql, /"task_agent_execution_schema_version_positive" CHECK/);
    assert.match(sql, /"task_agent_execution_terminal_fields_consistent" CHECK/);
    assert.match(sql, /"task_id"\) REFERENCES "public"\."task"\("id"\) ON DELETE cascade/);
    assert.match(sql, /"approval_id"\) REFERENCES "public"\."approval"\("id"\)/);

    assert.match(sql, /CREATE TABLE "outbox_delivery"/);
    assert.match(sql, /"outbox_delivery_key".*\("key"\)/);
    assert.match(sql, /"outbox_delivery_destination_status_created_idx"/);
    assert.match(sql, /"outbox_delivery_attempts_nonnegative" CHECK/);
    assert.match(
      sql,
      /"task_agent_execution_id"\) REFERENCES "public"\."task_agent_execution"\("id"\) ON DELETE cascade/,
    );

    assert.match(sql, /ALTER TABLE "approval" ADD COLUMN "client_key" text/);
    assert.match(sql, /CREATE UNIQUE INDEX "approval_client_key"/);
    assert.match(sql, /ALTER TABLE "event" ADD COLUMN "client_key" text/);
    assert.match(sql, /CREATE UNIQUE INDEX "event_client_key"/);
    assert.doesNotMatch(sql, /ALTER TABLE "task"/, "0076 не должна менять существующий task");
  });

  it("0077 безопасно добавляет active execution и durable task LLM jobs", () => {
    const sql = readFileSync(path.join(ПАПКА, "0077_nebulous_silk_fever.sql"), "utf8");

    assert.match(
      sql,
      /CREATE TYPE "public"\."task_agent_execution_status" AS ENUM\('active', 'ready', 'committed', 'abandoned'\)/,
    );
    assert.doesNotMatch(
      sql,
      /ALTER TYPE "public"\."task_agent_execution_status" ADD VALUE/,
      "новое enum-значение нельзя использовать в той же drizzle-транзакции",
    );
    const dropConsistency = sql.indexOf(
      'DROP CONSTRAINT "task_agent_execution_terminal_fields_consistent"',
    );
    const dropCheckpointNotNull = sql.indexOf('ALTER COLUMN "checkpoint_kind" DROP NOT NULL');
    const addConsistency = sql.lastIndexOf(
      'ADD CONSTRAINT "task_agent_execution_terminal_fields_consistent"',
    );
    assert.ok(dropConsistency >= 0 && dropConsistency < dropCheckpointNotNull);
    assert.ok(dropCheckpointNotNull < addConsistency);
    assert.match(sql, /"execution_plan_hash" text;/);
    assert.match(
      sql,
      /"execution_plan_hash" = 'a5dd3ce7993c63ad01d8a9a45922bc5f17d2c41c5f21a10671ec8c05c5ffc4aa'/,
    );
    assert.match(sql, /"started_at" = "created_at"/);
    const hashBackfill = sql.indexOf(
      "\"execution_plan_hash\" = 'a5dd3ce7993c63ad01d8a9a45922bc5f17d2c41c5f21a10671ec8c05c5ffc4aa'",
    );
    const hashDefault = sql.indexOf(
      "ALTER COLUMN \"execution_plan_hash\" SET DEFAULT 'a5dd3ce7993c63ad01d8a9a45922bc5f17d2c41c5f21a10671ec8c05c5ffc4aa'",
    );
    const hashNotNull = sql.indexOf('ALTER COLUMN "execution_plan_hash" SET NOT NULL');
    assert.ok(
      hashBackfill >= 0 && hashBackfill < hashDefault && hashDefault < hashNotNull,
      "rolling deploy: backfill -> DEFAULT -> NOT NULL",
    );

    for (const table of [
      "agent_task_llm_job",
      "agent_task_llm_authorization",
      "agent_task_llm_result",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
    }
    assert.match(sql, /"endpoint_profile" text NOT NULL/);
    assert.match(sql, /"request_payload" jsonb,/);
    assert.match(sql, /"agent_task_llm_job_execution_step_attempt_key"/);
    assert.match(sql, /"agent_task_llm_job_spend_key"/);
    assert.match(sql, /"agent_task_llm_job_state_fields_consistent" CHECK/);
    assert.match(sql, /"agent_task_llm_result_hash_format" CHECK/);
    assert.match(sql, /"agent_task_llm_authorization_job_day_key"/);
    assert.match(sql, /"agent_task_llm_authorization_job_granted_key"/);
    assert.equal((sql.match(/ON DELETE restrict/g) ?? []).length, 5);
  });

  it("0078 seeds a bounded GPT-5.6 Sol promotional price without overwriting an owner override", () => {
    const sql = readFileSync(path.join(ПАПКА, "0078_openai_gpt_56_sol.sql"), "utf8");

    assert.match(sql, /'openai', 'gpt-5\.6-sol', 'metered', 'tokens'/);
    assert.match(sql, /4, 20, 0\.4, 5, 5/);
    assert.match(sql, /'2026-11-22T00:00:00\+00:00'/);
    assert.match(sql, /WHERE NOT EXISTS/);
    assert.match(sql, /"valid_from" <= '2026-08-30T00:00:00\+05:00'/);
    assert.match(sql, /"valid_to" IS NULL OR "valid_to" > '2026-08-30T00:00:00\+05:00'/);
    assert.doesNotMatch(sql, /ON CONFLICT \("provider", "model"\)/);
    assert.match(sql, />272K-input tier/);
  });

  it("0079 adds a nullable, bounded and all-or-none durable input snapshot", () => {
    const sql = readFileSync(path.join(ПАПКА, "0079_task_agent_input_snapshot.sql"), "utf8");

    assert.match(sql, /ADD COLUMN "input_snapshot_kind" text;/);
    assert.match(sql, /ADD COLUMN "input_snapshot_payload" jsonb;/);
    assert.match(sql, /ADD COLUMN "input_snapshot_hash" text;/);
    assert.doesNotMatch(sql, /ADD COLUMN "input_snapshot_(?:kind|payload|hash)"[^;]*NOT NULL/);
    assert.match(sql, /task_agent_execution_input_snapshot_consistent/);
    assert.match(sql, /task_agent_execution_input_snapshot_kind_bounded/);
    assert.match(sql, /char_length\(btrim\([^)]*input_snapshot_kind/);
    assert.match(sql, /between 1 and 128/);
    assert.match(sql, /task_agent_execution_input_snapshot_payload_bounded/);
    assert.match(sql, /jsonb_typeof\([^)]*input_snapshot_payload/);
    assert.match(sql, /octet_length\([^)]*input_snapshot_payload[^)]*::text\) <= 65536/);
    assert.match(sql, /task_agent_execution_input_snapshot_hash_format/);
    assert.match(sql, /\^\[0-9a-f\]\{64\}\$/);
  });

  it("0080 indexes minute LLM alerts and the open durable schedule queue", () => {
    const sql = readFileSync(path.join(ПАПКА, "0080_llm_alert_schedule_indexes.sql"), "utf8");

    for (const name of [
      "llm_spend_alert_unknown_idx",
      "llm_spend_stuck_reserved_at_idx",
      "llm_spend_stuck_created_at_idx",
      "agent_task_llm_job_alert_unknown_idx",
      "outbox_delivery_alert_terminal_idx",
      "task_agent_schedule_open_queue_idx",
    ]) {
      assert.match(sql, new RegExp(`CREATE INDEX "${name}"`), `нет индекса ${name}`);
    }
    assert.match(sql, /"status" = 'failed'.*"outcome" = 'unknown'/);
    assert.match(sql, /"status" = 'reserved'.*"reserved_at" is not null/);
    assert.match(sql, /"status" = 'reserved'.*"reserved_at" is null/);
    assert.match(sql, /"status" = 'unknown'/);
    assert.match(sql, /"status" = 'unknown' or .*"status" = 'dead'/);
    assert.match(sql, /"source" = 'agent-schedule'/);
    assert.match(sql, /"status" <> 'done'.*"status" <> 'cancelled'/);
  });

  it("0081 adds durable operational issues linked one-to-one with tasks", () => {
    const migration = readFileSync(path.join(ПАПКА, "0081_operational_issue.sql"), "utf8");
    assert.match(migration, /CREATE TYPE "public"\."operational_issue_status" AS ENUM\('open', 'resolved'\)/);
    assert.match(migration, /CREATE TABLE "operational_issue"/);
    assert.match(migration, /CREATE TABLE "operational_projection_state"/);
    assert.match(migration, /"watermark" timestamp with time zone NOT NULL/);
    assert.match(migration, /"task_id" uuid NOT NULL/);
    assert.match(migration, /REFERENCES "public"\."task"\("id"\) ON DELETE restrict/);
    assert.match(migration, /CREATE UNIQUE INDEX "operational_issue_kind_fingerprint_key"/);
    assert.match(migration, /CREATE UNIQUE INDEX "operational_issue_task_key"/);
    assert.match(migration, /CREATE INDEX "operational_issue_open_domain_idx".*WHERE .*"status" = 'open'/s);
    assert.match(migration, /CREATE INDEX "operational_issue_open_kind_date_idx".*WHERE .*"status" = 'open'/s);
    assert.match(migration, /CREATE INDEX "operational_issue_kind_date_idx"/);
    assert.match(migration, /operational_issue_resolution_consistent/);
  });

  it("0082 backfills only verified VendHub maintenance-monitor tasks", () => {
    const migration = readFileSync(path.join(ПАПКА, "0082_maintenance_task_domain.sql"), "utf8");
    assert.match(migration, /UPDATE "task" AS t/);
    assert.match(migration, /SET "domain" = 'vendhub'/);
    assert.match(migration, /t\."domain" IS NULL/);
    assert.match(migration, /t\."created_by" = 'agent:maintenance-monitor'/);
    assert.match(migration, /t\."owner_kind" = 'human'/);
    assert.match(migration, /JOIN "maintenance_plan"|FROM "maintenance_plan"/);
    assert.match(migration, /split_part\(t\."source", ':', 2\) = mp\."id"::text/);
    assert.match(migration, /t\."entity_id" = mp\."entity_id"/);
    assert.match(migration, /o\."code" = 'vendhub'/);
    assert.match(migration, /\^maint:/);
  });
});
