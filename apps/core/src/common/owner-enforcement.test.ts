import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Request } from "express";
import type { Db } from "../db/db.module";
import { isOwnerIdentityEnforced, ownerTokenValid } from "./owner-enforcement";

/** Мини-заглушка Db: settingValue делает ровно `select().from(systemConfig)`. */
function fakeDb(rows: { key: string; value: string }[] = []): Db {
  return { select: () => ({ from: () => Promise.resolve(rows) }) } as unknown as Db;
}

function req(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

const KEY = "OWNER_IDENTITY_ENFORCED";

describe("ownerTokenValid", () => {
  const prevOwner = process.env.OWNER_ACTION_TOKEN;
  const prevService = process.env.SERVICE_TOKEN;
  afterEach(() => {
    if (prevOwner === undefined) delete process.env.OWNER_ACTION_TOKEN;
    else process.env.OWNER_ACTION_TOKEN = prevOwner;
    if (prevService === undefined) delete process.env.SERVICE_TOKEN;
    else process.env.SERVICE_TOKEN = prevService;
  });

  it("отвергает пустой и общий SERVICE_TOKEN (R-P5-2)", () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    assert.equal(ownerTokenValid(req()), false);
    assert.equal(ownerTokenValid(req({ "x-owner-action-token": "shared" })), false);
    assert.equal(ownerTokenValid(req({ "x-owner-action-token": "wrong" })), false);
  });

  it("fails closed, когда owner-токен равен общему SERVICE_TOKEN", () => {
    process.env.SERVICE_TOKEN = "same";
    process.env.OWNER_ACTION_TOKEN = "same";
    assert.equal(ownerTokenValid(req({ "x-owner-action-token": "same" })), false);
  });

  it("пропускает только точный x-owner-action-token", () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    assert.equal(ownerTokenValid(req({ "x-owner-action-token": "owner-secret" })), true);
  });
});

describe("isOwnerIdentityEnforced", () => {
  const prev = process.env.OWNER_IDENTITY_ENFORCED;
  afterEach(() => {
    if (prev === undefined) delete process.env.OWNER_IDENTITY_ENFORCED;
    else process.env.OWNER_IDENTITY_ENFORCED = prev;
  });

  it("по умолчанию ВЫКЛЮЧЕНО (ни env, ни база) — мерж не меняет поведение", async () => {
    delete process.env.OWNER_IDENTITY_ENFORCED;
    assert.equal(await isOwnerIdentityEnforced(fakeDb()), false);
  });

  it("включается из базы (панель)", async () => {
    delete process.env.OWNER_IDENTITY_ENFORCED;
    assert.equal(await isOwnerIdentityEnforced(fakeDb([{ key: KEY, value: "1" }])), true);
  });

  it("включается из env", async () => {
    process.env.OWNER_IDENTITY_ENFORCED = "1";
    assert.equal(await isOwnerIdentityEnforced(fakeDb()), true);
  });

  it("env='0' — аварийный kill-switch: выключает всегда, даже если база='1' (R-P5-6)", async () => {
    process.env.OWNER_IDENTITY_ENFORCED = "0";
    assert.equal(await isOwnerIdentityEnforced(fakeDb([{ key: KEY, value: "1" }])), false);
  });
});
