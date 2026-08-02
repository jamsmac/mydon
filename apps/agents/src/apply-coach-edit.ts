/**
 * CLI: применить одобренную правку навыка от coach (замкнуть петлю самоулучшения).
 *
 * Запускается ТАМ, где есть репозиторий и git (обслуживающий скрипт / CI /
 * машина владельца) — не в проде. Все инварианты безопасности — в applyCoachEdit
 * (path-guard, блоки только одобренного файла, git-коммит, обратимо).
 *
 * Запуск: node dist/apply-coach-edit.js <агент/skills/навык.md> <файл-с-diff>
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyCoachEdit } from "./coach-apply";
import { loadSkillMeta } from "./skill-loader";

const AGENTS_DIR = path.resolve(__dirname, "../agents");

function runGit(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? String(err) };
  }
}

function main(): void {
  const skillRel = process.argv[2];
  const diffPath = process.argv[3];
  if (!skillRel || !diffPath) {
    console.error("Использование: apply-coach-edit <агент/skills/навык.md> <файл-с-diff>");
    process.exit(2);
  }

  const diff = fs.readFileSync(diffPath, "utf8");
  const knownAgents = [...new Set(loadSkillMeta(AGENTS_DIR).map((m) => m.agent))];

  const res = applyCoachEdit(
    {
      agentsDir: AGENTS_DIR,
      knownAgents,
      readFile: (abs) => fs.readFileSync(abs, "utf8"),
      writeFile: (abs, content) => fs.writeFileSync(abs, content),
      git: runGit,
    },
    { skillRel, diff },
  );

  console.log(res.ok ? `OK: ${res.detail}${res.commit ? ` (commit ${res.commit})` : ""}` : `ОТКАЗ: ${res.detail}`);
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main();
