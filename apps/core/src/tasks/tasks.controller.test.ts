import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  AgentRunCheckpointDto,
  AgentRunCommitDto,
  ClaimAgentRunDto,
  EnsureForDayDto,
  ReleaseAgentRunDto,
  SetStatusDto,
} from "./tasks.controller";

/**
 * `dayKey` — ЧАСТЬ КЛЮЧА ИДЕМПОТЕНТНОСТИ, а не просто дата (R-G-2).
 *
 * `source` собирается как `<ключ>:<dayKey>` и обязан попасть под предикат
 * частичного индекса `:[0-9]{4}-[0-9]{2}-[0-9]{2}$`. Полная дата-время проходит
 * `@IsISO8601({strict:true})`, но под предикат НЕ попадает — и дедуп
 * выключается молча: дубли пойдут без единой ошибки.
 */
const тело = (dayKey: string) =>
  plainToInstance(EnsureForDayDto, { title: "Мойка миксера", ownerKind: "human", dayKey });

describe("EnsureForDayDto: dayKey — только голые сутки", () => {
  it("YYYY-MM-DD принимается", async () => {
    assert.deepEqual(await validate(тело("2026-08-26")), []);
  });

  for (const плохой of [
    "2026-08-26T06:00:00.000Z",
    "2026-08-26 06:00",
    "26.08.2026",
    "2026-8-26",
  ]) {
    it(`«${плохой}» отбивается: такой source уходит из-под предиката индекса`, async () => {
      const ошибки = await validate(тело(плохой));
      assert.equal(ошибки[0]?.property, "dayKey", "иначе дедуп молча перестаёт работать");
    });
  }
});

describe("DTO durable agent-run", () => {
  const RUN_ID = "11111111-1111-4111-8111-111111111111";
  const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";

  it("claim требует непустое имя агента", async () => {
    assert.deepEqual(
      await validate(plainToInstance(ClaimAgentRunDto, { agentName: "receivables" })),
      [],
    );
    const errors = await validate(plainToInstance(ClaimAgentRunDto, { agentName: "" }));
    assert.equal(errors[0]?.property, "agentName");
  });

  it("release требует UUID runId для CAS", async () => {
    assert.deepEqual(
      await validate(
        plainToInstance(ReleaseAgentRunDto, {
          agentName: "receivables",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
        }),
      ),
      [],
    );
    const errors = await validate(
      plainToInstance(ReleaseAgentRunDto, {
        agentName: "receivables",
        runId: "old-run",
        executionAttemptId: EXECUTION_ID,
      }),
    );
    assert.ok(errors.some((error) => error.property === "runId"));
    assert.deepEqual(
      await validate(
        plainToInstance(ReleaseAgentRunDto, {
          agentName: "receivables",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
          reason: "budget_denied",
        }),
      ),
      [],
    );
    const reasonErrors = await validate(
      plainToInstance(ReleaseAgentRunDto, {
        agentName: "receivables",
        runId: RUN_ID,
        executionAttemptId: EXECUTION_ID,
        reason: "provider_error",
      }),
    );
    assert.equal(reasonErrors[0]?.property, "reason");
    assert.deepEqual(
      await validate(
        plainToInstance(ReleaseAgentRunDto, {
          agentName: "receivables",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
          reason: "action_capped",
        }),
      ),
      [],
    );
    assert.deepEqual(
      await validate(
        plainToInstance(ReleaseAgentRunDto, {
          agentName: "receivables",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
          reason: "unsupported",
          detail: "нет навыка",
        }),
      ),
      [],
    );
    assert.deepEqual(
      await validate(
        plainToInstance(ReleaseAgentRunDto, {
          agentName: "receivables",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
          reason: "workflow_changed",
          detail: "endpoint route changed",
        }),
      ),
      [],
    );
  });

  it("checkpoint принимает только typed result и режет action по контракту approvals", async () => {
    const valid = plainToInstance(AgentRunCheckpointDto, {
      agentName: "receivables",
      runId: RUN_ID,
      executionAttemptId: EXECUTION_ID,
      skill: "watch-receivables",
      kind: "proposal",
      action: "Напомнить клиенту об оплате",
      facts: { overdue: 3 },
      next: ["Проверить завтра"],
    });
    assert.deepEqual(await validate(valid), []);

    const tooLong = plainToInstance(AgentRunCheckpointDto, {
      ...valid,
      action: "x".repeat(513),
    });
    assert.ok((await validate(tooLong)).some((error) => error.property === "action"));
  });

  it("commit требует fence, outcome kind и непустой note", async () => {
    const valid = plainToInstance(AgentRunCommitDto, {
      agentName: "receivables",
      runId: RUN_ID,
      executionAttemptId: EXECUTION_ID,
      kind: "approval_requested",
      note: "Вынес на решение владельца",
      action: "Напомнить клиенту об оплате",
      facts: { overdue: 3 },
      tier: "T1",
      memorySignature: "sha256:abc",
    });
    assert.deepEqual(await validate(valid), []);

    const invalid = plainToInstance(AgentRunCommitDto, {
      ...valid,
      kind: "maybe",
      note: "",
    });
    const errors = await validate(invalid);
    assert.ok(errors.some((error) => error.property === "kind"));
    assert.ok(errors.some((error) => error.property === "note"));
  });

  it("agentRunId в PATCH status опционален, но если передан — только UUID", async () => {
    assert.deepEqual(
      await validate(plainToInstance(SetStatusDto, { status: "done", agentRunId: RUN_ID })),
      [],
    );
    const errors = await validate(
      plainToInstance(SetStatusDto, { status: "done", agentRunId: "generation-1" }),
    );
    assert.equal(errors[0]?.property, "agentRunId");
  });
});
