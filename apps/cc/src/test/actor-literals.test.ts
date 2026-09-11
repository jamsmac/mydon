/** @vitest-environment node */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Сторож авторства панели (R-H-8, R-H-9) — зеркало
 * `apps/core/src/common/actor-literals.guard.test.ts`.
 *
 * Панель подписывала записи литералом `"owner"` в ~40 местах (и `"panel"` ещё
 * в пяти), а явное поле тела в Core главнее заголовка `x-mydon-actor`: один
 * забытый литерал перебивает честного актора запроса, и правка агента снова
 * числится за владельцем — без единой ошибки. Теперь автор берётся из
 * `resolveActor()`; этот тест не даёт литералу вернуться.
 *
 * Поля перечислены все, какими панель подписывала запись, а не только
 * `actor`/`actorRef`: `performedBy: "panel"` у мойки и `&actor=owner` в строке
 * запроса нашлись именно потому, что поиск по одному имени поля их пропускал.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ACTOR_FIELDS = "actor|actorRef|createdBy|author|countedBy|importedBy|performedBy|manager|decidedBy|approvedBy|confirmedBy";
const PATTERNS: RegExp[] = [
  // поле тела с литералом-автором
  new RegExp(`\\b(${ACTOR_FIELDS}):\\s*"(owner|panel)"`),
  // умолчание параметра-автора
  new RegExp(`\\b(${ACTOR_FIELDS})\\s*=\\s*"(owner|panel)"`),
  // автор в строке запроса
  /[?&](actor|actorRef|by)=(owner|panel)\b/,
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function violations(): string[] {
  const out: string[] = [];
  for (const file of sources(SRC)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.trim();
        // Комментарии законно цитируют старое правило.
        if (code.startsWith("*") || code.startsWith("//")) return;
        if (PATTERNS.some((p) => p.test(line))) out.push(`${path.relative(SRC, file)}:${i + 1}: ${code}`);
      });
  }
  return out;
}

describe("сторож авторства панели: автор — resolveActor(), а не литерал", () => {
  it("сканер видит исходники панели (иначе зелёный тест ничего бы не значил)", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(200);
    const withResolver = files.filter((f) => readFileSync(f, "utf8").includes("resolveActor("));
    expect(withResolver.length).toBeGreaterThanOrEqual(14);
  });

  it('нет литералов-авторов "owner" / "panel" — ни в теле, ни в умолчаниях, ни в строке запроса', () => {
    expect(violations()).toEqual([]);
  });

  it("каждая запись панели в Core несёт заголовок актора — одной дверью send()", () => {
    const core = readFileSync(path.join(SRC, "lib", "core.ts"), "utf8");
    // Тело send() — от объявления до ЕГО return (та же строка есть и у get()
    // выше, поэтому ищем после начала send, а не с начала файла).
    const start = core.indexOf("async function send<T>(");
    expect(start).toBeGreaterThan(-1);
    const send = core.slice(start, core.indexOf("return (await res.json()) as T;", start));
    expect(send).toContain("...(await actorHeaders())");
    const ownerWrite = core.slice(core.indexOf("export async function coreOwnerWriteHeaders"));
    expect(ownerWrite.slice(0, ownerWrite.indexOf("\n}"))).toContain("...(await actorHeaders())");
  });
});
