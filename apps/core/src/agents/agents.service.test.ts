import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentSkillCatalog, systemConfig } from "@mydon/db";
import { AgentsService, type CatalogSkillInput } from "./agents.service";

type Row = Record<string, unknown>;

/** Стаб базы: копит values из insert/update, чтобы проверить, что кладём. */
function stub(opts: { existing?: Row; selectRows?: Row[] }) {
  const captured = { insert: [] as Row[], update: [] as Row[] };
  const tx = {
    insert: () => ({
      values: (v: Row) => {
        captured.insert.push(v);
        return { returning: async () => [{ id: "a1", ...v }] };
      },
    }),
    update: () => ({
      set: (v: Row) => {
        captured.update.push(v);
        return { where: () => ({ returning: async () => [{ ...(opts.existing ?? {}), ...v }] }) };
      },
    }),
  };
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => opts.selectRows ?? (opts.existing ? [opts.existing] : []) }) }),
    }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, captured };
}

/** Сервис задач нужен только запуску навыка: в остальных сценариях его вызов — регресс. */
const noTasks = {
  create: async () => {
    throw new Error("tasks.create вызван вне сценария запуска навыка");
  },
} as never;

describe("Настройки агента: конфиг-поля навыков в базе", () => {
  it("create кладёт пустые конфиг-поля по умолчанию (не теряются при загрузке из базы)", async () => {
    const { db, captured } = stub({ selectRows: [] });
    await new AgentsService(db, noTasks).create({ name: "knowledge-curator" });
    const v = captured.insert[0]; // первый insert — сам агент (второй — аудит)
    assert.deepEqual(v.webSources, []);
    assert.deepEqual(v.breakGlass, []);
    assert.deepEqual(v.ideaChannels, []);
    assert.deepEqual(v.kbPages, [], "kb_pages по умолчанию пусты — иначе NOT NULL колонка упала бы на insert");
    assert.equal(v.budgetOnExceeded, null);
  });

  it("update пишет страницы знаний (kbPages) и не трогает их, когда поле не передано", async () => {
    const { db, captured } = stub({ existing: { id: "a1", name: "globerent-sales" } });
    const svc = new AgentsService(db, noTasks);
    await svc.update("globerent-sales", {
      kbPages: ["shared/kb/globerent/heli-models.md", "shared/kb/globerent/pricelist.md"],
    });
    assert.deepEqual(captured.update[0].kbPages, [
      "shared/kb/globerent/heli-models.md",
      "shared/kb/globerent/pricelist.md",
    ]);
    await svc.update("globerent-sales", { description: "только описание" });
    assert.equal("kbPages" in captured.update[1], false, "непереданные kbPages не затираются");
  });

  it("update переносит каналы идей, break-glass и стратегию бюджета", async () => {
    const { db, captured } = stub({ existing: { id: "a1", name: "knowledge-curator" } });
    await new AgentsService(db, noTasks).update("knowledge-curator", {
      ideaChannels: ["promtjam"],
      breakGlass: ["read-sources"],
      budgetOnExceeded: "pause",
    });
    const v = captured.update[0];
    assert.deepEqual(v.ideaChannels, ["promtjam"]);
    assert.deepEqual(v.breakGlass, ["read-sources"]);
    assert.equal(v.budgetOnExceeded, "pause");
    assert.equal("webSources" in v, false, "непереданные поля не трогаем");
  });

  it("update пишет веб-источники", async () => {
    const { db, captured } = stub({ existing: { id: "a1", name: "market-analyst" } });
    await new AgentsService(db, noTasks).update("market-analyst", {
      webSources: [{ name: "cbu", url: "https://cbu.uz" }],
    });
    assert.deepEqual(captured.update[0].webSources, [{ name: "cbu", url: "https://cbu.uz" }]);
  });
});

/**
 * Каталог навыков, deck и запуск из панели (спека 2026-09-05-skills-deck-cron-llm).
 * Каталог — ЗЕРКАЛО файлов (R-SD-1): sync переписывает его целиком.
 */

