import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { effectiveActionTier, maxTier } from "./policy";
import { loadSkillMeta, skillTierFloors, splitFrontmatter } from "./skill-loader";

const REAL_AGENTS_DIR = path.resolve(__dirname, "../agents");

/** Готовит временный каталог агентов из карты «путь → содержимое файла». */
function makeAgentsDir(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mydon-skills-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe("splitFrontmatter", () => {
  it("отделяет YAML-frontmatter от тела", () => {
    const { data, body } = splitFrontmatter("---\nname: x\nrequires-approval: T3\n---\n# Тело\ntext");
    assert.equal(data.name, "x");
    assert.equal(data["requires-approval"], "T3");
    assert.match(body, /# Тело/);
  });

  it("нет frontmatter → data пустой, тело — весь текст", () => {
    const { data, body } = splitFrontmatter("# Просто заголовок\nбез фронтматтера");
    assert.deepEqual(data, {});
    assert.match(body, /Просто заголовок/);
  });

  it("битый YAML во frontmatter не роняет — считаем пустым", () => {
    const { data } = splitFrontmatter("---\nname: [незакрытый\n---\nтело");
    assert.deepEqual(data, {});
  });
});

describe("loadSkillMeta", () => {
  it("читает frontmatter и пропускает _template и не-.md", () => {
    const dir = makeAgentsDir({
      "finance/skills/watch.md": "---\nname: watch\ndescription: следит\nallowed-tools: [read_db]\nrequires-approval: T1\n---\nтело",
      "finance/skills/notes.txt": "не навык",
      "_template/skills/example.md": "---\nname: example\n---\nшаблон",
    });
    const metas = loadSkillMeta(dir);
    assert.equal(metas.length, 1, "только один реальный навык");
    const m = metas[0];
    assert.equal(m.name, "watch");
    assert.equal(m.agent, "finance");
    assert.equal(m.requiresApproval, "T1");
    assert.deepEqual(m.allowedTools, ["read_db"]);
    assert.equal(m.problems.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("нет frontmatter → name из имени файла, копятся замечания", () => {
    const dir = makeAgentsDir({ "a/skills/orphan.md": "# нет фронтматтера" });
    const [m] = loadSkillMeta(dir);
    assert.equal(m.name, "orphan", "имя берётся из файла");
    assert.match(m.problems.join("; "), /нет поля name/);
    assert.match(m.problems.join("; "), /нет requires-approval/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("name ≠ имени файла и неизвестный тир — отдельные замечания", () => {
    const dir = makeAgentsDir({
      "a/skills/foo.md": "---\nname: bar\ndescription: d\nrequires-approval: T9\n---\nт",
    });
    const [m] = loadSkillMeta(dir);
    assert.equal(m.requiresApproval, undefined, "T9 не тир");
    assert.match(m.problems.join("; "), /name «bar» ≠ имени файла/);
    assert.match(m.problems.join("; "), /неизвестный тир/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("skillTierFloors — строже побеждает", () => {
  it("одинаковый навык у разных агентов → берётся самый строгий тир", () => {
    const dir = makeAgentsDir({
      "ceo-a/skills/brief.md": "---\nname: brief\ndescription: d\nrequires-approval: T1\n---\nт",
      "ceo-b/skills/brief.md": "---\nname: brief\ndescription: d\nrequires-approval: T3\n---\nт",
    });
    const floors = skillTierFloors(loadSkillMeta(dir));
    assert.equal(floors.get("brief"), "T3", "T3 строже T1 — floor поднимается для всех");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("навык без requires-approval не попадает в карту floor", () => {
    const dir = makeAgentsDir({ "a/skills/x.md": "---\nname: x\ndescription: d\n---\nт" });
    const floors = skillTierFloors(loadSkillMeta(dir));
    assert.equal(floors.has("x"), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("реальные паспорта навыков MYDON", () => {
  it("у каждого навыка есть корректный frontmatter (name/description/тир)", () => {
    const metas = loadSkillMeta(REAL_AGENTS_DIR);
    assert.ok(metas.length >= 20, "навыков должно быть много");
    const bad = metas.filter((m) => m.problems.length > 0);
    assert.equal(
      bad.length,
      0,
      "навыки с замечаниями: " + bad.map((m) => `${m.agent}/${m.name} (${m.problems.join(", ")})`).join("; "),
    );
  });

  it("draft-quote (деньги) объявлен не ниже T3; monitor-stock поднят инструментами до T3", () => {
    const floors = skillTierFloors(loadSkillMeta(REAL_AGENTS_DIR));
    assert.equal(floors.get("draft-quote"), "T3");
    // monitor-stock: requires-approval T1, но exec:check_inventory (exec→T3) поднимает пол.
    assert.equal(floors.get("monitor-stock"), "T3");
  });
});

describe("effectiveActionTier + maxTier", () => {
  it("floor навыка поднимает тир выше карточки агента", () => {
    // Карточка агента T1, навык draft-quote помечен T3 → действие идёт как T3.
    assert.equal(effectiveActionTier("T1", "T3"), "T3");
  });

  it("карточка строже навыка — берётся карточка", () => {
    assert.equal(effectiveActionTier("T4", "T1"), "T4");
  });

  it("floor навыка не задан → тир = карточка агента (поведение как раньше)", () => {
    assert.equal(effectiveActionTier("T2", undefined), "T2");
  });

  it("maxTier: пустой список → T0, иначе самый строгий", () => {
    assert.equal(maxTier([]), "T0");
    assert.equal(maxTier(["T0", "T2", "T1"]), "T2");
  });
});
