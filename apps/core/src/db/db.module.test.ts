import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DbModule, type Db } from "./db.module";

describe("DbModule shutdown", () => {
  it("закрывает postgres-клиент при завершении приложения", async (t) => {
    t.mock.method(console, "log", () => undefined);
    let endCalls = 0;
    const db = {
      $client: {
        end: async () => {
          endCalls += 1;
        },
      },
    } as unknown as Db;

    await new DbModule(db).onApplicationShutdown("SIGTERM");

    assert.equal(endCalls, 1);
  });
});
