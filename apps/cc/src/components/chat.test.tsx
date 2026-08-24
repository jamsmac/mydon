import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./chat";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
}));

vi.mock("../app/assistant/actions", () => ({
  ask: mocks.ask,
}));

describe("чат помощника", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("отправляет вопрос и показывает ответ с переходом к согласованию", async () => {
    mocks.ask.mockResolvedValue({ text: "Нужно твоё решение", approvalId: "approval-1" });
    const user = userEvent.setup();
    render(<Chat />);

    await user.type(screen.getByLabelText("Вопрос помощнику"), "Что оплатить сегодня?");
    await user.click(screen.getByRole("button", { name: "→" }));

    expect(mocks.ask).toHaveBeenCalledWith("Что оплатить сегодня?");
    expect(await screen.findByText("Нужно твоё решение")).toBeVisible();
    expect(screen.getByRole("link", { name: /Открыть очередь решений/ })).toHaveAttribute(
      "href",
      "/approvals",
    );
  });

  it("показывает понятную ошибку при сетевом сбое", async () => {
    mocks.ask.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(<Chat />);

    await user.type(screen.getByLabelText("Вопрос помощнику"), "брифинг");
    await user.click(screen.getByRole("button", { name: "→" }));

    expect(await screen.findByText("Помощник не ответил — попробуй ещё раз.")).toBeVisible();
  });
});
