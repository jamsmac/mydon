import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import type { Db } from "../db/db.module";
import { OwnerMutationGuard } from "./owner-mutation.guard";

function fakeDb(rows: { key: string; value: string }[] = []): Db {
  return { select: () => ({ from: () => Promise.resolve(rows) }) } as unknown as Db;
}

function ctx(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

const KEY = "OWNER_IDENTITY_ENFORCED";

describe("OwnerMutationGuard", () => {
  const prevFlag = process.env.OWNER_IDENTITY_ENFORCED;
  const prevOwner = process.env.OWNER_ACTION_TOKEN;
  const prevService = process.env.SERVICE_TOKEN;
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.OWNER_IDENTITY_ENFORCED;
    else process.env.OWNER_IDENTITY_ENFORCED = prevFlag;
    if (prevOwner === undefined) delete process.env.OWNER_ACTION_TOKEN;
    else process.env.OWNER_ACTION_TOKEN = prevOwner;
    if (prevService === undefined) delete process.env.SERVICE_TOKEN;
    else process.env.SERVICE_TOKEN = prevService;
  });

  it("флаг выключен (по умолчанию) — пропускает без owner-токена: прод не меняется", async () => {
    delete process.env.OWNER_IDENTITY_ENFORCED;
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    const guard = new OwnerMutationGuard(fakeDb());
    assert.equal(await guard.canActivate(ctx()), true);
  });

  it("флаг включён + нет owner-токена — отвергает", async () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    const guard = new OwnerMutationGuard(fakeDb([{ key: KEY, value: "1" }]));
    await assert.rejects(
      () => guard.canActivate(ctx({ "x-service-token": "shared" })),
      /токен действия/,
    );
  });

  it("флаг включён + верный owner-токен — пропускает", async () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    const guard = new OwnerMutationGuard(fakeDb([{ key: KEY, value: "1" }]));
    assert.equal(
      await guard.canActivate(ctx({ "x-owner-action-token": "owner-secret" })),
      true,
    );
  });

  it("env='0' поверх базы='1' — kill-switch, снова пропускает (R-P5-6)", async () => {
    process.env.OWNER_IDENTITY_ENFORCED = "0";
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    const guard = new OwnerMutationGuard(fakeDb([{ key: KEY, value: "1" }]));
    assert.equal(await guard.canActivate(ctx()), true);
  });
});
