import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectEnvExample } from "./check-env-example.mjs";

describe(".env.example: один ключ — одна строка", () => {
  it("находит повтор и отдаёт обе точные строки", () => {
    const result = inspectEnvExample(
      [
        "SAFE=1",
        "# STAFF_LINK_BY_USERNAME=1",
        "STAFF_LINK_BY_USERNAME=0",
        "",
        "STAFF_LINK_BY_USERNAME=1",
      ].join("\n"),
    );

    assert.deepEqual(result.duplicates, [["STAFF_LINK_BY_USERNAME", [3, 5]]]);
  });

  it("не считает комментарии и разные ключи дублями", () => {
    const result = inspectEnvExample("# DUPLICATE=old\nFIRST=1\nSECOND=2\n");

    assert.equal(result.uniqueCount, 2);
    assert.deepEqual(result.duplicates, []);
  });
});
