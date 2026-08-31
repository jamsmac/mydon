import { describe, expect, it, vi } from "vitest";
import type { Task } from "./core";
import { collectAllTaskPages, TASK_BOARD_PAGE_LIMIT } from "./task-pagination";

const task = (id: string): Task => ({ id }) as Task;

describe("task board pagination", () => {
  it("забирает всё за пределом первых 300 строк", async () => {
    const all = Array.from({ length: TASK_BOARD_PAGE_LIMIT + 1 }, (_, index) => task(`t-${index}`));
    const load = vi.fn(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve(all.slice(offset, offset + limit)),
    );

    await expect(collectAllTaskPages(load)).resolves.toEqual(all);
    expect(load.mock.calls.map(([page]) => page)).toEqual([
      { limit: TASK_BOARD_PAGE_LIMIT, offset: 0 },
      { limit: TASK_BOARD_PAGE_LIMIT, offset: TASK_BOARD_PAGE_LIMIT },
    ]);
  });

  it("делает завершающий пустой запрос, если число строк кратно лимиту", async () => {
    const all = Array.from({ length: TASK_BOARD_PAGE_LIMIT }, (_, index) => task(`t-${index}`));
    const load = vi.fn(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve(all.slice(offset, offset + limit)),
    );

    await expect(collectAllTaskPages(load)).resolves.toHaveLength(TASK_BOARD_PAGE_LIMIT);
    expect(load).toHaveBeenLastCalledWith({
      limit: TASK_BOARD_PAGE_LIMIT,
      offset: TASK_BOARD_PAGE_LIMIT,
    });
  });

  it("не показывает молча неполную доску при дубле id между страницами", async () => {
    const first = Array.from({ length: TASK_BOARD_PAGE_LIMIT }, (_, index) => task(`t-${index}`));
    const load = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([task(`t-${TASK_BOARD_PAGE_LIMIT - 1}`)]);

    await expect(collectAllTaskPages(load)).rejects.toThrow("изменилась");
  });
});
