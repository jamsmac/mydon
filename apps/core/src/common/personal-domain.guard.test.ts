import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import type { Db } from "../db/db.module";
import { PersonalDomainGuard } from "./personal-domain.guard";

function fakeDb(rows: { key: string; value: string }[] = []): Db {
  return { select: () => ({ from: () => Promise.resolve(rows) }) } as unknown as Db;
}

interface ReqShape {
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

function ctx(r: ReqShape = {}): ExecutionContext {
  const request = {
    headers: r.headers ?? {},
    params: r.params ?? {},
    query: r.query ?? {},
    body: r.body,
  };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

const KEY = "OWNER_IDENTITY_ENFORCED";
const ON = [{ key: KEY, value: "1" }];

describe("PersonalDomainGuard", () => {
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

  it("не-personal домен — пропускает даже при включённом флаге (прочие домены не трогаем)", async () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    const guard = new PersonalDomainGuard(fakeDb(ON));
    assert.equal(await guard.canActivate(ctx({ params: { domain: "vendhub" } })), true);
    assert.equal(await guard.canActivate(ctx({ query: { domain: "globerent" } })), true);
    assert.equal(await guard.canActivate(ctx()), true);
  });

  it("personal + флаг выключен (по умолчанию) — пропускает как сегодня", async () => {
    delete process.env.OWNER_IDENTITY_ENFORCED;
    const guard = new PersonalDomainGuard(fakeDb());
    assert.equal(await guard.canActivate(ctx({ params: { domain: "personal" } })), true);
  });

  it("personal + флаг включён + нет owner-токена — честный 403", async () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    const guard = new PersonalDomainGuard(fakeDb(ON));
    await assert.rejects(
      () => guard.canActivate(ctx({ params: { domain: "personal" } })),
      /Личный контур/,
    );
  });

  it("personal из query и из body тоже гейтится при включённом флаге", async () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    const guard = new PersonalDomainGuard(fakeDb(ON));
    await assert.rejects(() => guard.canActivate(ctx({ query: { domain: "personal" } })), /Личный контур/);
    await assert.rejects(() => guard.canActivate(ctx({ body: { domain: "personal" } })), /Личный контур/);
  });

  it("personal + флаг включён + верный owner-токен — пропускает", async () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    const guard = new PersonalDomainGuard(fakeDb(ON));
    assert.equal(
      await guard.canActivate(
        ctx({ params: { domain: "personal" }, headers: { "x-owner-action-token": "owner-secret" } }),
      ),
      true,
    );
  });
});
