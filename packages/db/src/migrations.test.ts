import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/** Страж целостности цепочки миграций Drizzle. */
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "drizzle");

interface Journal {
  entries: { idx: number; tag: string }[];
}

describe("Цепочка миграций Drizzle", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as Journal;

  it("у каждого SQL есть запись в журнале, и наоборот", () => {
    const tags = journal.entries.map((entry) => entry.tag).sort();
    assert.deepEqual(files.map((file) => file.replace(/\.sql$/, "")), tags);
  });

  it("номера файлов уникальны", () => {
    const numbers = files.map((file) => file.slice(0, 4));
    assert.equal(new Set(numbers).size, numbers.length, `дубль номера: ${numbers.join(",")}`);
  });

  it("idx журнала уникальны и идут без дыр от нуля", () => {
    const indices = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    assert.deepEqual(indices, [...indices.keys()]);
  });

  it("номер файла совпадает с idx записи", () => {
    for (const entry of journal.entries) {
      assert.match(entry.tag, /^\d{4}_/, `${entry.tag}: имя без четырёхзначного номера`);
      assert.equal(Number(entry.tag.slice(0, 4)), entry.idx);
    }
  });
});
