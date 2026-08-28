import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { personIdOf, type ActionRow } from "./actions.service";

describe("Лента действий: разбор автора", () => {
  it("person:/staff: дают uuid, всё прочее — null", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(personIdOf(`person:${id}`), id);
    assert.equal(personIdOf(`staff:${id}`), id);
    assert.equal(personIdOf("owner"), null, "действия владельца — не полевая лента");
    assert.equal(personIdOf("agent:vendhub"), null);
    assert.equal(personIdOf("import:telegram"), null);
    assert.equal(personIdOf(null), null);
    assert.equal(personIdOf("person:не-uuid"), null);
  });
});

describe("Лента действий: приёмка работы (П7)", () => {
  it("task_confirmed существует рядом с task_done", () => {
    const kinds: ActionRow["kind"][] = ["task_done", "task_confirmed"];
    assert.equal(new Set(kinds).size, 2);
  });

  it("автор приёмки разбирается тем же personIdOf", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(personIdOf(`person:${id}`), id);
    assert.equal(personIdOf("owner"), null);
  });
});
