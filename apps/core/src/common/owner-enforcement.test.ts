import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Request } from "express";
import type { Db } from "../db/db.module";
import {
  excludePersonal,
  isOwnerIdentityEnforced,
  ownerTokenValid,
  personalVisible,
} from "./owner-enforcement";

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

/**
 * ЕДИНЫЙ источник видимости личного контура (R-P5-7b): personalVisible и его
 * отрицание excludePersonal. Все закрытые поверхности (tasks/entities/registry)
 * выводят гейт отсюда, поэтому эти три состояния — контракт всего среза.
 */
describe("personalVisible / excludePersonal (единый источник)", () => {
  const prevOwner = process.env.OWNER_ACTION_TOKEN;
  const prevService = process.env.SERVICE_TOKEN;
  const prevEnforced = process.env.OWNER_IDENTITY_ENFORCED;
  afterEach(() => {
    for (const [k, v] of [
      ["OWNER_ACTION_TOKEN", prevOwner],
      ["SERVICE_TOKEN", prevService],
      ["OWNER_IDENTITY_ENFORCED", prevEnforced],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const ownerReq = () => req({ "x-owner-action-token": "owner-secret" });
  const botReq = () => req({ "x-service-token": "shared" });

  function armTokens(): void {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
  }

  it("флаг ВЫКЛ → personal виден всем, excludePersonal=false (как сегодня)", async () => {
    delete process.env.OWNER_IDENTITY_ENFORCED;
    armTokens();
    const db = fakeDb();
    // Ни owner, ни бот не меняют картину, пока ужесточение выключено.
    assert.equal(await personalVisible(botReq(), db), true);
    assert.equal(await excludePersonal(botReq(), db), false);
    assert.equal(await personalVisible(ownerReq(), db), true);
    assert.equal(await excludePersonal(ownerReq(), db), false);
  });

  it("флаг ВКЛ + owner-токен → personal ВХОДИТ (владелец видит своё)", async () => {
    armTokens();
    const db = fakeDb([{ key: KEY, value: "1" }]);
    assert.equal(await personalVisible(ownerReq(), db), true);
    assert.equal(await excludePersonal(ownerReq(), db), false);
  });

  it("флаг ВКЛ + не-owner (бот/сервис-токен) → personal СКРЫТ", async () => {
    armTokens();
    const db = fakeDb([{ key: KEY, value: "1" }]);
    assert.equal(await personalVisible(botReq(), db), false);
    assert.equal(await excludePersonal(botReq(), db), true);
  });

  it("excludePersonal — строго отрицание personalVisible во всех состояниях", async () => {
    armTokens();
    for (const rows of [[], [{ key: KEY, value: "1" }]]) {
      for (const r of [ownerReq(), botReq(), req()]) {
        const db = fakeDb(rows);
        const vis = await personalVisible(r, db);
        const excl = await excludePersonal(r, db);
        assert.equal(excl, !vis);
      }
    }
  });
});
