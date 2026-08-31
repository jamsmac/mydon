import type { Task } from "./core";

/** Совпадает с потолком `GET /tasks`: один HTTP-ответ остаётся ограниченным. */
export const TASK_BOARD_PAGE_LIMIT = 300;
export const TASK_BOARD_MAX_OFFSET = 100_000;

export type TaskPageLoader = (page: { limit: number; offset: number }) => Promise<Task[]>;

/**
 * Собирает всю доску из bounded-страниц Core.
 *
 * Дубль id между страницами означает, что очередь изменилась во время
 * offset-pagination. В этом случае не показываем молча неполную доску: следующий
 * рендер повторит чтение уже из нового стабильного порядка.
 */
export async function collectAllTaskPages(loadPage: TaskPageLoader): Promise<Task[]> {
  const result: Task[] = [];
  const seen = new Set<string>();

  for (let offset = 0; ; offset += TASK_BOARD_PAGE_LIMIT) {
    if (offset > TASK_BOARD_MAX_OFFSET) {
      throw new Error(`Доска задач превысила безопасный offset ${TASK_BOARD_MAX_OFFSET}`);
    }

    const page = await loadPage({ limit: TASK_BOARD_PAGE_LIMIT, offset });
    if (page.length > TASK_BOARD_PAGE_LIMIT) {
      throw new Error(
        `Core вернул ${page.length} задач при лимите ${TASK_BOARD_PAGE_LIMIT}`,
      );
    }

    for (const item of page) {
      if (seen.has(item.id)) {
        throw new Error("Доска задач изменилась во время загрузки; обновите страницу");
      }
      seen.add(item.id);
      result.push(item);
    }

    if (page.length < TASK_BOARD_PAGE_LIMIT) return result;
  }
}
