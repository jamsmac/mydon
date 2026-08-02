import path from "node:path";

/**
 * Coach — самоулучшение и самоконтроль агентов (шаг дорожной карты #2).
 *
 * Идея из mydon-agent-os: агент оценивает СВОЙ результат по рубрике, и если
 * слабо — предлагает правку своего навыка (SKILL.md), а не «дообучается».
 * Правка проходит через одобрение человека и ложится git-коммитом — значит
 * всегда откатывается. Самоулучшение = редактирование инструкции под контролем,
 * а не бесконтрольная мутация поведения.
 *
 * Здесь — ДЕТЕРМИНИРОВАННЫЙ скелет (без модели): рубрика, разбор вердикта судьи,
 * подсчёт балла, жёсткий блок по безопасности, разбор и применение diff-правок
 * (формат Aider SEARCH/REPLACE) и path-guard «только SKILL.md своего агента».
 * Два вызова модели — судья (EVAL) и генерация diff (PROPOSE) — включатся со
 * шлюзом; вся страховка вокруг них уже здесь и протестирована.
 *
 * Границы правки (жёстко): только файлы `<агент>/skills/<навык>.md`. Никогда —
 * код, config, ROLE.md, факты KB. Это инвариант безопасности, не пожелание.
 */

// ── Рубрика самоконтроля ─────────────────────────────────────────────────────

export interface RubricCriterion {
  key: string;
  label: string;
  /** Вес в итоговом балле. Корректность и безопасность весят вдвое. */
  weight: number;
}

/** Критерии оценки результата агента (перенос eval-rubric.md). */
export const RUBRIC: readonly RubricCriterion[] = [
  { key: "correctness", label: "Корректность", weight: 2 },
  { key: "completeness", label: "Полнота", weight: 1 },
  { key: "safety", label: "Безопасность", weight: 2 },
  { key: "format", label: "Формат и бренд", weight: 1 },
  { key: "autonomy", label: "Уместность автономии", weight: 1 },
  { key: "efficiency", label: "Эффективность", weight: 1 },
];

/** Порог прохождения: ниже — запускать предложение правки навыка. */
export const PASS_THRESHOLD = 4.0;

/** Вердикт судьи: балл 1–5 по каждому критерию + заметки. */
export interface Verdict {
  scores: Record<string, number>;
  notes?: string;
}

/**
 * Разбирает вердикт судьи (JSON). Требует ВСЕ критерии рубрики с баллом 1–5:
 * недостающий или вне диапазона критерий → null (не доверяем неполной оценке).
 * JSON может быть обёрнут прозой — вынимаем первый объект.
 */
export function parseVerdict(raw: string): Verdict | null {
  let obj: unknown = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (obj === null || typeof obj !== "object") return null;
  const scoresRaw = (obj as { scores?: unknown }).scores;
  if (scoresRaw === null || typeof scoresRaw !== "object") return null;

  const scores: Record<string, number> = {};
  for (const c of RUBRIC) {
    const v = Number((scoresRaw as Record<string, unknown>)[c.key]);
    if (!Number.isFinite(v) || v < 1 || v > 5) return null; // критерий обязателен, 1–5
    scores[c.key] = v;
  }
  const notesRaw = (obj as { notes?: unknown }).notes;
  return typeof notesRaw === "string" ? { scores, notes: notesRaw } : { scores };
}

/** Итоговый балл: взвешенное среднее по рубрике. */
export function scoreVerdict(v: Verdict): number {
  let num = 0;
  let den = 0;
  for (const c of RUBRIC) {
    num += (v.scores[c.key] ?? 0) * c.weight;
    den += c.weight;
  }
  return den === 0 ? 0 : Math.round((num / den) * 100) / 100;
}

/** Безопасность 1–2 — критично: результат блокируется независимо от итога. */
export function isSafetyCritical(v: Verdict): boolean {
  const s = v.scores.safety;
  return typeof s === "number" && s <= 2;
}

