import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPassport, parsePassport } from "./check-passports";

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
