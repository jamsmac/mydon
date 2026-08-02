import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXECUTORS } from "./executors";
import type { AgentDefinition } from "./registry";
import type { Proposal } from "./skills";

const agent: AgentDefinition = {
  name: "chief-of-staff",
  business: "mydon",
  status: "active",
  autonomyDefault: "T0",
  schedule: [],
  skills: ["morning-digest"],
  dir: "(test)",
};

const proposal: Proposal = {
  action: "Разобрать за день: просрочено платежей: 2; автоматы простаивают: 1.",
  facts: { overdueMoney: 2, idleMachines: 1 },
};

/**
 * Фейковый Core с семантикой notes: createNote делает upsert по заголовку,
 * findNotes ищет по вхождению строки — как настоящий /notes.
 */
function fakeNotesCore() {
  const store = new Map<string, { id: string; title: string | null; body: string }>();
  let seq = 0;
  const calls: string[] = [];
  const core = {
    createNote: async (input: { title?: string; body: string; tags?: string[] }) => {
      calls.push("createNote");
      const key = input.title ?? `__untitled_${(seq += 1)}`;
      const existing = store.get(key);
      const row = { id: existing?.id ?? `note-${(seq += 1)}`, title: input.title ?? null, body: input.body };
      store.set(key, row);
      return row;
    },
    findNotes: async (q: string) => {
      calls.push("findNotes");
      return [...store.values()].filter((n) => (n.title ?? "").includes(q) || n.body.includes(q));
    },
  };
  return { core, calls, store };
}

const morningDigest = EXECUTORS["morning-digest"];

describe("Исполнитель morning-digest → заметка", () => {
  it("зарегистрирован в реестре исполнителей", () => {
    assert.equal(typeof morningDigest, "function");
  });

  it("записывает заметку и подтверждает перечиткой (ok=true)", async () => {
    const { core, calls, store } = fakeNotesCore();
    const res = await morningDigest(agent, proposal, core as never);

    assert.equal(res.ok, true);
    assert.match(res.detail, /подтверждена перечиткой/);
    // Сначала запись, потом НЕЗАВИСИМАЯ перечитка — порядок из контракта.
    assert.deepEqual(calls, ["createNote", "findNotes"]);
    assert.equal(store.size, 1, "ровно одна заметка");

    const saved = [...store.values()][0];
    assert.match(saved.title ?? "", /Утренняя сводка/);
    assert.match(saved.body, /Разобрать за день/, "тело содержит предложение агента");
    assert.match(saved.body, /overdueMoney: 2/, "тело содержит факты, на которых оно построено");
  });

  it("идемпотентно: повторный прогон за те же сутки не плодит дубли", async () => {
    const { core, store } = fakeNotesCore();
    const a = await morningDigest(agent, proposal, core as never);
    const b = await morningDigest(agent, proposal, core as never);

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(store.size, 1, "заголовок один на сутки — upsert, а не вставка");
  });

  it("перечитка вернула другое тело — ok=false, не выдаём за сделанное", async () => {
    const { store } = fakeNotesCore();
    // Пишем в store, но перечитка отдаёт испорченное тело: результат не подтверждён.
    const core = {
      createNote: async (input: { title?: string; body: string }) => {
        const row = { id: "n1", title: input.title ?? null, body: input.body };
        store.set(input.title ?? "", row);
        return row;
      },
      findNotes: async (q: string) =>
        [...store.values()]
          .filter((n) => (n.title ?? "").includes(q))
          .map((n) => ({ ...n, body: `${n.body} ИСПОРЧЕНО` })),
    };
    const res = await morningDigest(agent, proposal, core as never);
    assert.equal(res.ok, false);
    assert.match(res.detail, /не удалось подтвердить/);
  });

  it("перечитка пуста (заметки нет) — ok=false", async () => {
    const core = {
      createNote: async () => ({ id: "n1", title: "x", body: "x" }),
      findNotes: async () => [],
    };
    const res = await morningDigest(agent, proposal, core as never);
    assert.equal(res.ok, false);
  });
});
