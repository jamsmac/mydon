import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FILL_FIELDS, isKbPagePath, passportFields, planPatch, readPassports } from "./apply-passport-fields.mjs";

const passport = {
  name: "globerent-sales",
  mission: "  Квалифицировать входящие лиды  ",
  non_goals: ["НЕ пишет клиентам", "  ", 42],
  break_glass: ["draft-quote"],
  kb_pages: [
    "shared/kb/globerent/heli-models.md # основная",
    "kb/globerent/pricelist.md",
    "shared/kb/../secret.md",
    "shared/kb/globerent/lead-criteria.md",
  ],
  web_sources: [{ name: "Xarid", url: "https://xarid.uzex.uz" }, { name: "без url" }, "мусор"],
  skills: ["qualify-lead", "intake-classify"],
};

describe("passportFields — паспорт → поля карточки (зеркало registry.ts)", () => {
  it("обрезает пробелы, отбрасывает пустое и не-строки, режет хвост-комментарии kb_pages, фильтрует битые пути и источники", () => {
    const f = passportFields(passport);
    assert.equal(f.mission, "Квалифицировать входящие лиды");
    assert.deepEqual(f.nonGoals, ["НЕ пишет клиентам"]);
    assert.deepEqual(f.breakGlass, ["draft-quote"]);
    assert.deepEqual(f.kbPages, ["shared/kb/globerent/heli-models.md", "shared/kb/globerent/lead-criteria.md"]);
    assert.deepEqual(f.webSources, [{ name: "Xarid", url: "https://xarid.uzex.uz" }]);
    assert.deepEqual(f.skills, ["qualify-lead", "intake-classify"]);
    assert.equal(f.description, undefined);
  });

  it("isKbPagePath: только shared/**.md без ..", () => {
    assert.equal(isKbPagePath("shared/kb/globerent/faq.md"), true);
    assert.equal(isKbPagePath("shared/kb/../x.md"), false);
    assert.equal(isKbPagePath("kb/faq.md"), false);
    assert.equal(isKbPagePath("shared/kb/faq.txt"), false);
    assert.equal(isKbPagePath(7), false);
  });
});

describe("planPatch — заполнить пустое, объединить skills, не переписывать заданное", () => {
  const fields = passportFields(passport);

  it("пустая карточка получает все поля паспорта; skills — объединение", () => {
    const row = { name: "globerent-sales", mission: null, nonGoals: [], breakGlass: [], kbPages: [], webSources: [], skills: ["qualify-lead"] };
    const { patch, kept } = planPatch(fields, row);
    assert.deepEqual(kept, []);
    assert.deepEqual(Object.keys(patch).sort(), ["breakGlass", "kbPages", "mission", "nonGoals", "skills", "webSources"]);
    assert.deepEqual(patch.skills, ["qualify-lead", "intake-classify"], "навык из паспорта добавлен, порядок базы сохранён");
    assert.equal("description" in patch, false, "паспорт без description ничего не заполняет");
  });

  it("заданное в базе не переписывается, а печатается как расхождение", () => {
    const row = { mission: "Своя миссия владельца", nonGoals: ["своё"], breakGlass: ["draft-quote"], kbPages: [], webSources: [], skills: ["qualify-lead", "intake-classify", "owner-added"] };
    const { patch, kept } = planPatch(fields, row);
    assert.deepEqual(Object.keys(patch).sort(), ["kbPages", "webSources"], "пустые поля заполнены, заданные — нет");
    assert.deepEqual(kept.map((k) => k.field), ["mission", "nonGoals"]);
    assert.equal("skills" in patch, false, "навык владельца owner-added остаётся, паспортные уже есть");
  });

  it("--overwrite переписывает только названные поля", () => {
    const row = { mission: "Своя", nonGoals: ["своё"], breakGlass: [], kbPages: [], webSources: [], skills: ["qualify-lead", "owner-added"] };
    const { patch, kept } = planPatch(fields, row, { overwrite: ["mission", "skills"] });
    assert.equal(patch.mission, "Квалифицировать входящие лиды");
    assert.deepEqual(patch.skills, ["qualify-lead", "intake-classify"], "overwrite skills — ровно как в паспорте");
    assert.deepEqual(kept.map((k) => k.field), ["nonGoals"]);
  });

  it("идемпотентность: карточка, равная паспорту, даёт пустой patch", () => {
    const row = { description: undefined, mission: fields.mission, nonGoals: fields.nonGoals, breakGlass: fields.breakGlass, kbPages: fields.kbPages, webSources: fields.webSources, ideaChannels: [], skills: [...fields.skills] };
    const { patch, kept } = planPatch(fields, row);
    assert.deepEqual(patch, {});
    assert.deepEqual(kept, []);
  });

  it("FILL_FIELDS не содержит полей владельца (status, autonomyDefault, schedule)", () => {
    for (const forbidden of ["status", "autonomyDefault", "schedule", "budgetPerDayUsd", "budgetOnExceeded"]) {
      assert.equal(FILL_FIELDS.includes(forbidden), false, forbidden);
    }
  });
});

describe("readPassports — каталог агентов", () => {
  it("читает config.yaml, пропускает _template и каталоги без паспорта, имя берёт из name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mydon-passports-"));
    try {
      fs.mkdirSync(path.join(dir, "a"));
      fs.writeFileSync(path.join(dir, "a/config.yaml"), "name: a-agent\nskills: [x]\n");
      fs.mkdirSync(path.join(dir, "_template"));
      fs.writeFileSync(path.join(dir, "_template/config.yaml"), "name: tpl\n");
      fs.mkdirSync(path.join(dir, "empty"));
      // Мини-разбор вместо yaml: тест не зависит от node_modules пакета агентов.
      const parse = (text) => {
        const m = /name:\s*(\S+)/.exec(text);
        return { name: m?.[1], skills: /skills:/.test(text) ? ["x"] : [] };
      };
      const got = readPassports(dir, parse);
      assert.deepEqual([...got.keys()], ["a-agent"]);
      assert.deepEqual(got.get("a-agent").skills, ["x"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
