import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { personIdOf } from "./actions.service";

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
