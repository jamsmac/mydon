# Skills deck + cron-допуск llm + мета-навыки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Любой навык агента запускается из панели `/skills` и даёт предложение во Входящих; llm-навыки допускаются на cron через durable-задачи; четыре мета-навыка владельца лежат в `.claude/skills/`.

**Architecture:** Каталог навыков — зеркало файлов в Core (`agent_skill_catalog`, агенты переписывают при старте). Запуск из deck — обычная задача агенту с явным `agent_skill` и `run_options`; worker предпочитает явный навык угадыванию. Cron для llm — только через существующий durable-путь (`ensureAgentSchedule`). Панель — первый экран консольной грамматики `/mydon-design`.

**Tech Stack:** Drizzle (миграция 0087), NestJS (Core), Node `node:test` (agents/core), Next.js 16 + vitest (cc), `tools/smoke-core.mjs` на postgres:17 в CI.

**Spec:** `docs/superpowers/specs/2026-09-05-skills-deck-cron-llm-design.md` (R-SD-1…10)

## Global Constraints

- TypeScript strict, без `any`; русский в UI, английский в коде; Conventional Commits.
- Core-тесты бегут из `dist`: `pnpm --filter @mydon/core build && cd apps/core && node --test dist/<путь>.test.js`. Agents — `pnpm --filter @mydon/agents build && cd apps/agents && node --test dist/<файл>.test.js`. CC — `pnpm --filter cc test -- <файл>`.
- Полный гейт перед PR: `pnpm -r build && pnpm -r test && pnpm -r lint && pnpm -r typecheck` (все пакеты — правка типов задач затрагивает cc/bot).
- Правка общего типа сопровождается `pnpm -r typecheck` сразу (урок 05.09).
- Формы CC — конвенция 24.08 (`onSubmit` + `preventDefault` + `FormData` → server action в `startTransition`; при ошибке поля сохраняют ввод; тест обязателен).
- Дизайн — `.claude/skills/mydon-design/{rules,tokens,primitives,checklist}.md`: новых цветов нет; оранжевая заливка ≤ 1 на экран; кириллица Golos; `.num` для цифр; пустое состояние говорит, что сделать.
- R-SD-10: `durableTaskInputHash` включает `agentSkill`/`runOptions` ТОЛЬКО когда заданы (старые хеши неизменны).
- Никаких секретов в коде; `.env.example` — если появляется новая ручка (здесь не появляется).

---

### Task 1: Схема и миграция 0087 — каталог навыков и поля задачи

**Files:**
- Modify: `packages/db/src/schema.ts` (после `export const agent = pgTable(` … `);` ~строка 1602–1650; поля задачи — в таблице `task`, рядом с `agentRunClaimedAt`)
- Create: `packages/db/drizzle/0087_agent_skill_catalog.sql` (+ `meta/_journal.json`, `meta/0087_snapshot.json` от drizzle-kit)
- Test: `packages/db/src/schema.test.ts` (если есть — добавить проверку экспорта; иначе проверка через сборку и `node tools/pglite-checks/run-migrations.mjs`)

**Interfaces:**
- Produces: `agentSkillCatalog` (drizzle table), `task.agentSkill: text | null`, `task.runOptions: jsonb | null` типа `{ modelEffort?: string }`.

- [ ] **Step 1: Схема.** В `packages/db/src/schema.ts` после таблицы `agent` добавить:

```ts
/**
 * Каталог навыков — ЗЕРКАЛО файлов `apps/agents/agents/<agent>/skills/*.md` (R-SD-1).
 * Агенты переписывают его целиком при каждом успешном старте; панель читает
 * только отсюда. Без FK на `agent`: паспорт может ещё не быть в базе.
 */
export const agentSkillCatalog = pgTable(
  "agent_skill_catalog",
  {
    agentName: text("agent_name").notNull(),
    skill: text("skill").notNull(),
    description: text("description").default("").notNull(),
    /** code | llm — кто исполняет (frontmatter `executor`). */
    executor: text("executor").notNull(),
    /** Минимальный тир (frontmatter `requires-approval`), NULL — не задан. */
    tier: text("tier"),
    triggers: jsonb("triggers").$type<string[]>().default([]).notNull(),
    allowedTools: jsonb("allowed_tools").$type<string[]>().default([]).notNull(),
    modelEffort: text("model_effort"),
    maxTokens: integer("max_tokens"),
    /** Есть код в SKILLS: при executor: llm исполнится код (двусмысленность видна в deck). */
    hasCode: boolean("has_code").default(false).notNull(),
    /** Замечания check-passports к frontmatter. */
    problems: jsonb("problems").$type<string[]>().default([]).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentName, t.skill] })],
);
```

  В таблице `task` после `agentRunClaimedAt` добавить:

```ts
    /** Явный навык (R-SD-3): запуск из deck и по расписанию несут его; без него worker угадывает по тексту. */
    agentSkill: text("agent_skill"),
    /** Параметры запуска из deck (R-SD-4): `{ modelEffort?: string }`. Код-навыки игнорируют. */
    runOptions: jsonb("run_options").$type<{ modelEffort?: string }>(),
