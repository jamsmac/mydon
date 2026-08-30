import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  systemConfig: vi.fn(),
  llmLedgerMonitoring: vi.fn(),
}));

vi.mock("../../lib/core", () => ({
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
  core: {
    systemConfig: mocks.systemConfig,
    llmLedgerMonitoring: mocks.llmLedgerMonitoring,
  },
}));

vi.mock("../../components/llm-settings", () => ({
  LlmSettings: () => <div>Настройки LLM доступны</div>,
}));

vi.mock("../../components/system-editor", () => ({
  SystemEditor: () => <div>Остальные настройки доступны</div>,
}));

import SystemPage from "./page";

describe("страница «Система»", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("не скрывает настройки, если отдельно недоступен LLM-мониторинг", async () => {
    mocks.systemConfig.mockResolvedValue([]);
    mocks.llmLedgerMonitoring.mockRejectedValue(new Error("ledger timeout"));

    render(await SystemPage());

    expect(mocks.systemConfig).toHaveBeenCalledOnce();
    expect(mocks.llmLedgerMonitoring).toHaveBeenCalledOnce();
    expect(screen.getByText("Настройки LLM доступны")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("LLM-мониторинг: не проверили");
  });
});
