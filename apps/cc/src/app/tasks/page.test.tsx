import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ taskBoard: vi.fn(), people: vi.fn(), agents: vi.fn() }));

vi.mock("../../lib/core", () => ({
  CoreUnavailable: class CoreUnavailable extends Error {},
  core: {
    taskBoard: mocks.taskBoard,
    people: mocks.people,
    agents: mocks.agents,
  },
}));
vi.mock("../../components/task-quick-add", () => ({ QuickAdd: () => <div>quick add</div> }));
vi.mock("../../components/awaiting-block", () => ({
  AwaitingBlock: ({ tasks }: { tasks: unknown[] }) => <div>awaiting {tasks.length}</div>,
}));
vi.mock("../../components/task-row", () => ({
  TaskRow: ({ task, urgent }: { task: { title: string }; urgent: boolean }) => (
    <div data-task={task.title} data-urgent={urgent ? "yes" : "no"} />
  ),
}));

import Tasks from "./page";

function task(id: string, domain: string | null, due: string | null) {
  return {
    id,
    title: id,
    domain,
    due,
    priority: "normal" as const,
    ownerKind: "human" as const,
    ownerRef: null,
  };
}

describe("страница задач", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.people.mockResolvedValue([]);
    mocks.agents.mockResolvedValue([]);
    mocks.taskBoard.mockImplementation((filter: { awaiting?: string }) =>
      Promise.resolve(
        filter.awaiting
          ? []
          : [
              task("legacy", null, null),
              task("vendhub-later", "vendhub", "2099-01-01T12:00:00.000Z"),
              task("globerent", "globerent", null),
              task("vendhub-overdue", "vendhub", "2020-01-01T12:00:00.000Z"),
            ],
      ),
    );
  });

  it("сначала группирует по направлению, затем по срочности", async () => {
    const { container } = render(await Tasks());
    const directions = Array.from(container.querySelectorAll(".group-block"));

    expect(
      directions.map((section) => section.querySelector(":scope > .section-title")?.textContent),
    ).toEqual(["GLOBERENT1", "VendHub2", "Без направления1"]);
    expect(
      Array.from(directions[1]!.querySelectorAll(".task-urgency-group > .section-title")).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["Просрочено1", "Позже1"]);
    expect(container.querySelector('[data-task="vendhub-overdue"]')).toHaveAttribute(
      "data-urgent",
      "yes",
    );
  });

  it("для открытых и приёмки запрашивает всю доску, а не одну страницу", async () => {
    render(await Tasks());

    expect(mocks.taskBoard).toHaveBeenCalledWith({ open: "1" });
    expect(mocks.taskBoard).toHaveBeenCalledWith({ awaiting: "1" });
  });
});
