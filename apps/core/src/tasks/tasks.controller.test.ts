import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request } from "express";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { Db } from "../db/db.module";
import {
  AgentRunCheckpointDto,
  AgentRunCommitDto,
  AgentRunInputSnapshotDto,
  ClaimAgentRunDto,
  EditTaskDto,
  EnsureAgentScheduleDto,
  EnsureForDayDto,
  ListTasksDto,
  ReleaseAgentRunDto,
  SetStatusDto,
  TasksController,
} from "./tasks.controller";

/** Db-заглушка для excludePersonal: settingValue = `select().from(systemConfig)`. */
function fakeDb(rows: { key: string; value: string }[] = []): Db {
  return { select: () => ({ from: () => Promise.resolve(rows) }) } as unknown as Db;
}

/** Запрос с заголовками — owner-токен читается из `x-owner-action-token`. */
function req(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

describe("ListTasksDto: pagination", () => {
  it("преобразует query-строки в bounded числа", async () => {
    const dto = plainToInstance(ListTasksDto, { limit: "300", offset: "900" });
    assert.deepEqual(await validate(dto), []);
    assert.equal(dto.limit, 300);
    assert.equal(dto.offset, 900);
  });

  it("отбивает нулевой/чрезмерный limit и отрицательный offset", async () => {
    for (const input of [
      { limit: "0" },
      { limit: "301" },
      { limit: "1.5" },
      { offset: "-1" },
      { offset: "100001" },
    ]) {
      const errors = await validate(plainToInstance(ListTasksDto, input));
      assert.ok(errors.some((error) => error.property === Object.keys(input)[0]));
    }
  });

  it("передаёт pagination в общую и awaiting-выборки", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const service = {
      list: (...args: unknown[]) => calls.push({ method: "list", args }),
      awaitingConfirmation: (...args: unknown[]) =>
        calls.push({ method: "awaitingConfirmation", args }),
      unassigned: (...args: unknown[]) => calls.push({ method: "unassigned", args }),
    };
    // Флаг ужесточения выключен (пустая база, нет owner-токена) → excludePersonal=false.
    const controller = new TasksController(service as never, fakeDb());

    await controller.list({ open: "1", domain: "vendhub", limit: 40, offset: 80 }, req());
    await controller.list({ awaiting: "1", limit: 25, offset: 50 }, req());
    await controller.list({ unassigned: "1", limit: 10, offset: 20 }, req());

    assert.deepEqual(calls, [
      {
        method: "list",
        // Второй аргумент — excludePersonal: при выключенном флаге строго false.
        args: [{ domain: "vendhub", limit: 40, offset: 80, openOnly: true }, false],
      },
      // Третий аргумент — excludePersonal: при выключенном флаге строго false,
      // и он обязан доходить до awaiting/unassigned (тот же domain-less обход).
      { method: "awaitingConfirmation", args: [25, 50, false] },
      { method: "unassigned", args: [10, 20, false] },
    ]);
  });

  it("флаг включён + нет owner-токена → excludePersonal=true в общей выборке", async () => {
    const prevOwner = process.env.OWNER_ACTION_TOKEN;
    const prevService = process.env.SERVICE_TOKEN;
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    try {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const service = { list: (...args: unknown[]) => calls.push({ method: "list", args }) };
      const controller = new TasksController(service as never, fakeDb([{ key: "OWNER_IDENTITY_ENFORCED", value: "1" }]));

      await controller.list({ open: "1" }, req());
      assert.deepEqual(calls, [{ method: "list", args: [{ openOnly: true }, true] }]);

      // Тот же запрос с валидным owner-токеном — excludePersonal снова false.
      calls.length = 0;
      await controller.list({ open: "1" }, req({ "x-owner-action-token": "owner-secret" }));
      assert.deepEqual(calls, [{ method: "list", args: [{ openOnly: true }, false] }]);
    } finally {
      if (prevOwner === undefined) delete process.env.OWNER_ACTION_TOKEN;
      else process.env.OWNER_ACTION_TOKEN = prevOwner;
      if (prevService === undefined) delete process.env.SERVICE_TOKEN;
      else process.env.SERVICE_TOKEN = prevService;
    }
  });
});

