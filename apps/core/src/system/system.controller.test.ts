import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationPipe } from "@nestjs/common";
import { SetLlmProfileDto } from "./system.controller";

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
