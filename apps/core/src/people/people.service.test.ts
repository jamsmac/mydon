import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeUsername, usernameLinkEnabled } from "./people.service";

describe("PeopleService — безопасная привязка Telegram", () => {
  it("username-привязка выключена при отсутствующей или произвольной переменной", () => {
    assert.equal(usernameLinkEnabled(undefined), false);
    assert.equal(usernameLinkEnabled(""), false);
    assert.equal(usernameLinkEnabled("0"), false);
    assert.equal(usernameLinkEnabled("true"), false);
  });

  it("аварийный путь включается только явной единицей", () => {
    assert.equal(usernameLinkEnabled("1"), true);
  });

  it("username по-прежнему нормализуется для явно включённого аварийного пути", () => {
    assert.equal(normalizeUsername("  @Example_User "), "example_user");
  });
});
