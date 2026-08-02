import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBriefing, msUntilBriefing } from "./briefing";
import { handleMessage, parseApprovalCallback, type HandlerDeps } from "./handler";
import { parseIntent } from "./intent";
import { parseAllowlist, RateLimiter } from "./security/access";

describe("Разбор вопросов на русском (FR-4)", () => {
  it("узнаёт брифинг", () => {
    assert.equal(parseIntent("брифинг").kind, "briefing");
    assert.equal(parseIntent("что за ночь произошло").kind, "briefing");
  });

  it("узнаёт просрочку", () => {
    assert.equal(parseIntent("что просрочено").kind, "overdue");
  });

  it("узнаёт простой автоматов", () => {
    assert.equal(parseIntent("какие автоматы простаивают").kind, "machines");
  });

  it("«сколько должен Olma» — это поиск контрагента, а не общая просрочка", () => {
    const intent = parseIntent("сколько должен Olma");
    assert.equal(intent.kind, "search");
    if (intent.kind === "search") assert.match(intent.query, /Olma/i);
  });

  it("узнаёт направление по слову", () => {
    const intent = parseIntent("обязательства глоберент");
    assert.equal(intent.kind, "obligations");
    if (intent.kind === "obligations") assert.equal(intent.domain, "globerent");
  });

  it("непонятное уходит в unknown, а не падает", () => {
    assert.equal(parseIntent("абырвалг").kind, "unknown");
    assert.equal(parseIntent("").kind, "unknown");
  });
});

describe("Брифинг", () => {
  const base = {
    generatedAt: "2026-07-26T02:30:00Z",
    tz: "Asia/Tashkent",
    overdueMoney: 0,
    idleMachines: 0,
    pendingApprovals: 0,
    contractsDueSoon: 0,
  };

  it("когда всё спокойно — говорит об этом прямо", () => {
    const text = formatBriefing(base);
    assert.match(text, /Тревог нет/);
  });

  it("показывает только сработавшие тревоги", () => {
    const text = formatBriefing({ ...base, overdueMoney: 3, idleMachines: 2 });
    assert.match(text, /Просрочено платежей: 3/);
    assert.match(text, /Автоматы простаивают: 2/);
    assert.doesNotMatch(text, /Договоры на исходе: 0/);
  });

  it("строка закупа появляется, когда есть что заказать", () => {
    const text = formatBriefing(base, [], { positions: 3, costRounded: 84000 });
    assert.match(text, /🛒 К закупу: 3 поз\. на ~84\s?000 сум — «оформить закуп»/);
  });

  it("без закупа (0 позиций) строки нет", () => {
    assert.doesNotMatch(formatBriefing(base, [], { positions: 0, costRounded: 0 }), /К закупу/);
    assert.doesNotMatch(formatBriefing(base), /К закупу/);
  });

  it("время показывает в ташкентском поясе", () => {
    // 02:30 UTC = 07:30 в Ташкенте
    assert.match(formatBriefing(base), /07:30/);
  });

  it("до брифинга всегда положительное время в пределах суток", () => {
    const ms = msUntilBriefing(new Date("2026-07-26T10:00:00Z"));
    assert.ok(ms > 0 && ms <= 24 * 3600 * 1000, `получено ${ms}`);
  });
});

describe("Доступ к боту", () => {
  const coreStub = {
    briefing: async () => ({
      generatedAt: new Date().toISOString(),
      tz: "Asia/Tashkent",
      overdueMoney: 0,
      idleMachines: 0,
      pendingApprovals: 0,
      contractsDueSoon: 0,
    }),
    pendingApprovals: async () => [],
  } as unknown as HandlerDeps["core"];

  it("чужому чату не отвечает вовсе", async () => {
    const deps: HandlerDeps = {
      core: coreStub,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    };
    assert.equal(await handleMessage(999, "брифинг", deps), null);
  });

  it("своему отвечает", async () => {
    const deps: HandlerDeps = {
      core: coreStub,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    };
    const reply = await handleMessage(111, "брифинг", deps);
    assert.ok(reply && reply.text.length > 0);
  });

  it("при превышении частоты просит подождать", async () => {
    const deps: HandlerDeps = {
      core: coreStub,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(1, 60_000),
    };
    await handleMessage(111, "брифинг", deps, 1000);
    const second = await handleMessage(111, "брифинг", deps, 1001);
    assert.match(second?.text ?? "", /Слишком много/);
  });
});

describe("Кнопки согласования", () => {
  it("разбирает корректные данные кнопки", () => {
    const parsed = parseApprovalCallback("ap:approved:abc-123");
    assert.deepEqual(parsed, { decision: "approved", id: "abc-123" });
  });

  it("отклоняет подделанные и неполные данные", () => {
    assert.equal(parseApprovalCallback("ap:drop_table:1"), null);
    assert.equal(parseApprovalCallback("ap:approved"), null);
    assert.equal(parseApprovalCallback("мусор"), null);
    assert.equal(parseApprovalCallback("ap:approved:"), null);
  });
});
