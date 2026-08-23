import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { HealthController, storageIsHealthy } from "./health.controller";
import type { Db } from "./db/db.module";

function responseStub(): { response: Response; statuses: number[] } {
  const statuses: number[] = [];
  const response = {
    status(code: number) {
      statuses.push(code);
      return this;
    },
  } as unknown as Response;
  return { response, statuses };
}

describe("HealthController", () => {
  it("возвращает ok и оставляет HTTP 200, когда БД и диск отвечают", async (t) => {
    const previous = process.env.HEALTH_MIN_STORAGE_MB;
    process.env.HEALTH_MIN_STORAGE_MB = "0";
    t.after(() => {
      if (previous === undefined) delete process.env.HEALTH_MIN_STORAGE_MB;
      else process.env.HEALTH_MIN_STORAGE_MB = previous;
    });
    const db = { execute: async () => [] } as unknown as Db;
    const { response, statuses } = responseStub();

    const report = await new HealthController(db).check(response);

    assert.equal(report.status, "ok");
    assert.equal(report.dbOk, true);
    assert.ok(report.dbLatencyMs >= 0);
    assert.equal(report.storageOk, true);
    assert.ok(report.storageFreeMb >= 0);
    assert.deepEqual(statuses, []);
  });

  it("возвращает degraded и HTTP 503, когда БД недоступна", async () => {
    const db = {
      execute: async () => {
        throw new Error("db unavailable");
      },
    } as unknown as Db;
    const { response, statuses } = responseStub();

    const report = await new HealthController(db).check(response);

    assert.equal(report.status, "degraded");
    assert.equal(report.dbOk, false);
    assert.equal(report.dbLatencyMs, -1);
    assert.deepEqual(statuses, [HttpStatus.SERVICE_UNAVAILABLE]);
  });

  it("считает хранилище нездоровым при ошибке или остатке ниже порога", () => {
    assert.equal(storageIsHealthy(-1, 1024), false);
    assert.equal(storageIsHealthy(1023, 1024), false);
    assert.equal(storageIsHealthy(1024, 1024), true);
  });
});