```

  Проверить импорты `primaryKey`, `integer`, `boolean` из `drizzle-orm/pg-core` (добавить, если нет). Индекс `task_agent_skill_idx` — частичный, drizzle его не описывает: добавить руками в SQL (шаг 2).

- [ ] **Step 2: Миграция.** `pnpm --filter @mydon/db db:generate`; переименовать полученный файл в `0087_agent_skill_catalog.sql`, в `meta/_journal.json` поставить `"tag": "0087_agent_skill_catalog"`, `idx: 87`. В начало SQL — комментарий «Каталог навыков (зеркало файлов, R-SD-1) и явный навык/параметры запуска у задачи (R-SD-3/4), спека 2026-09-05-skills-deck-cron-llm». В конец добавить:

```sql
--> statement-breakpoint
CREATE INDEX "task_agent_skill_idx" ON "task" ("owner_ref", "agent_skill", "created_at" DESC) WHERE "agent_skill" IS NOT NULL;
```

- [ ] **Step 3: Проверить на настоящем SQL.** `CHECKS_DATABASE_URL=postgres://mydon:mydon@127.0.0.1:55432/mydon node tools/pglite-checks/run-migrations.mjs` — миграция применяется; `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` зелёные.
- [ ] **Step 4: Commit** `feat(db): каталог навыков агентов и явный навык/параметры запуска у задачи (миграция 0087)`.

---

### Task 2: Core — каталог, deck, запуск из deck, явный навык у задачи

**Files:**
- Modify: `apps/core/src/tasks/tasks.service.ts` (`CreateTaskInput`, `create()`, `durableTaskInputHash`, claim `taskInput`, `agentScheduleIdentity`, `assertAgentScheduleReplay`)
- Modify: `apps/core/src/tasks/tasks.controller.ts` (`CreateTaskDto` + маппинг в `create`)
- Modify: `apps/core/src/agents/agents.service.ts` (`syncSkillCatalog`, `skillDeck`, `runSkill`)
- Modify: `apps/core/src/agents/agents.controller.ts` (три маршрута + DTO)
- Modify: `apps/core/src/agents/agents.module.ts` (импорт `TasksModule` или провайдер `TasksService` — как у других модулей, зовущих задачи)
- Test: `apps/core/src/tasks/tasks.test.ts`, `apps/core/src/agents/agents.service.test.ts`, `apps/core/src/agents/agents.controller.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `POST /tasks` принимает `agentSkill?: string`, `runOptions?: { modelEffort?: ModelEffort }`; claim возвращает их в `taskInput`.
  - `PUT /agents/skills/catalog` `{ skills: CatalogSkill[] }` → `{ count, syncedAt }`.
  - `GET /agents/skills` → `SkillDeck = { syncedAt: string | null, models: { primary: string | null, fallbacks: string[] }, items: SkillDeckItem[] }`.
  - `POST /agents/:name/skills/:skill/run` `{ input?, modelEffort?, actor? }` → `{ taskId }`.

- [ ] **Step 1: Тесты задач (RED).** В `tasks.test.ts` добавить: (а) `create` с `agentSkill: "parts-audit"`, `runOptions: { modelEffort: "high" }` → строка задачи хранит оба; (б) `durableTaskInputHash` для задачи БЕЗ полей равен хешу до правки (зафиксировать константу-снимок по существующему тесту или сравнить с вычислением по старой формуле в тесте); (в) хеш С полями отличается; (г) `ensureAgentSchedule` кладёт `agentSkill = skill`, а повтор с существующей строкой, у которой `agent_skill IS NULL` (создана до миграции) — replay без 409.
- [ ] **Step 2: Реализация задач.**

```ts
// tasks.service.ts
export const MODEL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];
export interface TaskRunOptions { modelEffort?: ModelEffort }

