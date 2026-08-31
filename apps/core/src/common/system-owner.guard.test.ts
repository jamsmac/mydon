import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SystemOwnerGuard } from "./system-owner.guard";

function context(headers: Record<string, string> = {}) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as Parameters<SystemOwnerGuard["canActivate"]>[0];
}

describe("SystemOwnerGuard", () => {
  const previousOwner = process.env.OWNER_ACTION_TOKEN;
  const previousService = process.env.SERVICE_TOKEN;
  const previousEnforced = process.env.OWNER_IDENTITY_ENFORCED;
  afterEach(() => {
    if (previousOwner === undefined) delete process.env.OWNER_ACTION_TOKEN;
    else process.env.OWNER_ACTION_TOKEN = previousOwner;
    if (previousService === undefined) delete process.env.SERVICE_TOKEN;
    else process.env.SERVICE_TOKEN = previousService;
    if (previousEnforced === undefined) delete process.env.OWNER_IDENTITY_ENFORCED;
    else process.env.OWNER_IDENTITY_ENFORCED = previousEnforced;
  });

  it("токен не задан → пропускает (как сегодня, только сервисный токен, merge-safe)", () => {
    delete process.env.OWNER_ACTION_TOKEN;
    process.env.SERVICE_TOKEN = "shared";
    // Даже без owner-заголовка guard не активен — путь закрыт лишь ServiceTokenGuard.
    assert.equal(new SystemOwnerGuard().canActivate(context()), true);
  });

  it("токен вырожден в общий сервисный → пропускает (нет отдельного пояса)", () => {
    process.env.SERVICE_TOKEN = "same-secret";
    process.env.OWNER_ACTION_TOKEN = "same-secret";
    assert.equal(
      new SystemOwnerGuard().canActivate(context({ "x-owner-action-token": "same-secret" })),
      true,
    );
  });

  it("токен задан, заголовка нет → отвергает", () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    assert.throws(() => new SystemOwnerGuard().canActivate(context()), /токен/);
  });

  it("токен задан, чужой/сервисный заголовок → отвергает", () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    assert.throws(
      () =>
        new SystemOwnerGuard().canActivate(
          context({ "x-service-token": "shared", "x-owner-action-token": "wrong" }),
        ),
      /токен/,
    );
  });

  it("токен задан, точный owner-заголовок → пропускает", () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    assert.equal(
      new SystemOwnerGuard().canActivate(context({ "x-owner-action-token": "owner-secret" })),
      true,
    );
  });

  // Ключевой инвариант против «кто охраняет охрану»: guard НЕ смотрит на
  // OWNER_IDENTITY_ENFORCED. Через /system можно выключить enforcement — и если бы
  // охват зависел от флага, guard исчез бы. Проверяем: при флаге "1" И "0"
  // поведение одинаково (owner-токен обязателен, коль скоро OWNER_ACTION_TOKEN задан).
  it("независим от OWNER_IDENTITY_ENFORCED: при вкл и выкл флаге guard одинаков", () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    for (const flag of ["1", "0"]) {
      process.env.OWNER_IDENTITY_ENFORCED = flag;
      // Без токена — отказ при любом значении флага.
      assert.throws(() => new SystemOwnerGuard().canActivate(context()), /токен/);
      // С точным токеном — проход при любом значении флага.
      assert.equal(
        new SystemOwnerGuard().canActivate(context({ "x-owner-action-token": "owner-secret" })),
        true,
      );
    }
  });
});
