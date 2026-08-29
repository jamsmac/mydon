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

  it("fails closed without a separate owner token", () => {
    delete process.env.OWNER_ACTION_TOKEN;
    assert.throws(() => new OwnerActionGuard().canActivate(context()), /токен действия владельца/);
  });

  it("rejects the shared service token and an incorrect owner token", () => {
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

  it("fails closed when the owner token equals the shared service token", () => {
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

  it("accepts only an exact x-owner-action-token", () => {
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
