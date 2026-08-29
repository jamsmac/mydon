import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmBudgetDeniedError } from "@mydon/shared";
import { ask } from "./actions";

const mocks = vi.hoisted(() => ({
  answer: vi.fn(),
}));

vi.mock("@mydon/assistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mydon/assistant")>();
  return {
    ...actual,
    answer: mocks.answer,
    createContextSearch: () => vi.fn(),
  };
});
vi.mock("../../lib/assistant-core", () => ({ assistantCore: {} }));
vi.mock("../../lib/core", () => ({ coreWriteHeaders: () => ({}) }));

describe("ask", () => {
  beforeEach(() => vi.resetAllMocks());

  it("показывает денежный отказ ledger до общей ошибки Core", async () => {
    mocks.answer.mockRejectedValue(
      new LlmBudgetDeniedError("pause", "дневной лимит исчерпан", {
        day: "2026-08-29",
        globalCapUsd: 5,
        globalExposureUsd: 5,
        remainingUsd: 0,
      }),
    );

    await expect(ask("неизвестный вопрос", "request-12345678")).resolves.toEqual({
      text: "Платный ИИ-запрос не выполнен: дневной лимит исчерпан",
    });
  });
});
