import { beforeEach, describe, expect, it, vi } from "vitest";
import { editTask, quickAddTask } from "./actions";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  editTask: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../../lib/core", () => ({
  core: {
    createTask: mocks.createTask,
    editTask: mocks.editTask,
  },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

function quickForm(domain?: string): FormData {
  const form = new FormData();
  form.set("title", "Проверить остатки");
  form.set("owner", "human:person-1");
  if (domain !== undefined) form.set("domain", domain);
  return form;
}

describe("task actions: направления", () => {
  beforeEach(() => vi.resetAllMocks());

  it("не создаёт задачу без canonical-направления", async () => {
    await expect(quickAddTask(quickForm())).resolves.toEqual({
      ok: false,
      error: "Выбери направление",
    });
    await expect(quickAddTask(quickForm("legacy"))).resolves.toEqual({
      ok: false,
      error: "Выбери направление",
    });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("передаёт выбранное направление в Core", async () => {
    mocks.createTask.mockResolvedValue({ id: "task-1" });

    await expect(quickAddTask(quickForm("vendhub"))).resolves.toEqual({ ok: true });

    expect(mocks.createTask).toHaveBeenCalledWith({
      title: "Проверить остатки",
      domain: "vendhub",
      ownerKind: "human",
      ownerRef: "person-1",
      priority: "normal",
      createdBy: "owner",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/tasks");
  });

  it("валидирует и передаёт смену направления", async () => {
    await expect(editTask("task-1", { domain: "legacy" })).resolves.toEqual({
      ok: false,
      error: "Выбери направление",
    });
    expect(mocks.editTask).not.toHaveBeenCalled();

    mocks.editTask.mockResolvedValue({ id: "task-1" });
    await expect(editTask("task-1", { domain: "personal" })).resolves.toEqual({ ok: true });
    expect(mocks.editTask).toHaveBeenCalledWith("task-1", {
      actor: "owner",
      domain: "personal",
    });
  });
});
