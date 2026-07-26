import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PgExceptionFilter } from "./pg-exception.filter";

function fakeHost() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return {
    captured,
    host: { switchToHttp: () => ({ getResponse: () => res }) } as never,
  };
}

describe("Обработка ошибок СУБД", () => {
  const filter = new PgExceptionFilter();
  // Заглушаем логгер, чтобы вывод тестов не засорялся ожидаемыми ошибками.
  mock.method(filter["logger"], "error", () => undefined);
  mock.method(filter["logger"], "warn", () => undefined);

  it("ошибку данных (класс 22) превращает в 400, а не в 500", () => {
    const { host, captured } = fakeHost();
    filter.catch({ code: "22021", message: "invalid byte sequence" }, host);
    assert.equal(captured.status, 400);
  });

  it("находит код в обёртке Drizzle (cause)", () => {
    const { host, captured } = fakeHost();
    filter.catch({ message: "Failed query", cause: { code: "22008" } }, host);
    assert.equal(captured.status, 400);
  });

  it("нарушение целостности (класс 23) — тоже 400", () => {
    const { host, captured } = fakeHost();
    filter.catch({ code: "23505" }, host);
    assert.equal(captured.status, 400);
  });

  it("настоящий сбой остаётся 500 и без подробностей наружу", () => {
    const { host, captured } = fakeHost();
    filter.catch(new Error("что-то сломалось внутри"), host);
    assert.equal(captured.status, 500);
    assert.equal(JSON.stringify(captured.body).includes("сломалось"), false);
  });

  it("не трогает обычные ошибки NestJS", () => {
    const { host, captured } = fakeHost();
    filter.catch(new NotFoundException("не найдено"), host);
    assert.equal(captured.status, 404);

    const second = fakeHost();
    filter.catch(new BadRequestException("плохой запрос"), second.host);
    assert.equal(second.captured.status, 400);
  });

  it("не зацикливается на самоссылающейся ошибке", () => {
    const { host, captured } = fakeHost();
    const loop: Record<string, unknown> = {};
    loop.cause = loop;
    filter.catch(loop, host);
    assert.equal(captured.status, 500);
  });
});
