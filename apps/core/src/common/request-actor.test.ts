import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defer, firstValueFrom } from "rxjs";
import { ACTOR_HEADER, RequestActorInterceptor, parseActorHeader, requestActor, runWithActor } from "./request-actor";

type Ctx = Parameters<RequestActorInterceptor["intercept"]>[0];
type Handler = Parameters<RequestActorInterceptor["intercept"]>[1];

function ctx(headers: Record<string, string | string[]>): Ctx {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as unknown as Ctx;
}

/**
 * Обработчик, который читает актора ПОСЛЕ await — как настоящий сервис с
 * транзакцией. `defer`, как у Nest: тело стартует при ПОДПИСКЕ, а не при вызове
 * handle(). С `from(promise)` тест прошёл бы и на реализации, оборачивающей в
 * контекст вызов handle(), но не подписку.
 */
function handlerReadingActorAfterAwait(): Handler {
  return {
    handle: () =>
      defer(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.resolve();
        return requestActor("owner");
      }),
  };
}

describe("parseActorHeader: мусор не становится автором", () => {
  it("принимает ссылки всех видов, что пишутся в журнал", () => {
    for (const ref of ["owner", "agent:claude-code", "person:0b6a3c1e-4f7d-4c2a-9b1e-2f3a4b5c6d7e", "tool:backfill", "a.b+c@mail.uz"]) {
      assert.equal(parseActorHeader(ref), ref);
    }
  });

  it("обрезает пробелы по краям", () => {
    assert.equal(parseActorHeader("  agent:claude-code  "), "agent:claude-code");
  });

  it("отбрасывает пустое, пробелы внутри, разметку и слишком длинное", () => {
    for (const bad of ["", "   ", "owner admin", "<b>owner</b>", "agent:x\nowner", "a".repeat(121)]) {
      assert.equal(parseActorHeader(bad), null, JSON.stringify(bad));
    }
  });

  it("повторённый заголовок — берётся первый", () => {
    assert.equal(parseActorHeader(["agent:claude-code", "owner"]), "agent:claude-code");
  });

  it("нет заголовка — null", () => {
    assert.equal(parseActorHeader(undefined), null);
  });
});

describe("requestActor: порядок «заголовок → прежнее умолчание»", () => {
  it("вне запроса — прежнее умолчание (кроны, бот без заголовка)", () => {
    assert.equal(requestActor("owner"), "owner");
    assert.equal(requestActor("panel"), "panel");
  });

  it("внутри запроса без заголовка — тоже прежнее умолчание", () => {
    assert.equal(runWithActor(null, () => requestActor("owner")), "owner");
  });

  it("внутри запроса с заголовком — актор из заголовка", () => {
    assert.equal(runWithActor("agent:claude-code", () => requestActor("owner")), "agent:claude-code");
  });
});

describe("RequestActorInterceptor: контекст переживает await в обработчике", () => {
  const interceptor = new RequestActorInterceptor();

  it("агент из заголовка виден сервису после нескольких await", async () => {
    const out = interceptor.intercept(ctx({ [ACTOR_HEADER]: "agent:claude-code" }), handlerReadingActorAfterAwait());
    assert.equal(await firstValueFrom(out), "agent:claude-code");
  });

  it("без заголовка сервис получает прежнее умолчание", async () => {
    const out = interceptor.intercept(ctx({}), handlerReadingActorAfterAwait());
    assert.equal(await firstValueFrom(out), "owner");
  });

  it("два параллельных запроса не видят актора друг друга", async () => {
    const [a, b] = await Promise.all([
      firstValueFrom(interceptor.intercept(ctx({ [ACTOR_HEADER]: "agent:claude-code" }), handlerReadingActorAfterAwait())),
      firstValueFrom(interceptor.intercept(ctx({ [ACTOR_HEADER]: "person:0b6a3c1e-4f7d-4c2a-9b1e-2f3a4b5c6d7e" }), handlerReadingActorAfterAwait())),
    ]);
    assert.equal(a, "agent:claude-code");
    assert.equal(b, "person:0b6a3c1e-4f7d-4c2a-9b1e-2f3a4b5c6d7e");
  });

  it("после запроса актор не утекает наружу", async () => {
    await firstValueFrom(interceptor.intercept(ctx({ [ACTOR_HEADER]: "agent:claude-code" }), handlerReadingActorAfterAwait()));
    assert.equal(requestActor("owner"), "owner");
  });
});