/** Заглушка таблицы каталога: delete чистит, insert добавляет — видно, что осталось. */
function catalogDb(opts: { rows?: Row[] } = {}) {
  const store: Row[] = [...(opts.rows ?? [])];
  const audits: Row[] = [];
  const order: string[] = [];
  const tx = {
    delete: (table: unknown) => {
      order.push("delete");
      if (table === agentSkillCatalog) store.length = 0;
      return Promise.resolve([]);
    },
    insert: (table: unknown) => ({
      values: (value: Row | Row[]) => {
        order.push("insert");
        if (table === agentSkillCatalog) {
          for (const row of Array.isArray(value) ? value : [value]) store.push(row);
        } else {
          audits.push(value as Row);
        }
        return { then: (res: (rows: Row[]) => unknown) => Promise.resolve([]).then(res) };
      },
    }),
  };
  return {
    db: {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never,
    store,
    audits,
    order,
  };
}

describe("Каталог навыков — зеркало файлов (R-SD-1)", () => {
  const skill = (over: Partial<CatalogSkillInput> = {}): CatalogSkillInput => ({
    agent: "vendhub-ops",
    skill: "parts-audit",
    description: "Сверка узлов",
    executor: "llm",
    triggers: ["узлы"],
    allowedTools: ["core"],
    hasCode: false,
    problems: [],
    ...over,
  });

  it("sync стирает прежний каталог целиком и кладёт присланный", async () => {
    const fixture = catalogDb({
      rows: [
        { agentName: "old-agent", skill: "gone-one" },
        { agentName: "old-agent", skill: "gone-two" },
      ],
    });
    const result = await new AgentsService(fixture.db, noTasks).syncSkillCatalog([
      skill(),
      skill({ skill: "stock-watch", executor: "code", hasCode: true }),
    ]);

    assert.equal(result.count, 2);
    assert.match(result.syncedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      fixture.store.map((r) => r.skill),
      ["parts-audit", "stock-watch"],
      "строки чужого агента обязаны исчезнуть: файлы — источник истины",
    );
    assert.equal(fixture.order[0], "delete", "сначала стираем, потом пишем — одной транзакцией");
    assert.ok(fixture.audits.some((a) => a.action === "agent.skill_catalog.synced"));
  });

  it("необязательные поля кладутся как NULL, а не как undefined", async () => {
    const fixture = catalogDb();
    await new AgentsService(fixture.db, noTasks).syncSkillCatalog([skill()]);
    const row = fixture.store[0]!;
    assert.equal(row.tier, null);
    assert.equal(row.modelEffort, null);
    assert.equal(row.maxTokens, null);
    assert.equal(row.agentName, "vendhub-ops");
  });

  it("пустой список — пустой каталог (агенты не нашли ни одного навыка)", async () => {
    const fixture = catalogDb({ rows: [{ agentName: "old-agent", skill: "gone" }] });
    const result = await new AgentsService(fixture.db, noTasks).syncSkillCatalog([]);
    assert.equal(result.count, 0);
    assert.deepEqual(fixture.store, []);
  });
});

/** Заглушка чтения deck: каталог ⨝ агент, последние запуски и настройки моделей. */
function deckDb(opts: {
  joined?: Row[];
  lastRuns?: Row[];
  settings?: { key: string; value: string }[];
  onExecute?: (query: unknown) => void;
}) {
  return {
    select: () => ({
      from: (table: unknown) =>
        table === systemConfig
          ? Promise.resolve(opts.settings ?? [])
          : { leftJoin: () => ({ orderBy: async () => opts.joined ?? [] }) },
    }),
    execute: async (query: unknown) => {
      opts.onExecute?.(query);
      return opts.lastRuns ?? [];
    },
  } as never;
}

describe("Deck навыков — что видит панель", () => {
  const catalogRow = (over: Row = {}): Row => ({
    agentName: "vendhub-ops",
    skill: "parts-audit",
    description: "Сверка узлов",
    executor: "llm",
    tier: "T1",
    triggers: ["узлы"],
    allowedTools: ["core"],
    modelEffort: "medium",
    maxTokens: null,
    hasCode: false,
    problems: [],
    syncedAt: new Date("2026-09-05T06:00:00.000Z"),
    agentStatus: "active",
    business: "vendhub",
    autonomyDefault: "T2",
    agentSkills: ["parts-audit"],
    schedule: [{ cron: "0 9 * * 1", skill: "parts-audit" }],
    ...over,
  });

  it("enabled — навык закреплён за агентом; расписания и время синка видны", async () => {
    const deck = await new AgentsService(
      deckDb({
        joined: [catalogRow(), catalogRow({ skill: "stock-watch", agentSkills: ["parts-audit"] })],
        settings: [
          { key: "LLM_MODEL", value: "gpt-5.6-sol" },
          { key: "LLM_FALLBACK_MODELS", value: "model-a, model-b ,, " },
        ],
      }),
      noTasks,
    ).skillDeck();

    assert.equal(deck.syncedAt, "2026-09-05T06:00:00.000Z");
    assert.deepEqual(deck.models, { primary: "gpt-5.6-sol", fallbacks: ["model-a", "model-b"] });
    assert.equal(deck.items[0]?.enabled, true);
    assert.deepEqual(deck.items[0]?.crons, ["0 9 * * 1"]);
    assert.equal(
      deck.items[1]?.enabled,
      false,
      "навык из файлов, не закреплённый в карточке, не запускается",
    );
    assert.deepEqual(deck.items[1]?.crons, []);
  });

  it("агент из файлов без карточки в базе — draft и выключен", async () => {
    const deck = await new AgentsService(
      deckDb({
        joined: [
          catalogRow({
            agentName: "solution-scout",
            agentStatus: null,
            business: null,
            autonomyDefault: null,
            agentSkills: null,
            schedule: null,
          }),
        ],
      }),
      noTasks,
    ).skillDeck();

    assert.equal(deck.items[0]?.agentStatus, "draft");
    assert.equal(deck.items[0]?.enabled, false);
    assert.deepEqual(deck.items[0]?.crons, []);
  });

  it("одноимённые навыки у разных агентов: duplicates и тир не ниже максимума", async () => {
    const deck = await new AgentsService(
      deckDb({
        joined: [
          catalogRow({ agentName: "a-agent", tier: "T1" }),
          catalogRow({ agentName: "b-agent", tier: "T3" }),
          catalogRow({ agentName: "c-agent", skill: "stock-watch", tier: null }),
        ],
      }),
      noTasks,
    ).skillDeck();

    assert.equal(deck.items[0]?.duplicates, 2);
    assert.equal(deck.items[0]?.tierFloor, "T3", "порог берём по самому строгому одноимённому");
    assert.equal(deck.items[1]?.tierFloor, "T3");
    assert.equal(deck.items[2]?.duplicates, 1);
    assert.equal(deck.items[2]?.tierFloor, null, "тира нет ни у кого — порога нет");
  });

  it("последний запуск берётся из задач того же агента и навыка (R-SD-7)", async () => {
    const deck = await new AgentsService(
      deckDb({
        joined: [catalogRow(), catalogRow({ skill: "stock-watch" })],
        lastRuns: [
          {
            owner_ref: "vendhub-ops",
            agent_skill: "parts-audit",
            task_id: "11111111-1111-4111-8111-111111111111",
            status: "done",
            created_at: new Date("2026-09-05T05:00:00.000Z"),
            completed_at: new Date("2026-09-05T05:03:00.000Z"),
            blocked_reason: null,
            result_note: "Сверил 12 узлов",
          },
        ],
      }),
      noTasks,
    ).skillDeck();

    assert.deepEqual(deck.items[0]?.lastRun, {
      taskId: "11111111-1111-4111-8111-111111111111",
      status: "done",
      createdAt: "2026-09-05T05:00:00.000Z",
      completedAt: "2026-09-05T05:03:00.000Z",
      blockedReason: null,
      resultNote: "Сверил 12 узлов",
    });
    assert.equal(deck.items[1]?.lastRun, null, "чужой навык не подставляется");
  });

  it("«последний запуск» читается одним distinct on по индексу задач", async () => {
    let query: unknown;
    await new AgentsService(
      deckDb({
        joined: [catalogRow()],
        onExecute: (value) => {
          query = value;
        },
      }),
      noTasks,
    ).skillDeck();

    // Заглушка не проверяет SQL — рендерим настоящий текст запроса: иначе
    // сломанный запрос остался бы «зелёным» до первого запроса панели.
    const text = new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
    assert.match(text, /distinct on \("task"\."owner_ref", "task"\."agent_skill"\)/);
    assert.match(text, /"task"\."agent_skill" is not null/);
    assert.match(text, /order by "task"\."owner_ref", "task"\."agent_skill", "task"\."created_at" desc/);
  });

  it("пустой каталог — пустой deck, а не ошибка", async () => {
    const deck = await new AgentsService(deckDb({}), noTasks).skillDeck();
    assert.deepEqual(deck.items, []);
    assert.equal(deck.syncedAt, null);
  });
});

/** Заглушка запуска: каталог, карточка агента, задача и журнал. */
function runDb(opts: { catalog?: Row; agent?: Row }) {
  const audits: Row[] = [];
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () =>
              table === agentSkillCatalog
                ? opts.catalog
                  ? [opts.catalog]
                  : []
                : opts.agent
                  ? [opts.agent]
                  : [],
          }),
        }),
      }),
      insert: () => ({
        values: (value: Row) => {
          audits.push(value);
          return { then: (res: (rows: Row[]) => unknown) => Promise.resolve([]).then(res) };
        },
      }),
    } as never,
    audits,
  };
}

