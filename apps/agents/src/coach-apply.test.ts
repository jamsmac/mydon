import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { applyCoachEdit, type ApplyDeps } from "./coach-apply";

const AGENTS = "/repo/apps/agents/agents";
const KNOWN = ["mydon-finance"];
const REL = "mydon-finance/skills/watch-receivables.md";
const ABS = path.join(AGENTS, "mydon-finance", "skills", "watch-receivables.md");

const DIFF = [
  REL,
  "<<<<<<< SEARCH",
  "старый шаг",
  "=======",
  "новый шаг",
  ">>>>>>> REPLACE",
].join("\n");

/** Фейковые fs+git: пишем в память, git всегда ок и логирует команды. */
function fakeDeps(over: Partial<ApplyDeps> = {}): { deps: ApplyDeps; files: Map<string, string>; gitLog: string[][] } {
  const files = new Map<string, string>([[ABS, "инструкция\nстарый шаг\nконец"]]);
  const gitLog: string[][] = [];
  const deps: ApplyDeps = {
    agentsDir: AGENTS,
    knownAgents: KNOWN,
    readFile: (abs) => {
      const c = files.get(abs);
      if (c === undefined) throw new Error("нет файла");
      return c;
    },
    writeFile: (abs, content) => files.set(abs, content),
    git: (args) => {
      gitLog.push(args);
      return { code: 0, stdout: args[0] === "rev-parse" ? "abc123\n" : "", stderr: "" };
    },
    ...over,
  };
  return { deps, files, gitLog };
}

describe("applyCoachEdit — безопасное применение правки", () => {
  it("успех: файл правится, коммитится, возвращается commit", () => {
    const { deps, files, gitLog } = fakeDeps();
    const res = applyCoachEdit(deps, { skillRel: REL, diff: DIFF });
    assert.equal(res.ok, true);
    assert.equal(res.commit, "abc123");
    assert.match(files.get(ABS) ?? "", /новый шаг/);
    assert.deepEqual(gitLog.map((g) => g[0]), ["add", "commit", "rev-parse"]);
  });

  it("путь вне skills/*.md → отказ, без git", () => {
    const { deps, gitLog } = fakeDeps();
    const res = applyCoachEdit(deps, { skillRel: "mydon-finance/config.yaml", diff: DIFF });
    assert.equal(res.ok, false);
    assert.match(res.detail, /путь вне skills/);
    assert.equal(gitLog.length, 0);
  });

  it("неизвестный агент → отказ", () => {
    const { deps } = fakeDeps();
    const res = applyCoachEdit(deps, { skillRel: "hacker/skills/x.md", diff: DIFF.replace(REL, "hacker/skills/x.md") });
    assert.equal(res.ok, false);
  });

  it("блок diff указывает на другой файл → отклонено", () => {
    const { deps, gitLog } = fakeDeps();
    const evil = DIFF.replace(REL, "mydon-finance/skills/other.md");
    const res = applyCoachEdit(deps, { skillRel: REL, diff: evil });
    assert.equal(res.ok, false);
    assert.match(res.detail, /другой файл/);
    assert.equal(gitLog.length, 0, "ничего не коммитим");
  });

  it("SEARCH не совпал → отказ, файл не тронут, без коммита", () => {
    const { deps, files, gitLog } = fakeDeps();
    const bad = DIFF.replace("старый шаг", "НЕТ ТАКОГО");
    const res = applyCoachEdit(deps, { skillRel: REL, diff: bad });
    assert.equal(res.ok, false);
    assert.equal(files.get(ABS), "инструкция\nстарый шаг\nконец", "файл не изменён");
    assert.equal(gitLog.length, 0);
  });

  it("git commit упал → ok=false", () => {
    const { deps } = fakeDeps({
      git: (args) => (args[0] === "commit" ? { code: 1, stdout: "", stderr: "nothing to commit" } : { code: 0, stdout: "", stderr: "" }),
    });
    const res = applyCoachEdit(deps, { skillRel: REL, diff: DIFF });
    assert.equal(res.ok, false);
    assert.match(res.detail, /git commit/);
  });

  it("пустой diff → отказ", () => {
    const { deps } = fakeDeps();
    assert.equal(applyCoachEdit(deps, { skillRel: REL, diff: "просто текст" }).ok, false);
  });
});
