# Роутер · MYDON — Command Center, общие агенты, система

**Домен в коде:** `mydon` (+ `shared` как `business` общих агентов).
**Назначение:** всё сквозное — оркестрация, согласования, задачи, журнал, LLM-контур, оболочка.

## Агенты (business = shared)

| Агент | Статус | Тир | Навыки | Cron | Исполнение |
|---|---|---|---|---|---|
| `chief-of-staff` | active | T1 | route-task · morning-digest · evening-standup | 09:00, 19:00 | `morning-digest` исполняется; `route-task`, `evening-standup` — паспорт без кода |
| `coach-agent` | active | T2 | coach-review | Пн 10:00 | исполняется (`coach.ts`, `coach-review.ts`, `coach-apply.ts`): судья по `engine/eval-rubric.md`, diff к SKILL.md через согласование |
| `knowledge-curator` | paused | T2 | kb-review · scan-ideas · assess-ideas | каждые 7 дней; Пн 09:00 | `scan-ideas`, `assess-ideas` исполняются (`ideas.ts`); `kb-review` — паспорт без кода |
| `solution-scout` | active | T1 | find-solution | по запросу | исполняется (`solution-search.ts`, GitHub-коннектор, политика `engine/security.md`) |
| `call-analyst` | active | T1 | analyze-call | по событию | паспорт без кода; нет коннектора звонков |

Рантайм AgentOS (`apps/agents/src/`): `index.ts` (загрузка паспортов → сид в базу, cron), `registry.ts`,
`runner.ts` (навык → policy → approval/commit), `policy.ts` (T0–T4, порог `AGENT_AUTONOMY_MAX`), `tools.ts`
(пол тира по инструментам), `skill-loader.ts` (frontmatter навыков), `skills.ts` (реализации), `memory.ts`
(дельта-память), `memory-rag.ts` + `embedding.ts` (RAG, спит), `model-gateway.ts` (маршрут моделей),
`llm-ledger.ts` + `budget.ts` + `limits.ts` (деньги и потолки), `task-worker.ts` + `task-llm-*.ts` (порученные
задачи), `schedule.ts` + `polling.ts` + `scheduled-occurrence-queue.ts`, `outbox-dispatcher.ts`, `untrusted.ts`
(внешний контент — данные, не инструкции), `web-read.ts`, `chaining.ts`, `executors.ts`, `check-passports.ts`.

## Экраны CC (`apps/cc/src/app/`)

- `/mydon` — Главное: 4 тревоги брифинга, очередь решений, направления.
- `/inbox` — Входящие: решения агентов + карточки реестра на утверждение (один вход, `/approvals`, `/queue` — части).
- `/tasks`, `/tasks/[id]` — задачи по направлениям (`lib/task-directions.ts`, пагинация `lib/task-pagination.ts`).
- `/team`, `/team/[id]`, `/team/actions` — сотрудники и лента «кто что сделал» (`person-access.tsx`).
- `/agents`, `/agents/[name]` — агенты: карточка, редактор (`agent-editor.tsx`, `agent-new.tsx`), журнал.
- `/audit` — журнал; `/system` — LLM-настройки, мониторинг, активация (`llm-settings.tsx`, `llm-monitoring.tsx`), owner-guard.
- `/assistant` + `floating-chat.tsx` + `command-palette.tsx` (⌘K) — помощник (`packages/assistant`).
- Сквозные реестры: `/registry`, `/card/[id]`, `/places`, `/maintenance`, `/sources`, `/imports`, `/catalog`.
- Оболочка: `layout.tsx` (шрифты локально, счётчик Входящих), `components/nav.tsx` (сайдбар ≥900px, таббар — только MAIN), `components/bg/`.

## Telegram-бот (`apps/bot/src/`)

`briefing.ts` (07:30), `notifier.ts`, `owner-actions.ts`, `conversation.ts` + `intent.ts` (свободный текст),
`handler.ts`, `menu.ts`, `reports.ts`, `security/{access,init-data}.ts`. Полевые сценарии VendHub — `routers/vendhub.md`.

## Данные и сервисы

- Core-модули: `apps/core/src/{agents, approvals, tasks, events, audit, notes, people, system, llm-ledger, outbox,
  health.controller, attachments, history, entities, registry, verification}`.
- Таблицы: `agent`, `approval`, `event`, `task`, `task_comment`, `task_agent_execution`, `agent_task_llm_*`,
  `outbox_delivery`, `audit_log`, `system_config`, `llm_model_price`, `llm_spend`, `notification_delivery`, `note`, `person`, `attachment`.
- Пакеты: `packages/assistant` (intent · context · llm · llm-subscription — Claude Agent SDK, подписка владельца),
  `packages/llm-ledger-outbox`, `packages/history` (sqlite-vec), `packages/documents` (xlsx/docx/pptx/pdf через
  готовые навыки Anthropic), `packages/shared` (DOMAINS, TZ, тиры, ledger-типы), `packages/connectors` (`cowork`,
  `github`, `notion`, `telegram`, `web`, `ourvend`, `didox`).
- Тумблеры активации (`docs/AGENTS_ACTIVATION.md`): `LLM_ENABLED`, `LLM_ROUTE`, `LLM_MODEL`, `AGENTS_SCHEDULES_PAUSED`,
  `AGENTS_TASKS_PAUSED`, `LLM_GLOBAL_DAILY_BUDGET_USD`, `AGENT_AUTONOMY_MAX`; база > env > дефолт.

## Референсы

- План трансформации: `docs/AGENTIC_OS_ARMS_PLAN.md`.
- Активация и безопасность: `docs/AGENTS_ACTIVATION.md`, `engine/security.md`, `engine/autonomy.yaml`, `engine/eval-rubric.md`.
- Устав и знания агентов: `apps/agents/shared/COMPANY.md`, `apps/agents/shared/kb/index.md`.
- Спеки: `docs/superpowers/specs/2026-08-29-agent-execution-outbox-design.md`, `…-llm-durable-result-design.md`,
  `…-llm-ledger-design.md`, `2026-08-31-llm-alerts-durable-cron-design.md`, `2026-08-31-p5-web-identity-rbac-design.md`,
  `2026-08-31-parity-issues-task-domains-design.md`.
- Архитектура и консолидация: `docs/DATA_ARCHITECTURE.md`, `docs/CONSOLIDATION.md`, `docs/CUTOVER.md`,
  `docs/AUDIT_PROMPT.md`, `docs/AUDIT_PROMPT_FULL.md`.
- Дизайн оболочки: `docs/DESIGN_BRIEF_CLAUDE_DESIGN.md`, `docs/DESIGN_BRIEF_V2.md`, `docs/UI_REVISION_BRIEF.md`,
  `docs/PROMPT-CLAUDE-DESIGN.md`, `design/claude-design/README.md`; навык `.claude/skills/mydon-design/`.

## Открытые вопросы

- `route-task`, `evening-standup`, `kb-review`, `analyze-call` — без кода → `executor: llm` (волна S).
- Нет живого статуса агентов, доски расписаний, плейбэка прогонов, кольца артефактов — панели §6 плана.
