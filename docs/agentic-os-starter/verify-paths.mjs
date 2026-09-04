#!/usr/bin/env node
/**
 * verify-paths.mjs — проверка ссылок пакета agentic-os-starter.
 *
 * Идёт по всем .md / .yaml пакета, вытаскивает пути в обратных кавычках, похожие на пути репозитория,
 * и проверяет, что каждый существует либо в корне репо, либо в самом пакете (файлы, которые пакет добавляет).
 * Роутеры — карта для агента: битая ссылка в карте хуже отсутствия карты.
 *
 * Запуск из корня репо:  node docs/agentic-os-starter/verify-paths.mjs
 * Код возврата 1, если есть битые ссылки.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = here;
const repoRoot = resolve(here, "..", "..");

const ROOTS = new Set([
  "apps", "packages", "docs", "deploy", "tools", "engine", "design", "data", "routers", "memory",
  "ventures", ".claude", ".github", ".superpowers", "CLAUDE.md", "AGENTS.md", "README.md", "MEMORY.md",
  "turbo.json", "pnpm-workspace.yaml", "tsconfig.base.json", "eslint.config.mjs", "package.json", ".env.example",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(md|ya?ml)$/.test(name)) out.push(p);
  }
  return out;
}

// Путь считается ссылкой на репо, если начинается с известного корня и не содержит плейсхолдеров.
function looksLikeRepoPath(s) {
  if (!/^[A-Za-z0-9_.@/\-\[\]]+$/.test(s)) return false;
  if (s.includes("<") || s.includes("…") || s.includes("*") || s.includes("{")) return false;
  const first = s.split("/")[0];
  return ROOTS.has(first) && (s.includes("/") || s.includes("."));
}

function exists(rel) {
  // [name] в маршрутах Next — реальные каталоги, ничего не подставляем.
  if (existsSync(join(repoRoot, rel)) || existsSync(join(pkgRoot, rel))) return true;
  // В пакете навыки лежат в claude-skills/ (без точки) и переезжают в .claude/skills/ при apply.
  if (rel.startsWith(".claude/skills/")) return existsSync(join(pkgRoot, "claude-skills", rel.slice(".claude/skills/".length)));
  return false;
}

const files = walk(pkgRoot);
const missing = [];
let checked = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const relFile = f.slice(repoRoot.length + 1);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    // Запланированные, ещё не существующие файлы помечаются внутри кавычек: `path (план)` — не проверяем.
    if (/\((план|plan)\)\s*$/.test(m[1])) continue;
    let s = m[1].trim();
    // отрезаем хвосты вида "file.ts:12", "(комментарий)", "→ …"
    s = s.replace(/:\d+(-\d+)?$/, "").replace(/\s.*$/, "");
    if (!looksLikeRepoPath(s)) continue;
    checked++;
    if (!exists(s)) missing.push({ file: relFile, ref: s });
  }
}

if (missing.length) {
  console.log(`Проверено ссылок: ${checked}. БИТЫЕ: ${missing.length}`);
  for (const m of missing) console.log(`  ${m.file}  →  ${m.ref}`);
  process.exit(1);
} else {
  console.log(`Проверено ссылок: ${checked}. Битых нет.`);
}
