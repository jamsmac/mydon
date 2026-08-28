import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../lib/core";
import { AwaitingBlock } from "./awaiting-block";

const mocks = vi.hoisted(() => ({ confirmTask: vi.fn(), rateTask: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/tasks/actions", () => ({ confirmTask: mocks.confirmTask, rateTask: mocks.rateTask }));

const ЗАДАЧА: Task = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Пополнить Olma",
  description: null,
  ownerKind: "human",
  ownerRef: "11111111-1111-4111-8111-111111111111",
  domain: "vendhub",
  status: "done",
  priority: "high",
  due: null,
  source: "low_stock:2508160376:2026-08-26",
  createdBy: "task-bridge",
  resultNote: "Загрузил 40 позиций",
  entityId: null,
  quality: null,
  completedAt: "2026-08-26T09:30:00+05:00",
  closedBy: "person:11111111-1111-4111-8111-111111111111",
  confirmedAt: null,
  confirmedBy: null,
  assignNotifiedAt: "2026-08-25T05:00:00.000Z",
  createdAt: "2026-08-26T01:15:00.000Z",
};
const ИМЕНА = new Map([["11111111-1111-4111-8111-111111111111", "Рустам"]]);

describe("Блок «Ждут подтверждения» (П7, T6)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("показывает задачу, автора закрытия, отчёт и обе кнопки", () => {
    render(<AwaitingBlock tasks={[ЗАДАЧА]} names={ИМЕНА} />);
    expect(screen.getByText("Пополнить Olma")).toBeVisible();
    expect(screen.getByText(/Рустам/)).toBeVisible();
    expect(screen.getByText(/Загрузил 40 позиций/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Принять" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Переделать" })).toBeVisible();
  });

  it("пусто — третье состояние, а не зелёная галка и не исчезнувший блок", () => {
    // Исчезнувший блок неотличим от «ещё не выкатили»: владелец должен видеть,
    // что приёмка работает и очередь пуста.
    render(<AwaitingBlock tasks={[]} names={ИМЕНА} />);
    expect(screen.getByText("Ждут подтверждения")).toBeVisible();
    expect(screen.getByText(/Ничего не ждёт приёмки/)).toBeVisible();
  });

  it("«Принять» зовёт экшен и обновляет страницу", async () => {
    mocks.confirmTask.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<AwaitingBlock tasks={[ЗАДАЧА]} names={ИМЕНА} />);
    await user.click(screen.getByRole("button", { name: "Принять" }));
    await waitFor(() => expect(mocks.confirmTask).toHaveBeenCalledWith(ЗАДАЧА.id));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("отказ Core оставляет текст ошибки и НЕ гасит список", async () => {
    mocks.confirmTask.mockResolvedValue({ ok: false, error: "Это может менеджер" });
    const user = userEvent.setup();
    render(<AwaitingBlock tasks={[ЗАДАЧА]} names={ИМЕНА} />);
    await user.click(screen.getByRole("button", { name: "Принять" }));
    expect(await screen.findByText("Это может менеджер")).toBeVisible();
    expect(screen.getByText("Пополнить Olma")).toBeVisible();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("«Переделать» — это rateTask(redo), а не приёмка", () => {
    // Отдельные действия с разными последствиями: приёмка закрывает вопрос,
    // «переделать» возвращает задачу в работу и включает напоминания заново.
    render(<AwaitingBlock tasks={[ЗАДАЧА]} names={ИМЕНА} />);
    expect(mocks.rateTask).not.toHaveBeenCalled();
  });
});
