import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../lib/core";
import { TaskEdit } from "./task-edit";

const mocks = vi.hoisted(() => ({ editTask: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/tasks/actions", () => ({ editTask: mocks.editTask }));

const TASK: Task = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Проверить остатки",
  description: null,
  ownerKind: "human",
  ownerRef: null,
  domain: "vendhub",
  status: "todo",
  priority: "normal",
  due: null,
  source: null,
  createdBy: "owner",
  resultNote: null,
  entityId: null,
  quality: null,
  completedAt: null,
  closedBy: null,
  confirmedAt: null,
  confirmedBy: null,
  assignNotifiedAt: null,
  createdAt: "2026-08-31T08:00:00.000Z",
};

describe("TaskEdit", () => {
  beforeEach(() => vi.resetAllMocks());

  it("меняет направление отдельным патчем", async () => {
    mocks.editTask.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<TaskEdit task={TASK} owners={[]} />);

    await user.click(screen.getByRole("button", { name: "Изменить задачу" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Направление" }), "globerent");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(mocks.editTask).toHaveBeenCalledWith(TASK.id, { domain: "globerent" }),
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("показывает legacy-задачу без направления и даёт ей назначить контур", async () => {
    mocks.editTask.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<TaskEdit task={{ ...TASK, domain: null }} owners={[]} />);

    await user.click(screen.getByRole("button", { name: "Изменить задачу" }));
    const direction = screen.getByRole("combobox", { name: "Направление" });
    expect(direction).toHaveValue("");
    expect(screen.getByRole("option", { name: /без направления/ })).toBeDisabled();

    await user.selectOptions(direction, "mydon");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(mocks.editTask).toHaveBeenCalledWith(TASK.id, { domain: "mydon" }));
  });

  it("неизвестный legacy-domain виден как неразобранный", async () => {
    const user = userEvent.setup();
    render(<TaskEdit task={{ ...TASK, domain: "old-vendhub" }} owners={[]} />);

    await user.click(screen.getByRole("button", { name: "Изменить задачу" }));
    const direction = screen.getByRole("combobox", { name: "Направление" });
    expect(direction).toHaveValue("");
    expect(screen.getByRole("option", { name: /без направления/ })).toBeDisabled();
  });
});
