import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { OwnerActionGuard } from "./owner-action.guard";

function context(headers: Record<string, string> = {}) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as Parameters<OwnerActionGuard["canActivate"]>[0];
}

describe("OwnerActionGuard", () => {
  const previous = process.env.OWNER_ACTION_TOKEN;
  const previousService = process.env.SERVICE_TOKEN;
  afterEach(() => {
    if (previous === undefined) delete process.env.OWNER_ACTION_TOKEN;
    else process.env.OWNER_ACTION_TOKEN = previous;
    if (previousService === undefined) delete process.env.SERVICE_TOKEN;
    else process.env.SERVICE_TOKEN = previousService;
  });

  it("fail-closed без отдельного owner token", () => {
    delete process.env.OWNER_ACTION_TOKEN;
    assert.throws(() => new OwnerActionGuard().canActivate(context()), /токен действия владельца/);
  });

  it("не принимает общий service token или неверный owner token", () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    assert.throws(
      () =>
        new OwnerActionGuard().canActivate(
          context({ "x-service-token": "shared", "x-owner-action-token": "wrong" }),
        ),
      /токен действия владельца/,
    );
  });

  it("fail-closed, если owner token ошибочно равен общему service token", () => {
    process.env.SERVICE_TOKEN = "same-secret";
    process.env.OWNER_ACTION_TOKEN = "same-secret";
    assert.throws(
      () =>
        new OwnerActionGuard().canActivate(
          context({ "x-service-token": "same-secret", "x-owner-action-token": "same-secret" }),
        ),
      /токен действия владельца/,
    );
  });

  it("принимает только точный x-owner-action-token", () => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
    assert.equal(
      new OwnerActionGuard().canActivate(
        context({ "x-service-token": "shared", "x-owner-action-token": "owner-secret" }),
      ),
      true,
    );
  });
});
