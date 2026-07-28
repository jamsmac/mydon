import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUserContent, createLlmResolver, mapToResolution } from "./llm";
import type { LlmSnapshot } from "./index";

// Тестируем самое рисковое место LLM-слоя — разбор ответа модели в намерение.
// Сам вызов Claude тонкий (SDK) и проверяется вживую после ввода ключа.

describe("LLM: разбор ответа модели в намерение", () => {
  it("простые действия → одноимённые намерения", () => {
    for (const action of ["briefing", "approvals", "overdue", "machines", "recent"] as const) {
      const r = mapToResolution({ action });
      assert.equal(r.kind, "intent");
      if (r.kind === "intent") assert.equal(r.intent.kind, action);
    }
  });

  it("obligations с направлением → obligations, без направления → none (не отвечаем на другой вопрос)", () => {
    const withDomain = mapToResolution({ action: "obligations", domain: "vendhub" });
    assert.deepEqual(withDomain, { kind: "intent", intent: { kind: "obligations", domain: "vendhub" } });
    const noDomain = mapToResolution({ action: "obligations" });
    assert.equal(noDomain.kind, "none");
  });

  it("несуществующее направление → none, ничего не выдумываем и не подменяем вопрос", () => {
    const r = mapToResolution({ action: "obligations", domain: "марс" });
    assert.equal(r.kind, "none");
  });

  it("search: с запросом → поиск, пустой/короткий запрос → none", () => {
    const ok = mapToResolution({ action: "search", query: "Olma" });
    assert.deepEqual(ok, { kind: "intent", intent: { kind: "search", query: "Olma" } });
    assert.equal(mapToResolution({ action: "search", query: "" }).kind, "none");
    assert.equal(mapToResolution({ action: "search", query: "x" }).kind, "none");
  });

  it("search переносит направление, если модель его дала", () => {
    const r = mapToResolution({ action: "search", query: "CPCD30", domain: "globerent" });
    assert.deepEqual(r, {
      kind: "intent",
      intent: { kind: "search", query: "CPCD30", domain: "globerent" },
    });
  });

  it("answer с текстом → ответ словами, пустой ответ → none", () => {
    const ok = mapToResolution({ action: "answer", answer: "Тревог нет." });
    assert.deepEqual(ok, { kind: "answer", text: "Тревог нет." });
    assert.equal(mapToResolution({ action: "answer", answer: "   " }).kind, "none");
    assert.equal(mapToResolution({ action: "answer" }).kind, "none");
  });

  it("мусор и неизвестное действие → none (честно, без фантазий)", () => {
    assert.equal(mapToResolution({ action: "none" }).kind, "none");
    assert.equal(mapToResolution({ action: "выдумка" }).kind, "none");
    assert.equal(mapToResolution(null).kind, "none");
    assert.equal(mapToResolution("строка").kind, "none");
    assert.equal(mapToResolution({}).kind, "none");
  });
});

describe("LLM: заземление запроса", () => {
  const snapshot: LlmSnapshot = {
    briefing: { overdueMoney: 5, idleMachines: 2, pendingApprovals: 0, contractsDueSoon: 1, contractsBadDate: 2, overdueTasks: 3 },
    pendingApprovals: 4,
    recentLabels: ["ты одобрил", "агент попросил разрешения"],
    domains: "globerent, vendhub, personal",
  };

  it("вопрос и факты снимка попадают в запрос к модели", () => {
    const content = buildUserContent("когда мне платить?", snapshot);
    assert.match(content, /когда мне платить/);
    assert.match(content, /просрочено платежей: 5/);
    assert.match(content, /ждут решения: 4/);
    assert.match(content, /просроченных задач: 3/);
    assert.match(content, /ты одобрил; агент попросил разрешения/);
    assert.match(content, /globerent, vendhub/);
  });

  it("нераспознанные данные (contractsBadDate) видны модели — чтобы не заверяла «всё ок»", () => {
    const content = buildUserContent("всё в порядке с договорами?", snapshot);
    assert.match(content, /без распознанной даты.*: 2/);
  });

  it("пустой журнал показывается как «—», а не пусто", () => {
    const content = buildUserContent("что там", { ...snapshot, recentLabels: [] });
    assert.match(content, /последнее в системе: —/);
  });
});

describe("LLM: конструирование резолвера", () => {
  it("createLlmResolver возвращает функцию и не грузит SDK при вызове конструктора", () => {
    const before = Object.keys(require.cache).some((p) => p.includes("@anthropic-ai"));
    const resolver = createLlmResolver({ apiKey: "sk-ant-нет-сети" });
    assert.equal(typeof resolver, "function");
    const after = Object.keys(require.cache).some((p) => p.includes("@anthropic-ai"));
    // SDK ленив: конструктор резолвера его не тянет (важно для импорта без ключа).
    assert.equal(before, after);
  });
});