export interface CreateTaskInput {
  // …существующие поля…
  /** Явный навык агента (R-SD-3). */
  agentSkill?: string;
  /** Параметры запуска из deck (R-SD-4). */
  runOptions?: TaskRunOptions;
}
// create(): .values({ …, agentSkill: input.agentSkill ?? null, runOptions: input.runOptions ?? null })
// durableTaskInputHash(row): canonicalHash({ …как было…,
//   ...(row.agentSkill ? { agentSkill: row.agentSkill } : {}),
//   ...(row.runOptions && Object.keys(row.runOptions).length > 0 ? { runOptions: row.runOptions } : {}) })
// claim → taskInput: { title, description?, domain?, ...(claimed.agentSkill ? { agentSkill } : {}), ...(claimed.runOptions ? { runOptions } : {}) }
// AgentScheduleTaskIdentity += agentSkill: string; agentScheduleIdentity → agentSkill: input.skill; insert(task).values(expected)
// assertAgentScheduleReplay: exact && (row.agentSkill === null || row.agentSkill === expected.agentSkill)
```

  `CreateTaskDto`: `@IsOptional() @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/) agentSkill?: string;` и `@IsOptional() @ValidateNested() @Type(() => RunOptionsDto) runOptions?: RunOptionsDto` с `class RunOptionsDto { @IsOptional() @IsIn([...MODEL_EFFORTS]) modelEffort?: ModelEffort }`. В `create` контроллера — прокинуть оба.

- [ ] **Step 3: Тесты агентов (RED).** `agents.service.test.ts`: `syncSkillCatalog` заменяет каталог целиком (было 2 строки чужого агента → после sync их нет); `skillDeck`: `enabled` = навык ∈ `agent.skills`, `tierFloor` = max тира у одноимённых, `duplicates`, `lastRun` = последняя задача с `owner_ref`+`agent_skill`, агент из каталога без строки в `agent` → `agentStatus: "draft"`, `enabled: false`; `models` из `LLM_MODEL`/`LLM_FALLBACK_MODELS`. `runSkill`: paused → `ConflictException` с текстом «Агент "x" выключен — включи его в карточке»; навык не в `agent.skills` → 409 «Навык "y" не закреплён за агентом "x"»; нет в каталоге → `NotFoundException`; успех → задача `source: "skills-deck"`, `agentSkill`, `runOptions`, `title` = `Навык <skill>: <первые 60 символов input>` либо `Навык <skill>: запуск из deck`, `createdBy = actor ?? "owner"`, audit `agent.skill.run`. `agents.controller.test.ts`: валидация `CatalogSkillDto` (имена по regex, executor ∈ code|llm, tier ∈ T0..T4) и `RunSkillDto` (`input` ≤ 4000, `modelEffort` ∈ MODEL_EFFORTS).
- [ ] **Step 4: Реализация агентов.**

```ts
// agents.service.ts
export interface CatalogSkillInput { agent: string; skill: string; description: string; executor: "code" | "llm"; tier?: Tier; triggers: string[]; allowedTools: string[]; modelEffort?: string; maxTokens?: number; hasCode: boolean; problems: string[] }
export interface SkillDeckItem extends CatalogSkillInput { agentStatus: "active" | "paused" | "draft" | "deprecated"; business: string; autonomyDefault: Tier; enabled: boolean; crons: string[]; tierFloor: Tier | null; duplicates: number; lastRun: { taskId: string; status: string; createdAt: string; completedAt: string | null; blockedReason: string | null; resultNote: string | null } | null }
async syncSkillCatalog(items: CatalogSkillInput[], actorRef = "agents"): Promise<{ count: number; syncedAt: string }> // transaction: delete(agentSkillCatalog) → insert all (chunks по 100) → auditLog agent.skill_catalog.synced
async skillDeck(): Promise<SkillDeck> // select catalog ⨝ agent (leftJoin по name, archivedAt is null); lastRun — sql `select distinct on (owner_ref, agent_skill) …` из task where owner_kind='agent' and agent_skill is not null order by owner_ref, agent_skill, created_at desc; models — settingValue(db,"LLM_MODEL"), settingValue(db,"LLM_FALLBACK_MODELS").split(",") trimmed non-empty
async runSkill(name: string, skill: string, input: { input?: string; modelEffort?: ModelEffort; actor?: string }): Promise<{ taskId: string }> // проверки R-SD-6 → this.tasks.create({ title, description: input.input, ownerKind: "agent", ownerRef: name, source: "skills-deck", agentSkill: skill, runOptions: modelEffort ? { modelEffort } : undefined, createdBy: actor ?? "owner" }, actor ?? "owner")
```

  Контроллер: `@Put("skills/catalog")` с `SyncCatalogDto { @ValidateNested({each:true}) @Type(()=>CatalogSkillDto) @ArrayMaxSize(1000) skills }`; `@Get("skills")` ОБЪЯВИТЬ ВЫШЕ `@Get(":name")` (иначе «skills» уедет в `:name`); `@Post(":name/skills/:skill/run")` с `RunSkillDto`. Guard: как у остальных мутаций агентов (`UseGuards(OwnerMutationGuard)` только там, где сейчас он стоит для owner-only; `run` — обычная мутация с сервисным токеном, как `POST /tasks`). `tierFloor`: порядок тиров `T0<T1<T2<T3<T4`, максимум по одноимённым.

- [ ] **Step 5: Сборка и тесты.** `pnpm --filter @mydon/core build && cd apps/core && node --test dist/tasks/tasks.test.js dist/agents/agents.service.test.js dist/agents/agents.controller.test.js` — зелёные. `pnpm -r typecheck`.
- [ ] **Step 6: Commit** `feat(core): каталог навыков, deck и запуск навыка из панели; явный навык и параметры запуска у задачи`.

---

### Task 3: Рантайм агентов — каталог в Core, явный навык, усилие per-run, cron для llm

**Files:**
- Create: `apps/agents/src/skill-catalog.ts`, `apps/agents/src/skill-catalog.test.ts`
- Modify: `apps/agents/src/core-client.ts` (`putSkillCatalog`, `AgentTaskClaim.taskInput`), `apps/agents/src/index.ts` (push после seed; `desiredJobs(agents, hasSkill)`; `scheduledInvocationMode(j.skill, …, isLlmSkill)`), `apps/agents/src/task-worker.ts` (явный навык), `apps/agents/src/llm-skill.ts` (`TaskInputLike.runOptions`, effort override), `apps/agents/src/skills.ts` (`SkillRunContext.taskInput` тип += `agentSkill?`, `runOptions?`), `apps/agents/src/schedule.ts`, `apps/agents/src/check-passports.ts`
- Test: `schedule.test.ts`, `task-worker.test.ts`, `llm-skill.test.ts`, `check-passports.test.ts`

**Interfaces:**
- Consumes: Core маршруты Task 2.
- Produces: `catalogFromMetas(metas: SkillMeta[], hasCode: (n)=>boolean): CatalogSkill[]`; `scheduledInvocationMode(skill, hasMetered, isLlm = isLlmSkill)`.

- [ ] **Step 1: Тесты (RED).**
  - `skill-catalog.test.ts`: из двух `SkillMeta` (один `executor: llm` с `requiresApproval: "T1"`, `triggers`, `modelEffort`; другой code с `hasCode=true`) получаем два `CatalogSkill` с полями по спеке; `problems` копируются.
  - `schedule.test.ts`: `scheduledInvocationMode("qualify-lead", () => true, () => true)` → `"durable-task"` (llm не бросает); code-навык с metered вне allowlist по-прежнему бросает; `desiredJobs([agent({skills:["qualify-lead"], schedule:[{cron,skill:"qualify-lead"}]})], hasSkillLike)` даёт задание.
  - `task-worker.test.ts`: `resolveTaskSkill(agent, claim)` (новая чистая функция) — `taskInput.agentSkill` ∈ `agent.skills` и `hasSkill` → он; чужой/нереализованный → fallback на `matchSkill(title)`.
  - `llm-skill.test.ts`: `taskInput.runOptions.modelEffort: "high"` при `meta.modelEffort: "medium"` → `capture[0].reasoningEffort === "high"`; без runOptions — «medium» (существующий тест).
  - `check-passports.test.ts`: llm-навык в расписании больше НЕ даёт замечания R-LS-11 (убрать/инвертировать существующий тест); замечание «executor: llm, но есть код» остаётся.
- [ ] **Step 2: Реализация.**

```ts
// skill-catalog.ts
import type { SkillMeta } from "./skill-loader";
export interface CatalogSkill { agent: string; skill: string; description: string; executor: "code" | "llm"; tier?: string; triggers: string[]; allowedTools: string[]; modelEffort?: string; maxTokens?: number; hasCode: boolean; problems: string[] }
export function catalogFromMetas(metas: readonly SkillMeta[], hasCode: (name: string) => boolean): CatalogSkill[] {
  return metas.map((m) => ({ agent: m.agent, skill: m.name, description: m.description, executor: m.executor, ...(m.requiresApproval ? { tier: m.requiresApproval } : {}), triggers: m.triggers, allowedTools: m.allowedTools, ...(m.modelEffort ? { modelEffort: m.modelEffort } : {}), ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}), hasCode: hasCode(m.name), problems: m.problems }));
}
// core-client.ts: putSkillCatalog(skills: CatalogSkill[]): Promise<{count:number; syncedAt:string}> → PUT /agents/skills/catalog
// index.ts loadFromCore(): после seedAgents — try { const r = await core.putSkillCatalog(catalogFromMetas(skillMetas, hasCodeSkill)); console.log(`Каталог навыков в Core: ${r.count}.`); } catch (e) { console.warn("Каталог навыков не записан в Core:", e); }
// index.ts: desiredJobs(agents, hasSkill) (импорт hasSkill из ./skills); scheduledInvocationMode(j.skill, () => …, isLlmSkill)
// schedule.ts: export function scheduledInvocationMode(skill, hasMeteredWorkflow, isLlm: (s: string) => boolean = () => false) { if (isLlm(skill) || DURABLE_SCHEDULED_SKILLS.includes(skill)) return "durable-task"; … }
//   (default () => false — чтобы schedule.ts не тянул llm-skill и не создавал цикл импортов; index.ts передаёт isLlmSkill явно)
// task-worker.ts: export function resolveTaskSkill(agent, claim): string | null { const explicit = claim.taskInput.agentSkill; if (explicit && agent.skills.includes(explicit) && hasSkill(explicit)) return explicit; return matchSkill(agent, [claim.taskInput.title, claim.taskInput.description].filter(Boolean).join("\n")); } — и использовать вместо текущего matchSkill в месте `const skill = claim.execution?.skill ?? claimedCheckpoint?.skill ?? …`
// llm-skill.ts: TaskInputLike += agentSkill?: string; runOptions?: { modelEffort?: ModelReasoningEffort }; в call: reasoningEffort: input.runOptions?.modelEffort ?? meta.modelEffort (только если не undefined)
// check-passports.ts checkLinks(): убрать цикл с замечанием R-LS-11 и обновить doc-comment («cron для llm открыт через durable-задачи, R-SD-5»)
```

  Комментарий в `index.ts` у `desiredJobs` переписать: «llm-навык на cron идёт durable-задачей (R-SD-5), а не in-process — деньги через Core-ledger, повтор — replay по clientKey».

- [ ] **Step 3: Сборка и тесты.** `pnpm --filter @mydon/agents build && cd apps/agents && node --test dist/skill-catalog.test.js dist/schedule.test.js dist/task-worker.test.js dist/llm-skill.test.js dist/check-passports.test.js`; затем ВСЕ тесты агентов (`find dist -name '*.test.js' | xargs node --test`) и `pnpm --filter @mydon/agents check:passports` — зелёные.
- [ ] **Step 4: Commit** `feat(agents): каталог навыков в Core, явный навык задачи, усилие per-run, cron-допуск llm через durable-задачи`.

---

### Task 4: Панель `/skills` — deck, карта навыков, консольная грамматика

**Files:**
- Modify: `apps/cc/src/lib/core.ts` (типы `SkillDeckItem`, `SkillDeck`; `skillDeck()`, `runSkill()`)
- Create: `apps/cc/src/app/skills/page.tsx`, `apps/cc/src/app/skills/actions.ts`, `apps/cc/src/components/skills-deck.tsx`, `apps/cc/src/components/skill-tree.tsx`, `apps/cc/src/components/console-theme.tsx`
- Modify: `apps/cc/src/app/globals.css` (`.panel.console`, `.led`, `.av8`), `apps/cc/src/components/nav.tsx` (пункт «Навыки»)
- Test: `apps/cc/src/components/skills-deck.test.tsx`, `apps/cc/src/components/skill-tree.test.tsx`

**Interfaces:**
- Consumes: `GET /agents/skills`, `POST /agents/:name/skills/:skill/run` (Task 2).
- Produces: маршрут `/skills`.

- [ ] **Step 1: Прочитать `.claude/skills/mydon-design/{rules,tokens,primitives,checklist}.md`** и эталон `apps/cc/src/app/agents/page.tsx` (`TIER_LABEL`, `BUSINESS_LABEL` — переиспользовать импортом, не копировать).
- [ ] **Step 2: Тесты (RED).** `skills-deck.test.tsx` по образцу `agent-forms.test.tsx` (моки `next/navigation` и `../app/skills/actions`): (а) чип агента фильтрует карточки; (б) отказ `runSkill` → текст ошибки виден, textarea сохраняет введённый текст; (в) успех → `refresh` вызван, видна ссылка «открыть задачу»; (г) у `agentStatus: "paused"` кнопка `disabled` с подсказкой; (д) select «Усилие» есть только у `executor: "llm"`. `skill-tree.test.tsx`: навык у двух агентов показан с «×2» и «тир не ниже …».
- [ ] **Step 3: Реализация.**

```ts
// lib/core.ts
export interface SkillDeckItem { agent: string; skill: string; description: string; executor: "code" | "llm"; tier: "T0"|"T1"|"T2"|"T3"|"T4" | null; triggers: string[]; allowedTools: string[]; modelEffort: string | null; maxTokens: number | null; hasCode: boolean; problems: string[]; agentStatus: "active"|"paused"|"draft"|"deprecated"; business: string; autonomyDefault: "T0"|"T1"|"T2"|"T3"|"T4"; enabled: boolean; crons: string[]; tierFloor: "T0"|"T1"|"T2"|"T3"|"T4" | null; duplicates: number; lastRun: { taskId: string; status: string; createdAt: string; completedAt: string | null; blockedReason: string | null; resultNote: string | null } | null }
export interface SkillDeck { syncedAt: string | null; models: { primary: string | null; fallbacks: string[] }; items: SkillDeckItem[] }
skillDeck: () => get<SkillDeck>("/agents/skills"),
runSkill: (agent: string, skill: string, input: { input?: string; modelEffort?: string; actor?: string }) => send<{ taskId: string }>(`/agents/${encodeURIComponent(agent)}/skills/${encodeURIComponent(skill)}/run`, "POST", input),
// app/skills/actions.ts ("use server"): export async function runSkill(agent: string, skill: string, form: FormData): Promise<ActionResult & { taskId?: string }> — input = String(form.get("input") ?? "").trim(); effort = String(form.get("modelEffort") ?? ""); core.runSkill(agent, skill, { ...(input ? { input } : {}), ...(effort ? { modelEffort: effort } : {}), actor: "owner" }); revalidatePath("/skills"); { ok: true, taskId, goTo: `/tasks/${taskId}` }
// app/skills/page.tsx: export const dynamic = "force-dynamic"; core.skillDeck() в try/catch → CoreDown; <ConsoleTheme/>; .page-head: <h1>Навыки</h1><p className="lead">{items.length} навыков у {agents} агентов · каталог обновлён {syncedAt ? when(syncedAt) : "ещё нет"} · модель {models.primary ?? "не задана"}{fallbacks.length ? ` (+${fallbacks.length} запасных)` : ""}</p>; items.length === 0 → .empty «Каталог ещё не синхронизирован» + «Перезапусти контейнер агентов — он перепишет каталог при старте.»; иначе <SkillsDeck deck={deck}/> и раздел «Карта навыков» <SkillTree items={items}/>
// components/console-theme.tsx ("use client"): useEffect(() => { const el = document.documentElement; const prev = el.dataset.theme; el.dataset.theme = "dark"; return () => { if (prev === undefined) delete el.dataset.theme; else el.dataset.theme = prev; }; }, []); return null;
// components/skills-deck.tsx ("use client"): состояние фильтра agent|business; чипы `.chip` (активный — .chip.on если есть в primitives, иначе aria-pressed); сетка `.grid` из карточек:
//   <section className="panel console"> <div className="eyebrow">{business label} · <span className="av8" aria-hidden data-name={agent}/> {agent} <span className={`led ${agentStatus==="active"?"working":agentStatus==="paused"?"idle":"blocked"}`}>{словами}</span></div>
//   <h3>{skill}</h3><p>{description}</p><div className="pills"><span className="pill">{executor==="llm"?"модель":"код"}</span><span className="pill">{TIER_LABEL[tier] ?? "тир не задан"}</span>{modelEffort && <span className="pill">усилие {modelEffort}</span>}{crons.length>0 && <span className="pill">{crons.length} расписан…</span>}{!enabled && <span className="pill">выключен у агента</span>}{hasCode && executor==="llm" && <span className="pill warn">исполнится код</span>}</div>
//   Последний запуск: lastRun ? `${STATUS_LABEL[status]} · ${when(createdAt)}` + <Link href={`/tasks/${taskId}`}>открыть</Link> + blockedReason : «ещё не запускался»
//   <form onSubmit={…}> <textarea name="input" placeholder="Вход задачи (необязательно)"/> {executor==="llm" && <select name="modelEffort"><option value="">как в навыке</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select>} <button className="btn" disabled={!canRun || pending} title={canRun ? undefined : "включи агента в карточке"}>Запустить</button> {error && <div className="warn">{error}</div>} {taskId && <div>Задача поставлена — <Link href={`/tasks/${taskId}`}>открыть</Link></div>} </form>
//   canRun = agentStatus === "active" && enabled
// components/skill-tree.tsx: группировка по агенту: <div className="rows"> строки «агент» → вложенные строки навыков с `allowedTools.join(", ")`; дубли: const byName = count; если >1 → «×N, тир не ниже {tierFloor}»
// globals.css (рядом с .card, и в обеих ветках темы только если понадобятся токены — здесь нет):
//   .panel.console { background: var(--surf); border: 1px solid var(--line-strong); border-radius: var(--r-s); box-shadow: 4px 4px 0 var(--line); padding: 16px; }
//   .led { display: inline-flex; align-items: center; gap: 6px; font-family: var(--fm); font-size: 11px; color: var(--tx-2); } .led::before { content: ""; width: 8px; height: 8px; background: currentColor; }
//   .led.idle { color: var(--ok); } .led.working { color: var(--accent-tx); } .led.blocked { color: var(--err); }
//   .av8 { display: inline-block; width: 16px; height: 16px; image-rendering: pixelated; background: var(--agent); mask: …8×8 из data-name — если mask по имени сложен, допустимо inline <svg> 8×8 с детерминированными клетками от hash(name) в компоненте Av8 (цвет через currentColor = var(--agent)) }
// nav.tsx MAIN: после Агенты — { href: "/skills", icon: "spark", label: "Навыки" }
```

  Проверить токены `--ok`, `--err`, `--agent`, `--accent-tx`, `--line-strong`, `--r-s` в `tokens.md`/`globals.css` — если какого-то нет, использовать ближайший СУЩЕСТВУЮЩИЙ, новых не заводить.

- [ ] **Step 4: Тесты и чек-лист.** `pnpm --filter cc test -- skills-deck skill-tree` зелёные; `pnpm --filter cc typecheck && pnpm --filter cc lint`. Пройти `checklist.md` (контраст в обеих темах, одна оранжевая заливка максимум — здесь ноль, формы по конвенции, ширина 390px без горизонтального скролла: сетка `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`).
- [ ] **Step 5: Commit** `feat(cc): экран «Навыки» — deck с запуском, карта навыков, консольная грамматика (первый экран /mydon-design)`.

---

### Task 5: Smoke-сценарий и документы

**Files:**
- Modify: `tools/smoke-core.mjs` (новый сценарий + вызов в списке + счётчик сценариев в заголовке/итоге)
- Create: `docs/decisions/2026-09-05-skills-deck-cron-llm.md`
- Modify: `docs/AGENTIC_OS_ARMS_PLAN.md` (§9 блок «Сделано» — строка про остаток волны S), `docs/AGENTS_ACTIVATION.md` (раздел «Deck и cron llm-навыков»), `docs/FIRST_LOGIN_CHECKLIST.md` (пункт «какие навыки перевести в executor: llm и поставить на cron — теперь можно»)

- [ ] **Step 1: Smoke.** Функция `проверитьКаталогНавыковИDeck()` по образцу `проверитьУзлыСНомерами`: `PUT /agents/skills/catalog` с двумя навыками агента `smoke-agent-<stamp>` (создать агента `POST /agents` status active, skills оба, schedule []); `GET /agents/skills` → оба есть, `enabled: true`, `agentStatus: "active"`, `tierFloor`; `POST /agents/<name>/skills/<skill>/run` `{input: "проверка", modelEffort: "low"}` → `taskId`; `GET /tasks/<taskId>` → `source === "skills-deck"`, `agentSkill`, `runOptions.modelEffort === "low"`; `PATCH /agents/<name>` status paused → run → 409; в конце `DELETE /agents/<name>` (архив). Добавить вызов в общий список и поправить число сценариев там, где оно печатается (искать «сценар» в файле).
- [ ] **Step 2: Прогнать smoke на scratch-базе.** `SMOKE_SCRATCH=1 DATABASE_URL=postgres://mydon:mydon@127.0.0.1:55432/mydon_smoke … node tools/smoke-core.mjs` — как описано в шапке файла (сначала прочитать шапку: там точные переменные и порядок «поднять Core на scratch → прогнать»). Все сценарии ✔.
- [ ] **Step 3: Документы.** Decision-файл по образцу `docs/decisions/2026-08-22-navigaciya-i-gamma.md`: решения (каталог как зеркало в отдельной таблице; запуск = задача; per-run только усилие; llm на cron только durable; тёмная тема через `ConsoleTheme` на маршруте) с причинами и ценой ошибки. ARMS §9: добавить строку «05.09: остаток волны S закрыт — deck `/skills`, cron для llm, мета-навыки (PR …)». `AGENTS_ACTIVATION.md`: как включить llm-навык на cron (frontmatter `executor: llm` + `schedule` в паспорте; `check:passports`; деньги — ledger; где смотреть задачу).
- [ ] **Step 4: Commit** `test(tools),docs: smoke «каталог навыков и запуск из deck»; решение по deck/cron llm; рунбук и план ARMS`.