describe("Запуск навыка из панели (R-SD-2/6)", () => {
  const catalog: Row = { agentName: "vendhub-ops", skill: "parts-audit", executor: "llm" };
  const card = (over: Row = {}): Row => ({
    id: "a1",
    name: "vendhub-ops",
    status: "active",
    archivedAt: null,
    skills: ["parts-audit"],
    ...over,
  });

  function tasksSpy() {
    const calls: { input: Record<string, unknown>; actor: string | undefined }[] = [];
    return {
      calls,
      tasks: {
        create: async (input: Record<string, unknown>, actor?: string) => {
          calls.push({ input, actor });
          return { id: "task-1" };
        },
      } as never,
    };
  }

  it("успех: задача агенту с источником skills-deck, навыком и усилием", async () => {
    const fixture = runDb({ catalog, agent: card() });
    const spy = tasksSpy();
    const result = await new AgentsService(fixture.db, spy.tasks).runSkill(
      "vendhub-ops",
      "parts-audit",
      { input: "Сверить узлы на Kaffit-04", modelEffort: "high", actor: "owner" },
    );

    assert.deepEqual(result, { taskId: "task-1" });
    const input = spy.calls[0]!.input;
    assert.equal(input.title, "Навык parts-audit: Сверить узлы на Kaffit-04");
    assert.equal(input.description, "Сверить узлы на Kaffit-04");
    assert.equal(input.ownerKind, "agent");
    assert.equal(input.ownerRef, "vendhub-ops");
    assert.equal(input.source, "skills-deck");
    assert.equal(input.agentSkill, "parts-audit");
    assert.deepEqual(input.runOptions, { modelEffort: "high" });
    assert.equal(input.createdBy, "owner");
    assert.ok(fixture.audits.some((a) => a.action === "agent.skill.run"));
  });

  it("без входа — заголовок говорит, откуда задача, и параметров запуска нет", async () => {
    const spy = tasksSpy();
    await new AgentsService(runDb({ catalog, agent: card() }).db, spy.tasks).runSkill(
      "vendhub-ops",
      "parts-audit",
      {},
    );
    const input = spy.calls[0]!.input;
    assert.equal(input.title, "Навык parts-audit: запуск из deck");
    assert.equal(input.description, undefined);
    assert.equal(input.runOptions, undefined, "усилие не задано — поле не появляется");
    assert.equal(input.createdBy, "owner");
  });

  it("длинный вход обрезается в заголовке, но целиком уходит в описание", async () => {
    const spy = tasksSpy();
    const long = "я".repeat(200);
    await new AgentsService(runDb({ catalog, agent: card() }).db, spy.tasks).runSkill(
      "vendhub-ops",
      "parts-audit",
      { input: long },
    );
    assert.equal(spy.calls[0]!.input.title, `Навык parts-audit: ${"я".repeat(60)}`);
    assert.equal(spy.calls[0]!.input.description, long);
  });

  it("выключенный агент — отказ словами владельца (R-SD-6)", async () => {
    const svc = new AgentsService(runDb({ catalog, agent: card({ status: "paused" }) }).db, noTasks);
    await assert.rejects(
      svc.runSkill("vendhub-ops", "parts-audit", {}),
      /Агент "vendhub-ops" выключен — включи его в карточке/,
    );
  });

  it("навык не закреплён за агентом — 409, а не тихий запуск", async () => {
    const svc = new AgentsService(
      runDb({ catalog, agent: card({ skills: ["stock-watch"] }) }).db,
      noTasks,
    );
    await assert.rejects(
      svc.runSkill("vendhub-ops", "parts-audit", {}),
      /Навык "parts-audit" не закреплён за агентом "vendhub-ops"/,
    );
  });

  it("навыка нет в каталоге — 404 с подсказкой перезапустить агентов", async () => {
    const svc = new AgentsService(runDb({ agent: card() }).db, noTasks);
    await assert.rejects(svc.runSkill("vendhub-ops", "нет-такого", {}), NotFoundException);
  });
});
