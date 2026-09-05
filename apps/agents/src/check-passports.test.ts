import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkLinks, checkPassport, parsePassport } from "./check-passports";

describe("Разбор паспорта", () => {
  it("«schedule: []» — это пустой список, а не начало списка", () => {
    // Раньше разбор подхватывал следующие пункты файла как расписание
    // и выдавал несуществующие «битые расписания» — ложная тревога.
    const cfg = parsePassport(`name: call-analyst
schedule: []
kb_pages:
  - shared/kb/globerent/call-criteria.md
  - shared/kb/globerent/heli-models.md`);
    assert.deepEqual(cfg.schedule, [], "агент по событию не имеет расписаний");
  });

  it("читает расписание с навыком и cron", () => {
    const cfg = parsePassport(`schedule:
  - cron: "0 8 * * 1-5"
    skill: scan-tenders`);
    assert.equal(cfg.schedule.length, 1);
    assert.equal(cfg.schedule[0].skill, "scan-tenders");
    assert.equal(cfg.schedule[0].cron, "0 8 * * 1-5");
  });

  it("собирает non_goals списком", () => {
    const cfg = parsePassport(`non_goals:
  - НЕ готовит КП
  - НЕ пишет контрагентам`);
    assert.equal(cfg.non_goals?.length, 2);
  });
});

describe("Проверка паспорта", () => {
  const good = {
    business: "globerent",
    status: "paused",
    mission: "Одна задача",
    non_goals: ["НЕ делает Х"],
    schedule: [{ cron: "0 8 * * 1", skill: "scan" }],
  };

  it("целый паспорт замечаний не даёт", () => {
    assert.deepEqual(checkPassport("a", good, ["scan"]).problems, []);
  });

  it("«shared» — допустимое направление для кросс-доменного агента", () => {
    const r = checkPassport("a", { ...good, business: "shared" }, ["scan"]);
    assert.deepEqual(r.problems, [], "рантайм сам подставляет shared по умолчанию");
  });

  it("ловит расписание, зовущее несуществующий навык", () => {
    const r = checkPassport("a", good, []);
    assert.match(r.problems.join(), /файла нет/, "иначе задание молча не выполнится");
  });

  it("ловит битый cron", () => {
    const r = checkPassport("a", { ...good, schedule: [{ cron: "0 8 *", skill: "scan" }] }, ["scan"]);
    assert.match(r.problems.join(), /битое расписание/);
  });

  it("ловит отсутствие границ роли", () => {
    const r = checkPassport("a", { ...good, mission: undefined, non_goals: [] }, ["scan"]);
    assert.equal(r.problems.length, 2);
  });

  it("ловит неизвестный статус", () => {
    const r = checkPassport("a", { ...good, status: "включён" }, ["scan"]);
    assert.match(r.problems.join(), /неизвестный статус/);
  });
});

describe("Связи паспорта с навыками и KB (checkLinks, спека llm-skill)", () => {
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "mydon-shared-"));
  fs.mkdirSync(path.join(sharedDir, "kb/globerent"), { recursive: true });
  fs.writeFileSync(path.join(sharedDir, "kb/globerent/heli-models.md"), "# HELI");
  const noCode = () => false;
  const base = { business: "globerent", status: "paused", schedule: [] as { cron?: string; skill?: string }[] };

  it("целые связи замечаний не дают: kb-страница есть, llm-навык не в расписании", () => {
    const problems = checkLinks(
      { ...base, kb_pages: ["shared/kb/globerent/heli-models.md"] },
      [{ name: "qualify-lead", executor: "llm" }, { name: "scan", executor: "code" }],
      sharedDir,
      noCode,
    );
    assert.deepEqual(problems, []);
  });

  it("llm-навык в расписании — НЕ замечание: cron открыт через durable-задачи (R-SD-5)", () => {
    const problems = checkLinks(
      { ...base, schedule: [{ cron: "0 8 * * 1", skill: "qualify-lead" }] },
      [{ name: "qualify-lead", executor: "llm" }],
      sharedDir,
      noCode,
    );
    assert.deepEqual(problems, []);
  });

  it("executor: llm при наличии кода в SKILLS — двусмысленность, исполнится код", () => {
    const problems = checkLinks(base, [{ name: "watch-receivables", executor: "llm" }], sharedDir, (n) => n === "watch-receivables");
    assert.deepEqual(problems, ["навык watch-receivables: executor: llm, но есть код в SKILLS — исполняться будет код"]);
  });

  it("kb_pages: чужой формат пути и отсутствующая страница — разные замечания; хвост-комментарий отбрасывается", () => {
    const problems = checkLinks(
      {
        ...base,
        kb_pages: [
          "shared/kb/globerent/heli-models.md # основная",
          "kb/globerent/heli-models.md",
          "shared/kb/../secret.md",
          "shared/kb/globerent/nope.md",
        ],
      },
      [],
      sharedDir,
      noCode,
    );
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.match(problems[0], /«kb\/globerent\/heli-models.md» — путь должен быть вида shared\/kb/);
    assert.match(problems[1], /«shared\/kb\/..\/secret.md» — путь должен быть вида/);
    assert.match(problems[2], /страницы «shared\/kb\/globerent\/nope.md» нет на диске/);
  });
});