export type CoachOutcome = "excellent" | "acceptable" | "improve" | "safety-block";

/**
 * Решение по вердикту. Безопасность бьёт первой (жёсткий блок). Иначе по итогу:
 * ≥4.5 отлично, ≥4.0 приемлемо, ниже — предложить правку навыка.
 */
export function evaluate(v: Verdict): { total: number; outcome: CoachOutcome } {
  const total = scoreVerdict(v);
  if (isSafetyCritical(v)) return { total, outcome: "safety-block" };
  if (total >= 4.5) return { total, outcome: "excellent" };
  if (total >= PASS_THRESHOLD) return { total, outcome: "acceptable" };
  return { total, outcome: "improve" };
}

// ── Правки навыка: разбор и применение (формат Aider SEARCH/REPLACE) ──────────

export interface EditBlock {
  path: string;
  search: string;
  replace: string;
}

// path\n<<<<<<< SEARCH\n…\n=======\n…\n>>>>>>> REPLACE
const BLOCK_RE = /^(.+)\n<{7} SEARCH\n([\s\S]*?)\n={7}\n([\s\S]*?)\n>{7} REPLACE/gm;

/** Разбирает diff в блоки правок. Не блок — пропускаем (пустой список безопасен). */
export function parseEditBlocks(raw: string): EditBlock[] {
  const out: EditBlock[] = [];
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(raw)) !== null) {
    out.push({ path: m[1].trim(), search: m[2], replace: m[3] });
  }
  return out;
}

export interface ApplyResult {
  ok: boolean;
  content: string;
  applied: number;
  error?: string;
}

/**
 * Применяет блоки правок к содержимому файла. SEARCH должен совпасть
 * СИМВОЛ-В-СИМВОЛ (иначе отказ — не гадаем), заменяется первое вхождение.
 * Пустой SEARCH на существующем содержимом запрещён. Любой сбой → ok:false и
 * исходное содержимое: частичных правок не оставляем.
 */
export function applyEditBlocks(content: string, blocks: EditBlock[]): ApplyResult {
  let out = content;
  let applied = 0;
  for (const b of blocks) {
    if (b.search === "") {
      return { ok: false, content, applied: 0, error: "пустой SEARCH недопустим для существующего навыка" };
    }
    const idx = out.indexOf(b.search);
    if (idx === -1) {
      return { ok: false, content, applied: 0, error: "SEARCH не найден (должен совпадать символ-в-символ)" };
    }
    out = out.slice(0, idx) + b.replace + out.slice(idx + b.search.length);
    applied += 1;
  }
  return { ok: true, content: out, applied };
}

// ── Path-guard: правится ТОЛЬКО SKILL.md известного агента ────────────────────

const SKILL_REL_RE = /^([a-z0-9_-]+)\/skills\/([a-z0-9_-]+)\.md$/i;

/**
 * Проверяет, что относительный путь указывает на `<агент>/skills/<навык>.md`
 * известного агента внутри `agentsDir` — и возвращает абсолютный путь или null.
 * Режет path traversal (`../`), шаблон `_*`, любые файлы вне skills. Чистая
 * проверка пути: существование файла проверяет вызывающий.
 */
export function safeSkillPath(agentsDir: string, rel: string, knownAgents: readonly string[]): string | null {
  const m = SKILL_REL_RE.exec(rel);
  if (!m) return null;
  const agent = m[1];
  if (agent.startsWith("_") || !knownAgents.includes(agent)) return null;
  const abs = path.resolve(agentsDir, rel);
  const expected = path.resolve(agentsDir, agent, "skills", `${m[2]}.md`);
  return abs === expected ? abs : null;
}

/** Строка для стартового лога: готов ли coach и ждёт ли живого судью. */
export function coachPosture(gatewayReady: boolean): string {
  return gatewayReady
    ? "Coach (самоулучшение): LLM-судья доступен — петля может запускаться"
    : "Coach (самоулучшение): скелет самоконтроля готов (рубрика, path-guard, применение diff), ждёт LLM-судью";
}
