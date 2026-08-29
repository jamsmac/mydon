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
});
