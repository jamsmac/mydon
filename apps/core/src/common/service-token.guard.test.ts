import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Reflector } from "@nestjs/core";
import { ServiceTokenGuard } from "./service-token.guard";
import { IS_PUBLIC } from "./public.decorator";

/** Собрать ExecutionContext с методом, заголовками и метаданными маршрута. */
function ctx(
  method: string,
  headers: Record<string, string> = {},
  isPublic = false,
): Parameters<ServiceTokenGuard["canActivate"]>[0] {
  const handler = (): void => undefined;
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC, true, handler);
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as Parameters<ServiceTokenGuard["canActivate"]>[0];
}

const guard = (): ServiceTokenGuard => new ServiceTokenGuard(new Reflector());

describe("ServiceTokenGuard: граница доступа Core", () => {
  const prev = process.env.SERVICE_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.SERVICE_TOKEN;
    else process.env.SERVICE_TOKEN = prev;
  });

  it("чтения (GET) пропускаются всегда", () => {
    process.env.SERVICE_TOKEN = "secret";
    assert.equal(guard().canActivate(ctx("GET")), true);
  });

  it("мутация без токена — отказ, когда токен задан", () => {
    process.env.SERVICE_TOKEN = "secret";
    assert.throws(() => guard().canActivate(ctx("POST")), /токен/);
  });

  it("мутация с верным токеном — проход", () => {
    process.env.SERVICE_TOKEN = "secret";
    assert.equal(guard().canActivate(ctx("POST", { "x-service-token": "secret" })), true);
  });

  it("мутация с неверным токеном — отказ", () => {
    process.env.SERVICE_TOKEN = "secret";
    assert.throws(() => guard().canActivate(ctx("PATCH", { "x-service-token": "wrong" })), /токен/);
  });

  it("Authorization: Bearer тоже принимается", () => {
    process.env.SERVICE_TOKEN = "secret";
    assert.equal(guard().canActivate(ctx("DELETE", { authorization: "Bearer secret" })), true);
  });

  it("публичный маршрут (своя дверь) — мимо guard даже на мутации", () => {
    process.env.SERVICE_TOKEN = "secret";
    assert.equal(guard().canActivate(ctx("POST", {}, true)), true);
  });

  it("токен не задан — мутации пропускаются (совместимый выкат)", () => {
    delete process.env.SERVICE_TOKEN;
    assert.equal(guard().canActivate(ctx("POST")), true);
  });
});
