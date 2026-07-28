import fs from "node:fs";
import path from "node:path";

/**
 * Cowork — режим агента внутри Claude Desktop на Маке владельца.
 *
 * Публичного API у него нет: всё лежит обычными файлами. Значит MYDON читает
 * их напрямую — без интернета, ключей и логинов.
 *
 * Зачем: у владельца там уже работает агент по расписанию и копится память
 * решений. Без переноса MYDON о них не знает и предлагает то, что уже решено.
 *
 * Формат хранения (разведано на живых данных 2026-07-28):
 *   <база>/scheduled-tasks.json     — агенты по расписанию
 *   <база>/spaces.json              — пространства (проект → папка)
 *   <база>/spaces/<id>/memory/*.md  — память: выжимки решений
 *   <база>/local_<uuid>.json        — сессия: заголовок, время, ошибка
 */

export interface CoworkTask {
  id: string;
  /** Расписание в формате cron. */
  cron: string;
  enabled: boolean;
  /** Файл с инструкцией агента (SKILL.md). */
  skillPath: string;
  lastRunAt: string | null;
  /** Папки, с которыми агент работает. */
  folders: string[];
}

export interface CoworkSpace {
  id: string;
  name: string;
  folder: string | null;
}

export interface CoworkMemory {
  /** Имя файла без расширения — оно же смысловой ключ. */
  name: string;
  title: string;
  body: string;
}

export interface CoworkRun {
  sessionId: string;
  taskId: string | null;
  at: string | null;
  title: string;
  /** Текст ошибки, если запуск не удался. */
  error: string | null;
}

/** Разбор scheduled-tasks.json. Битый файл не должен ронять импорт. */
export function parseTasks(raw: string): CoworkTask[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (data as { scheduledTasks?: unknown }).scheduledTasks;
  if (!Array.isArray(list)) return [];

  return list
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((t) => ({
      id: String(t.id ?? ""),
      cron: String(t.cronExpression ?? ""),
      enabled: t.enabled !== false,
      skillPath: String(t.filePath ?? ""),
      lastRunAt: typeof t.lastRunAt === "string" ? t.lastRunAt : null,
      folders: Array.isArray(t.userSelectedFolders) ? t.userSelectedFolders.map(String) : [],
    }))
    .filter((t) => t.id.length > 0);
}

/** Разбор spaces.json: пространство = проект владельца. */
export function parseSpaces(raw: string): CoworkSpace[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  // Форма может быть массивом или объектом с полем spaces — принимаем обе.
  const list = Array.isArray(data) ? data : (data as { spaces?: unknown }).spaces;
  if (!Array.isArray(list)) return [];

  return list
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
    .map((s) => ({
      id: String(s.id ?? ""),
      name: String(s.name ?? "без названия"),
      folder:
        typeof s.folder === "string"
          ? s.folder
          : Array.isArray(s.folders) && typeof s.folders[0] === "string"
            ? String(s.folders[0])
            : null,
    }))
    .filter((s) => s.id.length > 0);
}

/**
 * Разбор файла памяти. Заголовок берём из frontmatter или первой строки —
 * владельцу нужно видеть, о чём запись, не открывая её.
 */
export function parseMemoryFile(name: string, raw: string): CoworkMemory {
  const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  const descr = /description:\s*"?([^"\n]+)"?/.exec(raw)?.[1]?.trim();
  const firstLine = withoutFrontmatter.split("\n")[0]?.replace(/^#+\s*/, "").trim();
  return {
    name: name.replace(/\.md$/, ""),
    title: descr && descr.length > 0 ? descr : (firstLine ?? name),
    body: withoutFrontmatter,
  };
}

/** Разбор файла сессии: нужен статус запуска — работал агент или упал. */
export function parseRun(raw: string): CoworkRun | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId = typeof j.sessionId === "string" ? j.sessionId : null;
  if (sessionId === null) return null;

  // Ошибка может лежать по-разному — берём первое похожее на текст.
  const err =
    typeof j.error === "string"
      ? j.error
      : typeof (j.error as { message?: unknown } | undefined)?.message === "string"
        ? String((j.error as { message: string }).message)
        : null;

  return {
    sessionId,
    taskId: typeof j.scheduledTaskId === "string" ? j.scheduledTaskId : null,
    at: typeof j.createdAt === "string" ? j.createdAt : typeof j.lastActivityAt === "string" ? j.lastActivityAt : null,
    title: typeof j.title === "string" ? j.title : "",
    error: err,
  };
}

export interface CoworkSnapshot {
  tasks: CoworkTask[];
  spaces: CoworkSpace[];
  memory: CoworkMemory[];
  runs: CoworkRun[];
}

export const cowork = {
  name: "cowork",
  status: "live" as const,
  note: "Агент и память Claude Desktop (Cowork). Читается файлами с Мака владельца.",

  /** Путь к данным Cowork. Задаётся явно: у каждого Мака он свой. */
  baseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
    return env.COWORK_BASE_DIR && env.COWORK_BASE_DIR.length > 0 ? env.COWORK_BASE_DIR : null;
  },

  /**
   * Снимок состояния Cowork: агенты, пространства, память, запуски.
   *
   * Читается best-effort: пропавший или битый файл пропускаем, а не роняем
   * весь импорт — данные владельца важнее полноты одного прохода.
   */
  snapshot(baseDir: string, opts: { runsLimit?: number } = {}): CoworkSnapshot {
    const read = (p: string): string | null => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    };

    const tasksRaw = read(path.join(baseDir, "scheduled-tasks.json"));
    const spacesRaw = read(path.join(baseDir, "spaces.json"));
    const tasks = tasksRaw ? parseTasks(tasksRaw) : [];
    const spaces = spacesRaw ? parseSpaces(spacesRaw) : [];

    // Память по всем пространствам: это самое ценное и самое компактное.
    const memory: CoworkMemory[] = [];
    for (const space of spaces) {
      const dir = path.join(baseDir, "spaces", space.id, "memory");
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const f of files) {
        const raw = read(path.join(dir, f));
        if (raw !== null) memory.push(parseMemoryFile(f, raw));
      }
    }

    // Запуски: берём последние — старые не нужны, а файлов много.
    const runs: CoworkRun[] = [];
    try {
      const files = fs
        .readdirSync(baseDir)
        .filter((f) => f.startsWith("local_") && f.endsWith(".json"))
        .slice(-(opts.runsLimit ?? 200));
      for (const f of files) {
        const raw = read(path.join(baseDir, f));
        const run = raw === null ? null : parseRun(raw);
        if (run !== null) runs.push(run);
      }
    } catch {
      // каталога нет — вернём пустой список
    }

    return { tasks, spaces, memory, runs };
  },
};
