import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "../lib/core";
import { ApprovalCard } from "./approval-card";

const mocks = vi.hoisted(() => ({
  decideApproval: vi.fn(),
}));

vi.mock("../app/actions", () => ({
  decideApproval: mocks.decideApproval,
}));

const approval: Approval = {
  id: "approval-1",
  agent: "finance",
  action: "Провести платёж",
  tier: "T3",
  decision: "pending",
  createdAt: "2026-08-24T00:00:00.000Z",
  decidedAt: null,
};

describe("ApprovalCard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("передаёт точное решение и фиксирует успешный результат", async () => {
    mocks.decideApproval.mockResolvedValue({ ok: true, message: "ok" });
    const user = userEvent.setup();
    render(<ApprovalCard item={approval} />);

    await user.click(screen.getByRole("button", { name: "Одобрить" }));

    expect(mocks.decideApproval).toHaveBeenCalledWith("approval-1", "approved");
    expect(await screen.findByText("Решение записано")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Одобрить" })).not.toBeInTheDocument();
  });

  it("показывает бизнес-ошибку вместо ложного успеха", async () => {
    mocks.decideApproval.mockResolvedValue({ ok: false, message: "Решение уже принято" });
    const user = userEvent.setup();
    render(<ApprovalCard item={approval} />);

    await user.click(screen.getByRole("button", { name: "Отклонить" }));

    expect(mocks.decideApproval).toHaveBeenCalledWith("approval-1", "rejected");
    expect(await screen.findByText("Решение уже принято")).toBeVisible();
  });

  it("объясняет сетевой сбой server action", async () => {
    mocks.decideApproval.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(<ApprovalCard item={approval} />);

    await user.click(screen.getByRole("button", { name: "Уточнить" }));

    expect(await screen.findByText(/Сервер не ответил/)).toBeVisible();
  });
});
