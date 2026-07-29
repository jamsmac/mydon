import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntitiesService, nameMatches } from "./entities.service";

/** Достаёт подставляемые значения из SQL-выражения Drizzle. */
function params(expr: ReturnType<typeof nameMatches>): string[] {
  const chunks = (expr as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((c): c is string => typeof c === "string");
}

/** Собирает статическую часть выражения — для проверки ESCAPE и коллации. */
function sqlText(expr: ReturnType<typeof nameMatches>): string {
  const chunks = (expr as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown })?.value;
      return Array.isArray(v) ? v.join("") : "";
    })
    .join("");
}

describe("Поиск по имени", () => {
  it("экранирует % — иначе «АР-100%» возвращал весь реестр", () => {
    const [pattern] = params(nameMatches("АР-100%"));
    assert.equal(pattern, "%АР-100\\%%");
  });

  it("экранирует _ — иначе «ООО _Строй» находило что попало", () => {
    const [pattern] = params(nameMatches("ООО _Строй"));
    assert.equal(pattern, "%ООО \\_Строй%");
  });

  it("экранирует саму обратную косую", () => {
    const [pattern] = params(nameMatches("путь\\файл"));
    assert.equal(pattern, "%путь\\\\файл%");
  });

  it("обычный запрос не портит", () => {
    const [pattern] = params(nameMatches("Глоберент"));
    assert.equal(pattern, "%Глоберент%");
  });

  it("использует явную коллацию — ILIKE не сворачивает кириллицу при локали C", () => {
    const text = sqlText(nameMatches("тест"));
    assert.match(text, /und-x-icu/);
    assert.match(text, /ESCAPE/);
    assert.match(text, /ILIKE/);
  });
});

describe("Удаление записи", () => {
  it("удаляет и оставляет содержимое в журнале (before)", async () => {
    const audit: Record<string, unknown>[] = [];
    const row = { id: "e1", name: "Test1", type: "machine" };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [row] }) }) }),
      delete: () => ({ where: async () => undefined }),
      insert: () => ({ values: async (v: Record<string, unknown>) => { audit.push(v); } }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
    const s = new EntitiesService(db, { record: async () => undefined } as never);
    await s.remove("e1", "owner");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "entity.delete");
    assert.deepEqual(audit[0].before, row);
  });

  it("несуществующая запись → понятная ошибка, журнал чист", async () => {
    const audit: unknown[] = [];
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      delete: () => ({ where: async () => undefined }),
      insert: () => ({ values: async (v: unknown) => { audit.push(v); } }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
    const s = new EntitiesService(db, { record: async () => undefined } as never);
    await assert.rejects(() => s.remove("нет-такой"), /не найдена/);
    assert.equal(audit.length, 0);
  });
});
