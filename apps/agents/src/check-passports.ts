/**
 * Проверка целостности паспортов агентов.
 *
 * Ищет то, что ломается МОЛЧА:
 *  • расписание зовёт несуществующий навык — задание не выполнится, и никто не заметит;
 *  • неизвестный статус — движок не поймёт, запускать агента или нет;
 *  • нет mission/non_goals — границы роли не заданы, агент выйдет за них,
 *    хотя в шаблоне _template эти поля есть, то есть это принятый стандарт.
 *
 * Запуск: pnpm --filter @mydon/agents check:passports
 */
import fs from "node:fs";
import path from "node:path";

/** «shared» — кросс-доменный агент: рантайм подставляет это значение по умолчанию. */
const DOMAINS = ["globerent", "vendhub", "personal", "mydon", "shared"];
const STATUSES = ["active", "paused"];

interface ScheduleEntry {
  cron?: string;
  skill?: string;
}
interface Passport {
  business?: string;
  status?: string;
  mission?: string;
  non_goals?: string[];
  schedule: ScheduleEntry[];
}

/**
 * Минимальный разбор YAML — ровно под формат паспортов.
 *
 * `schedule: []` означает ПУСТОЙ список (агент работает по событию, а не по cron).
 * Разбор, который считал это началом списка, подхватывал следующие пункты файла
 * и выдавал несуществующие «битые расписания» — ложная тревога хуже молчания.
 */
export function parsePassport(text: string): Passport {
  const out: Passport & Record<string, unknown> = { schedule: [] };
  let listKey: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const top = /^([a-z_]+):\s*(.*)$/i.exec(line);
    if (top) {
      const [, key, value] = top;
      if (value === "[]") {
        out[key] = [];
        listKey = null;
      } else if (value === "") {
        listKey = key;
        if (!out[key]) out[key] = [];
      } else {
        out[key] = value.replace(/^["']|["']$/g, "");
        listKey = null;
      }
      continue;
    }

    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && listKey) {
      const kv = /^([a-z_]+):\s*(.*)$/i.exec(item[1]);
      if (kv && listKey === "schedule") {
        out.schedule.push({ [kv[1]]: kv[2].replace(/^["']|["']$/g, "") });
      } else if (Array.isArray(out[listKey])) {
        (out[listKey] as string[]).push(item[1].replace(/^["']|["']$/g, ""));
      }
      continue;
    }

    const sub = /^\s+([a-z_]+):\s*(.*)$/i.exec(line);
    if (sub && listKey === "schedule" && out.schedule.length > 0) {
      const last = out.schedule[out.schedule.length - 1] as Record<string, string>;
      last[sub[1]] = sub[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

export interface PassportCheck {
  name: string;
  status: string;
  schedules: number;
  skills: number;
  problems: string[];
}

export function checkPassport(name: string, cfg: Passport, skills: string[]): PassportCheck {
  const problems: string[] = [];

  if (!cfg.business) problems.push("нет направления");
  else if (!DOMAINS.includes(cfg.business)) problems.push(`неизвестное направление «${cfg.business}»`);

  if (!cfg.status) problems.push("нет статуса");
  else if (!STATUSES.includes(cfg.status)) problems.push(`неизвестный статус «${cfg.status}»`);

  if (!cfg.mission) problems.push("нет mission — границы роли не заданы");
  if (!Array.isArray(cfg.non_goals) || cfg.non_goals.length === 0) problems.push("нет non_goals");

  for (const s of cfg.schedule) {
    if (!s.skill) {
      problems.push("в расписании нет навыка");
      continue;
    }
    if (!skills.includes(s.skill)) problems.push(`расписание зовёт навык «${s.skill}» — файла нет`);
    if (s.cron && s.cron.trim().split(/\s+/).length !== 5) {
      problems.push(`битое расписание «${s.cron}»`);
    }
  }

  return { name, status: cfg.status ?? "—", schedules: cfg.schedule.length, skills: skills.length, problems };
}

export function checkAll(dir: string): PassportCheck[] {
  return fs
    .readdirSync(dir)
    .filter((d) => d !== "_template" && fs.statSync(path.join(dir, d)).isDirectory())
    .map((name) => {
      const base = path.join(dir, name);
      const cfgPath = path.join(base, "config.yaml");
      if (!fs.existsSync(cfgPath)) {
        return { name, status: "—", schedules: 0, skills: 0, problems: ["нет файла паспорта"] };
      }
      const skillsDir = path.join(base, "skills");
      const skills = fs.existsSync(skillsDir)
        ? fs.readdirSync(skillsDir).map((f) => f.replace(/\.md$/, ""))
        : [];
      return checkPassport(name, parsePassport(fs.readFileSync(cfgPath, "utf8")), skills);
    });
}

function main(): void {
  const dir = process.argv[2] ?? path.resolve(__dirname, "../agents");
  const rows = checkAll(dir);

  console.log("");
  console.log("  агент                статус    расписаний  навыков  замечания");
  console.log("  ──────────────────────────────────────────────────────────────────────────");
  for (const r of rows) {
    console.log(
      "  " +
        r.name.padEnd(20) +
        r.status.padEnd(10) +
        String(r.schedules).padEnd(12) +
        String(r.skills).padEnd(9) +
        (r.problems.length ? r.problems.join("; ") : "—"),
    );
  }

  const bad = rows.filter((r) => r.problems.length > 0);
  console.log("");
  console.log(
    `  паспортов: ${rows.length}, активных: ${rows.filter((r) => r.status === "active").length}, с замечаниями: ${bad.length}`,
  );
  console.log(bad.length === 0 ? "  ИТОГ: все паспорта целые." : "  ИТОГ: есть замечания — см. выше.");
  process.exit(bad.length === 0 ? 0 : 1);
}

if (require.main === module) main();
