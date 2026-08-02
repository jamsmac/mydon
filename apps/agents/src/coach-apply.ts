import { applyEditBlocks, parseEditBlocks, safeSkillPath } from "./coach";

/**
 * Применение одобренной правки coach — замкнуть петлю самоулучшения БЕЗОПАСНО.
 *
 * Coach предлагает diff к SKILL.md, владелец одобряет — здесь правка ложится в
 * файл и git-коммитом (обратимо). Инварианты безопасности (все проверяются):
 *  • путь — только `<агент>/skills/<навык>.md` известного агента (safeSkillPath);
 *  • КАЖДЫЙ блок diff указывает на ТОТ ЖЕ файл (не даём протащить чужой путь);
 *  • SEARCH совпадает символ-в-символ, иначе отказ (без частичных правок);
 *  • коммит только при успехе; откат всегда `git revert`/`git checkout`.
 *
 * ЧЕСТНО про запуск: это деливерейт-операция там, где есть репозиторий и git
 * (обслуживающий скрипт / CI / машина владельца), а НЕ в эфемерном контейнере
 * агентов в проде — тот собран из dist и коммитить в прод не должен. fs и git
 * инъектируются: логика тестируется без реального диска и репозитория.
 */

export interface ApplyDeps {
  agentsDir: string;
  knownAgents: readonly string[];
  readFile: (abs: string) => string;
  writeFile: (abs: string, content: string) => void;
  /** Запуск git: возвращает код и вывод. Инъектируется (в тестах — фейк). */
  git: (args: string[]) => { code: number; stdout: string; stderr: string };
}

export interface ApplyOutcome {
  ok: boolean;
  detail: string;
  commit?: string;
}

/** Применяет одобренный diff к SKILL.md и коммитит. Любой сбой → ok:false без коммита. */
export function applyCoachEdit(deps: ApplyDeps, input: { skillRel: string; diff: string }): ApplyOutcome {
  const abs = safeSkillPath(deps.agentsDir, input.skillRel, deps.knownAgents);
  if (abs === null) {
    return { ok: false, detail: `путь вне skills/*.md или неизвестный агент: ${input.skillRel}` };
  }

  const blocks = parseEditBlocks(input.diff);
  if (blocks.length === 0) return { ok: false, detail: "в diff нет блоков правок" };
  if (blocks.some((b) => b.path !== input.skillRel)) {
    return { ok: false, detail: "блок diff указывает на другой файл — отклонено (правим только одобренный навык)" };
  }

  let content: string;
  try {
    content = deps.readFile(abs);
  } catch (err) {
    return { ok: false, detail: `файл навыка не прочитан: ${err instanceof Error ? err.message : String(err)}` };
  }

  const applied = applyEditBlocks(content, blocks);
  if (!applied.ok) return { ok: false, detail: applied.error ?? "правка не применилась" };

  deps.writeFile(abs, applied.content);

  // git add по АБСОЛЮТНОМУ пути — работает из любого cwd, без допущений о корне.
  const add = deps.git(["add", abs]);
  if (add.code !== 0) return { ok: false, detail: `git add не удался: ${add.stderr.slice(0, 200)}` };
  const commit = deps.git(["commit", "-m", `coach: улучшение ${input.skillRel} (одобрено владельцем)`]);
  if (commit.code !== 0) return { ok: false, detail: `git commit не удался: ${commit.stderr.slice(0, 200)}` };
  const rev = deps.git(["rev-parse", "HEAD"]);

  return { ok: true, detail: `правка применена и закоммичена (${applied.applied} блок(ов))`, commit: rev.stdout.trim() || undefined };
}
