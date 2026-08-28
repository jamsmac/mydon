import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Сторож ЦЕПОЧКИ миграций, а не их содержания.
 *
 * Ловит ровно один класс аварии: две ветки взяли один номер. Мигратор
 * drizzle идёт по `_journal.json`, а не по каталогу, поэтому файл без записи
 * НЕ применится вовсе (и это будет видно только в проде, когда колонки нет), а
 * запись без файла роняет автодеплой на ровном месте. Оба случая рождаются в
 * rebase и оба невидимы для `pnpm build`.
 *
 * Папка считается от расположения файла (`dist/../drizzle`), а не от cwd, —
 * тот же приём, что в `migrate.ts:33`: тесты зовут и из корня, и из пакета.
 *
 * Снапшоты (`meta/<NNNN>_snapshot.json`) НЕ проверяются намеренно: их 65 на 72
 * миграции — у семи рукописных (`0049`…`0055`) снапшота нет, и такая проверка
 * была бы красной с рождения, то есть её бы отключили в первый же день.
 */
const ПАПКА = path.resolve(__dirname, "..", "drizzle");

interface ЗаписьЖурнала { idx: number; tag: string }

function журнал(): ЗаписьЖурнала[] {
  const raw = readFileSync(path.join(ПАПКА, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: ЗаписьЖурнала[] }).entries;
}

describe("Цепочка миграций: файл ↔ журнал (сторож номера)", () => {
  const записи = журнал();
  const файлы = readdirSync(ПАПКА).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4));

  it("у каждого .sql есть запись журнала, у каждой записи — файл", () => {
    const теги = new Set(записи.map((e) => e.tag));
    for (const f of файлы) assert.ok(теги.has(f), `${f}.sql не записан в _journal.json — мигратор его не применит`);
    const наДиске = new Set(файлы);
    for (const e of записи) assert.ok(наДиске.has(e.tag), `в журнале есть ${e.tag}, а файла нет — автодеплой упадёт`);
  });

  it("idx идут подряд с нуля и не повторяются", () => {
    assert.deepEqual(
      записи.map((e) => e.idx),
      записи.map((_, i) => i),
      "дырка или дубль idx — верный признак того, что две ветки взяли один номер",
    );
  });

  it("префикс имени файла равен idx", () => {
    for (const e of записи) {
      assert.equal(e.tag.slice(0, 4), String(e.idx).padStart(4, "0"), `${e.tag}: имя и idx разошлись`);
    }
  });

  it("теги уникальны", () => {
    assert.equal(new Set(записи.map((e) => e.tag)).size, записи.length);
  });
});
