import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { SystemOwnerGuard } from "../common/system-owner.guard";
import { SetLlmProfileDto, SystemController } from "./system.controller";

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

async function validateBody(body: unknown): Promise<SetLlmProfileDto> {
  return pipe.transform(body, { type: "body", metatype: SetLlmProfileDto, data: "" });
}

describe("PUT /system/config/llm-profile DTO", () => {
  it("принимает пачку несекретных профильных полей", async () => {
    const dto = await validateBody({
      items: [
        { key: "LLM_ENABLED", value: "1" },
        { key: "LLM_ROUTE", value: "openai-api" },
        { key: "LLM_MODEL", value: "gpt-5.6-sol" },
        { key: "LLM_FALLBACK_MODELS", value: "" },
        { key: "LLM_BASE_URL", value: "https://api.openai.com/v1" },
        { key: "LLM_PRICE_PROVIDER_ID", value: "openai" },
        { key: "LLM_GLOBAL_DAILY_BUDGET_USD", value: "10" },
        { key: "LLM_MAX_RESERVATION_USD", value: "3" },
      ],
      updatedBy: "owner:panel",
    });
    assert.equal(dto.items.length, 8);
    assert.equal(dto.items[1]?.key, "LLM_ROUTE");
  });

  it("отклоняет API-ключ, чужой config key и лишнее nested-поле", async () => {
    for (const item of [
      { key: "LLM_API_KEY", value: "sk-secret" },
      { key: "AGENT_DAILY_BUDGET_USD", value: "3" },
      { key: "LLM_MODEL", value: "gpt-5.6-sol", secret: "x" },
    ]) {
      await assert.rejects(() => validateBody({ items: [item] }));
    }
  });

  it("отклоняет пустую пачку и дубликаты ключа", async () => {
    await assert.rejects(() => validateBody({ items: [] }));
    await assert.rejects(() =>
      validateBody({
        items: [
          { key: "LLM_MODEL", value: "gpt-5.6-sol" },
          { key: "LLM_MODEL", value: "gpt-5.6-sol" },
        ],
      }),
    );
  });
});

// Пинним САМ фикс (аудит-дыра #1, серверная сторона): оба мутирующих PUT
// должны нести `@UseGuards(SystemOwnerGuard)` на дескрипторе метода. Guard-юниты
// проверяют класс в изоляции, DTO-тесты — валидацию, CC-тесты — что панель шлёт
// заголовок; ни один не ловит СНЯТИЕ декоратора с контроллера. Читаем guard-
// метадату (NestJS кладёт её ключом GUARDS_METADATA на функцию метода): удали
// любой из двух `@UseGuards` — и ровно этот тест краснеет.
describe("SystemController: guard навешан на мутациях", () => {
  for (const method of ["set", "setLlmProfile"] as const) {
    it(`PUT ${method} закрыт SystemOwnerGuard`, () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        SystemController.prototype[method],
      ) as unknown[] | undefined;
      assert.ok(guards, `нет guard-метадаты на ${method} — декоратор снят`);
      assert.ok(
        guards.includes(SystemOwnerGuard),
        `SystemOwnerGuard не навешан на ${method}`,
      );
    });
  }
});