---

### Task 6: Мета-навыки владельца

**Files:**
- Create: `.claude/skills/devil/SKILL.md`, `.claude/skills/burst/SKILL.md`, `.claude/skills/plan-for-goal/SKILL.md`, `.claude/skills/search-connectors/SKILL.md`

- [ ] **Step 1: Образец** — `.claude/skills/align/SKILL.md` (frontmatter `name`, `description` с триггерными словами; разделы «Когда», «Шаги», «Формат», «Чего не делать»; русский; ссылки на правила MYDON). Объём каждого — 40–80 строк.
- [ ] **Step 2: Содержание.**
  - `devil`: триггеры «devil», «возрази», «контр-мнение», «что не так», «адвокат дьявола». Шаги: назвать решение одной строкой → 3–5 возражений (каждое: что сломается · во сколько обойдётся · как проверить дёшево) → вердикт `делать | переделать | отложить` → если решение принципиальное, ссылка на `docs/decisions/`. Правило: возражение без цены ошибки не считается. Чего не делать: не спорить с фактами из `memory/constraints.md`; не предлагать варианты А/Б/В.
  - `burst`: триггеры «burst», «варианты», «покажи 3 варианта», «набросай». Шаги: N (по умолчанию 3) вариантов, каждый — тезис в одну строку + чем отличается; экраны — через `/mydon-design` (ASCII-макет или `design/*.html`); тексты — целиком; затем «выбираю №, потому что …». Чего не делать: варианты-клоны; больше 5.
  - `plan-for-goal`: триггеры «plan-for-goal», «план от цели», «распиши план». 10 секций: Цель · Зачем · Критерий успеха · Объём · Не войдёт · Подход · Шаги (проверяемые) · Риски и цена ошибки · Контрольные точки · Журнал решений. Совместимость: результат сохраняется как `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`, дальше — `superpowers:writing-plans`. Чего не делать: шаги без критерия проверки; «TBD».
  - `search-connectors`: триггеры «search-connectors», «найди коннектор», «есть ли API/MCP/CLI для …». Порядок: официальный API/SDK → CLI/API/MCP сообщества → проверка по `engine/security.md` (denylist, research-политика) → таблица `источник · доступ (ключ/OAuth/подписка) · цена · риск · рекомендация` → если для агента — паспорт `solution-scout` (навык `find-solution`) как исполнитель. Чего не делать: неофициальные ключи; коннекторы, пишущие от имени владельца, без тира T3.
- [ ] **Step 3: Проверка.** У каждого файла валидный frontmatter (`---` … `---`, `name` совпадает с папкой); `grep -c "Чего не делать" .claude/skills/*/SKILL.md` — 4 новых файла по 1.
- [ ] **Step 4: Commit** `docs(skills): мета-навыки devil, burst, plan-for-goal, search-connectors`.

---

## Self-review

- Спека §3–§8 → задачи: R-SD-1 (T1, T2, T3), R-SD-2/6/7 (T2, T4), R-SD-3 (T2, T3), R-SD-4 (T2, T3, T4), R-SD-5 (T3), R-SD-8 (T4), R-SD-9 (T6), R-SD-10 (T2), §9 smoke (T5), §10 приёмка — после мержа, вне плана.
- Имена сквозные: `agentSkill`/`runOptions`/`agent_skill`/`run_options`; `CatalogSkill` (agents) ↔ `CatalogSkillInput` (core) ↔ `SkillDeckItem` (core/cc); маршрут `/agents/skills` объявлен выше `:name`.
- Заглушек нет; каждый шаг с командой проверки.