describe("by-id и awaiting/unassigned чтения не утекают personal (R-P5-6)", () => {
  const ID = "33333333-3333-4333-8333-333333333333";

  it("флаг выключен — byId/comments/awaiting/unassigned получают excludePersonal=false", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const service = {
      byId: (...args: unknown[]) => calls.push({ method: "byId", args }),
      comments: (...args: unknown[]) => calls.push({ method: "comments", args }),
      awaitingConfirmation: (...args: unknown[]) =>
        calls.push({ method: "awaitingConfirmation", args }),
      unassigned: (...args: unknown[]) => calls.push({ method: "unassigned", args }),
    };
    const controller = new TasksController(service as never, fakeDb());

    await controller.byId(ID, req());
    await controller.comments(ID, req());
    await controller.list({ awaiting: "1" }, req());
    await controller.list({ unassigned: "1" }, req());

    assert.deepEqual(calls, [
      { method: "byId", args: [ID, false] },
      { method: "comments", args: [ID, false] },
      { method: "awaitingConfirmation", args: [100, 0, false] },
      { method: "unassigned", args: [50, 0, false] },
    ]);
  });

  it("флаг включён + нет owner-токена — все by-id/aggregate чтения получают excludePersonal=true", async () => {
    const prevOwner = process.env.OWNER_ACTION_TOKEN;
    const prevService = process.env.SERVICE_TOKEN;
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    try {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const service = {
        byId: (...args: unknown[]) => calls.push({ method: "byId", args }),
        comments: (...args: unknown[]) => calls.push({ method: "comments", args }),
        awaitingConfirmation: (...args: unknown[]) =>
          calls.push({ method: "awaitingConfirmation", args }),
        unassigned: (...args: unknown[]) => calls.push({ method: "unassigned", args }),
      };
      const controller = new TasksController(
        service as never,
        fakeDb([{ key: "OWNER_IDENTITY_ENFORCED", value: "1" }]),
      );

      await controller.byId(ID, req());
      await controller.comments(ID, req());
      await controller.list({ awaiting: "1" }, req());
      await controller.list({ unassigned: "1" }, req());

      assert.deepEqual(calls, [
        { method: "byId", args: [ID, true] },
        { method: "comments", args: [ID, true] },
        { method: "awaitingConfirmation", args: [100, 0, true] },
        { method: "unassigned", args: [50, 0, true] },
      ]);

      // Тот же запрос с валидным owner-токеном — excludePersonal снова false.
      calls.length = 0;
      await controller.byId(ID, req({ "x-owner-action-token": "owner-secret" }));
      assert.deepEqual(calls, [{ method: "byId", args: [ID, false] }]);
    } finally {
      if (prevOwner === undefined) delete process.env.OWNER_ACTION_TOKEN;
      else process.env.OWNER_ACTION_TOKEN = prevOwner;
      if (prevService === undefined) delete process.env.SERVICE_TOKEN;
      else process.env.SERVICE_TOKEN = prevService;
    }
  });
});

