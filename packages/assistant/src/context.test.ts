import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyToHits, mergeHits, notesToHits } from "./context";
import { answer, type AssistantCore, type ContextHit, type LlmSnapshot } from "./index";

// Память помощника: то, что нашлось в прошлых разговорах, должно доехать до
// модели — иначе MYDON снова предложит уже решённое.

describe("Память: разбор ответов Core", () => {
  it("заметки → выдержки, заголовок становится источником", () => {
    const hits = notesToHits([{ title: "[Cowork] Решения по VendHub", body: "Договорились не менять поставщика." }]);
    assert.deepEqual(hits, [
      { kind: "знание", where: "[Cowork] Решения по VendHub", text: "Договорились не менять поставщика." },
    ]);
  });

  it("заметка без заголовка и пустая заметка не ломают разбор", () => {
    const hits = notesToHits([{ body: "текст без заголовка" }, { body: "" }, null, "мусор"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].where, "заметка");
  });

  it("история → выдержки, «где» = проект, иначе заголовок разговора", () => {
    const hits = historyToHits({
      hits: [
        { project: "mydon", title: "Аудит", text: "OLMA дебиторка 79%" },
        { project: null, title: "Разбор рисков", text: "решили считать по-другому" },
      ],
    });
    assert.deepEqual(
      hits.map((h) => h.where),
      ["mydon", "Разбор рисков"],
    );
    assert.ok(hits.every((h) => h.kind === "разговор"));
  });

  it("не настроенный или пустой ответ истории → пусто, без исключений", () => {
    assert.deepEqual(historyToHits({ configured: false, hits: [] }), []);
    assert.deepEqual(historyToHits(null), []);
    assert.deepEqual(notesToHits({ message: "ошибка" }), []);
  });

  it("длинный текст обрезается — заметка может быть на 20 000 знаков", () => {
    const [hit] = notesToHits([{ title: "т", body: "я".repeat(5000) }]);
    assert.ok(hit.text.length < 600, `слишком длинно: ${hit.text.length}`);
    assert.ok(hit.text.endsWith("…"));
  });
});

describe("Память: смешивание источников", () => {
  const note = (i: number): ContextHit => ({ kind: "знание", where: `з${i}`, text: `знание ${i}` });
  const talk = (i: number): ContextHit => ({ kind: "разговор", where: `р${i}`, text: `разговор ${i}` });

  it("истории оставлено место, даже когда заметок много", () => {
    const merged = mergeHits([note(1), note(2), note(3), note(4), note(5), note(6)], [talk(1), talk(2)], 6);
    assert.equal(merged.length, 6);
    assert.ok(
      merged.some((h) => h.kind === "разговор"),
      "разговоры полностью вытеснены заметками",
    );
  });

  it("нет заметок — берём историю; нет истории — берём заметки", () => {
    assert.equal(mergeHits([], [talk(1), talk(2)], 6).length, 2);
    assert.equal(mergeHits([note(1), note(2), note(3)], [], 6).length, 3);
  });

  it("лимит соблюдается — контекст не резиновый", () => {
    const merged = mergeHits([note(1), note(2), note(3)], [talk(1), talk(2), talk(3)], 4);
    assert.equal(merged.length, 4);
  });
});

// ── Ядро: контекст доезжает до модели ────────────────────────────────────────

const core: AssistantCore = {
  briefing: async () => ({ overdueMoney: 0, idleMachines: 0, pendingApprovals: 0, contractsDueSoon: 0 }),
  pendingApprovals: async () => [],
  obligations: async () => ({ totals: [], overdue: [] }),
  searchEntities: async () => [],
  recent: async () => [],
};

describe("Помощник: память в снимке", () => {
  it("найденное попадает в снимок для модели", async () => {
    const seen: LlmSnapshot[] = [];
    await answer("что мы решали по кофейне", core, {
      llm: async (_q, snapshot) => {
        seen.push(snapshot);
        return { kind: "answer", text: "ок" };
      },
      context: async () => [{ kind: "знание", where: "Решения", text: "поставщика не меняем" }],
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].context, [{ kind: "знание", where: "Решения", text: "поставщика не меняем" }]);
  });

  it("поиск упал — помощник всё равно отвечает (память не критична)", async () => {
    const reply = await answer("непонятный вопрос", core, {
      llm: async (_q, snapshot) => {
        assert.equal(snapshot.context, undefined, "пустой контекст не должен попадать в снимок");
        return { kind: "answer", text: "ответил без памяти" };
      },
      context: async () => {
        throw new Error("индекс недоступен");
      },
    });
    assert.equal(reply.text, "ответил без памяти");
  });

  it("на понятный правилами вопрос память не запрашивается — лишних запросов нет", async () => {
    let called = false;
    await answer("брифинг", core, {
      llm: async () => ({ kind: "none" }),
      context: async () => {
        called = true;
        return [];
      },
    });
    assert.equal(called, false);
  });
});
