import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Сторож авторства (R-H-8, R-H-9): актор в журнале — факт, а не литерал.
 *
 * Класс ошибки закрывался дважды, и оба раза частично. Вид актора проставляли
 * литералом `actorKind: "human"` в 79 местах — агент, пришедший через панель,
 * ложился в журнал человеком. Умолчания `?? "owner"` стояли в каждом
 * контроллере — всё, что панель не подписала явно, подписывалось владельцем.
 * Теперь вид выводится из ссылки (`actorKindOf`), а умолчание спрашивает актора
 * запроса (`requestActor`). Этот тест держит оба правила: новый литерал —
 * красный CI, а не ещё одна тихая неправда через полгода.
 *
 * Разрешено: `actorKind: "agent"` / `"system"` — там вид действительно
 * известен заранее (крон, агентный цикл), литерал правдив.
 */

// Тест исполняется из `dist/common`, а читает `src`: путь ищем по сегменту
// «core», как в `read-token.guard.test.ts`.
const ЧАСТИ = __dirname.split(path.sep);
const SRC = path.join(ЧАСТИ.slice(0, ЧАСТИ.lastIndexOf("core") + 1).join(path.sep), "src");

/** Где правило описано словами — там литерал в комментарии законен. */
const ОПИСАНИЕ_ПРАВИЛА = path.join(SRC, "common", "request-actor.ts");

function исходники(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...исходники(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function нарушения(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const file of исходники(SRC)) {
    if (file === ОПИСАНИЕ_ПРАВИЛА) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) out.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  return out;
}

describe("сторож авторства: актор — факт, а не литерал", () => {
  it("сканер видит исходники Core (иначе зелёный тест ничего бы не значил)", () => {
    const files = исходники(SRC);
    assert.ok(files.length > 100, `нашлось ${files.length} файлов в ${SRC}`);
    const сЗапросом = files.filter((f) => readFileSync(f, "utf8").includes("requestActor("));
    assert.ok(сЗапросом.length >= 29, `requestActor используется в ${сЗапросом.length} файлах`);
  });

  it('нет `actorKind: "human"` — вид выводится из ссылки через actorKindOf', () => {
    assert.deepEqual(нарушения(/actorKind:\s*"human"/), []);
  });

  it('нет умолчаний `?? "owner"` / `?? "panel"` — умолчание спрашивает requestActor', () => {
    assert.deepEqual(нарушения(/\?\?\s*"(owner|panel)"/), []);
  });

  it("нет зашитой ссылки `actorRef: \"owner\"` / `\"panel\"`", () => {
    assert.deepEqual(нарушения(/\b(actorRef|approvedBy):\s*"(owner|panel)"/), []);
  });

  /*
   * Третья форма той же лжи, пропущенная волной 1 (найдена 11.09.2026):
   * умолчание автора в СИГНАТУРЕ сервиса. `update(id, dto, actorRef = "system")`
   * звали из `PATCH /entities/:id` без автора — самая частая правка панели
   * ложилась в журнал «системой». Умолчание — выражение, вычисляется при
   * вызове: `actorRef = requestActor("system")` честен и в запросе, и в кроне.
   */
  it('нет умолчаний автора литералом в сигнатуре — `actorRef = requestActor("…")`', () => {
    assert.deepEqual(
      нарушения(/\b(actorRef|actor|createdBy|decidedBy|importedBy|author|manager)\s*(:\s*string)?\s*=\s*"[a-z:_-]+"/),
      [],
    );
  });

  it('нет вида `"system"` при переменной ссылке `actorRef,` — вид выводится из ссылки', () => {
    const out: string[] = [];
    for (const file of исходники(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/actorKind:\s*"system",\s*$/.test(line)) return;
        const around = [lines[i - 1] ?? "", lines[i + 1] ?? ""];
        if (around.some((l) => /^\s*actorRef,\s*$/.test(l))) out.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    assert.deepEqual(out, []);
  });
});