describe("Агрегатные чтения не утекают personal (R-P5-7a)", () => {
  function aggregateService(calls: Array<{ method: string; args: unknown[] }>) {
    return {
      overdue: (...args: unknown[]) => calls.push({ method: "overdue", args }),
      dueSoon: (...args: unknown[]) => calls.push({ method: "dueSoon", args }),
      workload: (...args: unknown[]) => calls.push({ method: "workload", args }),
      redoUnnotified: (...args: unknown[]) => calls.push({ method: "redoUnnotified", args }),
      assignUnnotified: (...args: unknown[]) =>
        calls.push({ method: "assignUnnotified", args }),
    };
  }

  async function callAll(controller: TasksController, request: Request) {
    await controller.overdue(request);
    await controller.dueSoon(request);
    await controller.redoUnnotified(request);
    await controller.assignUnnotified(request);
    await controller.workload(request);
  }

  it("флаг выключен — все пять агрегатов получают excludePersonal=false", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const controller = new TasksController(aggregateService(calls) as never, fakeDb());

    await callAll(controller, req());

    assert.deepEqual(calls, [
      { method: "overdue", args: [false] },
      { method: "dueSoon", args: [24, false] },
      { method: "redoUnnotified", args: [false] },
      { method: "assignUnnotified", args: [50, false] },
      { method: "workload", args: [false] },
    ]);
  });

  it("флаг включён + нет owner-токена → excludePersonal=true; с owner-токеном снова false", async () => {
    const prevOwner = process.env.OWNER_ACTION_TOKEN;
    const prevService = process.env.SERVICE_TOKEN;
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    try {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const controller = new TasksController(
        aggregateService(calls) as never,
        fakeDb([{ key: "OWNER_IDENTITY_ENFORCED", value: "1" }]),
      );

      await callAll(controller, req());
      assert.deepEqual(calls, [
        { method: "overdue", args: [true] },
        { method: "dueSoon", args: [24, true] },
        { method: "redoUnnotified", args: [true] },
        { method: "assignUnnotified", args: [50, true] },
        { method: "workload", args: [true] },
      ]);

      // Тот же путь с валидным owner-токеном — личный контур снова виден.
      calls.length = 0;
      await callAll(controller, req({ "x-owner-action-token": "owner-secret" }));
      assert.deepEqual(calls, [
        { method: "overdue", args: [false] },
        { method: "dueSoon", args: [24, false] },
        { method: "redoUnnotified", args: [false] },
        { method: "assignUnnotified", args: [50, false] },
        { method: "workload", args: [false] },
      ]);
    } finally {
      if (prevOwner === undefined) delete process.env.OWNER_ACTION_TOKEN;
      else process.env.OWNER_ACTION_TOKEN = prevOwner;
      if (prevService === undefined) delete process.env.SERVICE_TOKEN;
      else process.env.SERVICE_TOKEN = prevService;
    }
  });

  // Контракт бот-рассыльщиков: apps/bot/core-client.request шлёт ТОЛЬКО
  // x-service-token и никогда x-owner-action-token. Значит под enforcement=ON
  // рассыльщики напоминаний/приёмок/назначений проходят этот же гейт с
  // excludePersonal=TRUE и личные задачи из рассылки выпадают. Фиксируем это
  // осознанное поведение, чтобы комментарии сервиса/контроллера не разошлись с
  // реальностью (было ложное «рассыльщик зовёт на дефолте false»).
  it("enforcement=ON: бот с одним service-токеном теряет personal в рассылках", async () => {
    const prevOwner = process.env.OWNER_ACTION_TOKEN;
    const prevService = process.env.SERVICE_TOKEN;
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    try {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const controller = new TasksController(
        aggregateService(calls) as never,
        fakeDb([{ key: "OWNER_IDENTITY_ENFORCED", value: "1" }]),
      );

      // Ровно то, что кладёт core-client: общий service-токен, owner-токена нет.
      const botRequest = req({ "x-service-token": "shared" });
      await controller.dueSoon(botRequest);
      await controller.redoUnnotified(botRequest);
      await controller.assignUnnotified(botRequest);

      assert.deepEqual(calls, [
        { method: "dueSoon", args: [24, true] },
        { method: "redoUnnotified", args: [true] },
        { method: "assignUnnotified", args: [50, true] },
      ]);
    } finally {
      if (prevOwner === undefined) delete process.env.OWNER_ACTION_TOKEN;
      else process.env.OWNER_ACTION_TOKEN = prevOwner;
      if (prevService === undefined) delete process.env.SERVICE_TOKEN;
      else process.env.SERVICE_TOKEN = prevService;
    }
  });
});

describe("EditTaskDto: направление", () => {
  it("принимает канон и пропущенное поле", async () => {
    assert.deepEqual(await validate(plainToInstance(EditTaskDto, {})), []);
    assert.deepEqual(await validate(plainToInstance(EditTaskDto, { domain: "vendhub" })), []);
  });

  it("отбивает null и неизвестное направление", async () => {
    for (const domain of [null, "legacy"]) {
      const errors = await validate(plainToInstance(EditTaskDto, { domain }));
      assert.ok(errors.some((error) => error.property === "domain"));
    }
  });
});

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

describe("TasksController.ensureForDay: направление", () => {
  it("пробрасывает validated domain в TasksService", async () => {
    let received: Record<string, unknown> | undefined;
    const controller = new TasksController(
      {
        ensureForDay: (input: Record<string, unknown>) => {
          received = input;
          return null;
        },
      } as never,
      fakeDb(),
    );

    await controller.ensureForDay({
      title: "Мойка миксера",
      ownerKind: "human",
      domain: "vendhub",
      dayKey: "2026-08-26",
    });

    assert.equal(received?.domain, "vendhub");
  });
});

describe("TasksController.ensureForDay: форма ответа — явный JSON, никогда не пустое тело", () => {
  const тело = {
    title: "Мойка миксера",
    ownerKind: "human" as const,
    dayKey: "2026-08-26",
  };

  it("повтор дня → { created: false }, а не null: null Nest отдаёт ПУСТЫМ телом, и клиент агентов падал на res.json() каждый день", async () => {
    const controller = new TasksController(
      { ensureForDay: () => Promise.resolve(null) } as never,
      fakeDb(),
    );

    const res = await controller.ensureForDay(тело);

    assert.deepEqual(res, { created: false });
  });

  it("первый прогон дня → { created: true, id, task }; id продублирован на верхнем уровне ради старого клиента (row?.id)", async () => {
    const созданная = { id: "6a51c3a4-8f7e-4a10-9d40-000000000001", title: "Мойка миксера" };
    const controller = new TasksController(
      { ensureForDay: () => Promise.resolve(созданная) } as never,
      fakeDb(),
    );

    const res = await controller.ensureForDay(тело);

    assert.ok(res.created, "первый прогон обязан отвечать created: true");
    assert.equal(res.id, созданная.id, "старый агент различает исходы по row?.id");
    assert.deepEqual(res.task, созданная);
  });
});

describe("EnsureAgentScheduleDto: exact planned occurrence", () => {
  const valid = {
    agentName: "coach-agent",
    skill: "coach-review",
    cron: "0 10 * * 1",
    scheduledAt: "2026-08-31T05:00:00.000Z",
  };

  it("принимает только UTC fire time и bounded identity", async () => {
    assert.deepEqual(await validate(plainToInstance(EnsureAgentScheduleDto, valid)), []);
    const errors = await validate(
      plainToInstance(EnsureAgentScheduleDto, {
        ...valid,
        scheduledAt: "2026-08-31T10:00:00+05:00",
      }),
    );
    assert.ok(errors.some((error) => error.property === "scheduledAt"));
  });

  it("отбивает невалидное имя и длинный cron", async () => {
    const errors = await validate(
      plainToInstance(EnsureAgentScheduleDto, {
        ...valid,
        agentName: "Coach Agent",
        cron: "x".repeat(65),
      }),
    );
    assert.ok(errors.some((error) => error.property === "agentName"));
    assert.ok(errors.some((error) => error.property === "cron"));
  });
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
          agentName: "globerent-sales",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
          reason: "skill_failed",
          detail: "ответ модели не по контракту",
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
    assert.deepEqual(
      await validate(
        plainToInstance(ReleaseAgentRunDto, {
          agentName: "solution-scout",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
          reason: "route_unavailable",
          detail: "find-solution:rank is not configured",
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

  it("input snapshot требует fence, bounded kind и object payload", async () => {
    const valid = plainToInstance(AgentRunInputSnapshotDto, {
      agentName: "solution-scout",
      runId: RUN_ID,
      executionAttemptId: EXECUTION_ID,
      kind: "solution-search-v1",
      payload: { candidates: [] },
    });
    assert.deepEqual(await validate(valid), []);

    const invalid = plainToInstance(AgentRunInputSnapshotDto, {
      ...valid,
      kind: "x".repeat(129),
      payload: [],
    });
    const errors = await validate(invalid);
    assert.ok(errors.some((error) => error.property === "kind"));
    assert.ok(errors.some((error) => error.property === "payload"));
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

    const oversizedSignature = plainToInstance(AgentRunCommitDto, {
      ...valid,
      memorySignature: "x".repeat(513),
    });
    assert.ok(
      (await validate(oversizedSignature)).some((error) => error.property === "memorySignature"),
    );
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
