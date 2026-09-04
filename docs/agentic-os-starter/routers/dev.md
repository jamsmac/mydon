# Роутер · Разработка, деплой, тесты, CI

> Не домен бизнеса, а процесс. Читать перед любой правкой кода и перед выкладкой.

## Команды

| Команда | Что делает |
|---|---|
| `pnpm install` | Node ≥ 20.19, pnpm 10.19 (`corepack enable`), `.nvmrc`, `.npmrc` |
| `pnpm build` | Turborepo, все пакеты и приложения |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | strict TS, ESLint 9, Prettier |
| `pnpm test` | тесты гоняются **по dist** (`find dist -name '*.test.js'`), поэтому `test` зависит от собственного `build` (см. `turbo.json`); CC — `vitest` |
| `pnpm --filter @mydon/agents check:passports` | проверка паспортов и frontmatter навыков (`check-passports.ts`) |
| `node tools/check-env-example.mjs` | `.env.example` полон; секреты — только в `.env` |
| `node tools/smoke-core.mjs` · `smoke-panel.mjs` · `smoke-import.mjs` · `smoke-collections.mjs` | smoke-прогоны (гоняются в CI) |
| `pnpm --filter @mydon/db db:generate` / `db:migrate` / `db:studio` / `db:seed*` | Drizzle-миграции и сиды |

## Правила процесса

- Ветка → PR → merge. **Пуш в main = немедленный прод-деплой без CI-гейта** — заблокирован hookify
  (`.claude/hookify.block-push-to-main.local.md`, `.claude/hookify.warn-bare-git-push.local.md`). CI — только на пуш в main (#253).
- Крупная задача — через SDD: `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` → `docs/superpowers/plans/…`
  (`.superpowers/sdd/`). Решение с причиной — `docs/decisions/YYYY-MM-DD-<slug>.md`.
- Codex читает `AGENTS.md` → симлинк на `CLAUDE.md` (#254): правила одни для всех харнесов.
- Мутирующие формы CC — конвенция из `CLAUDE.md`; эталон `components/customs-rates.tsx` + тест на сохранение ввода.
- Шрифты — локальные файлы `apps/cc/src/fonts/` (сборка не ходит в сеть; причина — в `layout.tsx`).
- Ничего не удалять в донорах; переносить готовое (`cp` / `git subtree`), чинить импорты.

## Инфраструктура и деплой (`deploy/`, `docs/DEPLOY.md`)

- Hetzner (4 vCPU / 7.6 ГБ / 38 ГБ) + Tailscale; Fly.io выводится; `deploy/docker-compose.yml`, `Dockerfile`.
- Автодеплой: `deploy/auto-deploy.sh`, `deploy.sh`, `setup-autodeploy.sh`, `deploy-failure-alert.sh`, `guards/`, `setup-guards.sh`.
- Живучесть: `heartbeat.sh` + `setup-heartbeat.sh`, `watchdog-liveness.sh`, `apps/watchdog` (внешний монитор обязателен — `docs/watchdog.md`).
- Резерв: `docker-compose.standby.yml`, `standby-{lib,promote,stop,drill}.sh`, `restore_test_mydon.sh`,
  `setup-b2-offsite.sh`, `b2-recovery-drill-macos.sh`; документы — `docs/BACKUPS.md`, `docs/DATABASE_DR.md`, `docs/CUTOVER.md`.
- Панель наружу — только через Tailscale: `deploy/tailscale-serve-panel.sh`; сертификаты — `deploy/certs/`.
- Тесты деплоя — `deploy/tests/`.

## Инструменты (`tools/*.mjs`)

Импорт/сверка: `import-raw`, `import-cowork`, `import-globerent-registry`, `import-telegram-coffee`,
`relink-globerent-contracts`, `unlink-foreign-contracts`, `check-registry`, `apply-maintenance-norms`,
`backfill-machine-kinds`. Выгрузки: `fetch-didox`, `fetch-gjvending`, `fetch-vendinghub`, `fetch-telegram-history`,
`ingest-site`. Контроль: `check-env-example`, `watchdog-check`, `smoke-*`. Образцы — `tools/samples/`.

## Навыки Claude Code для разработки (`.claude/skills/`)

- `/onboard <направление|задача>` — бриф перед работой (роутер → цели → последние решения → открытые вопросы).
- `/align` — уточняющие вопросы до кода, когда задача неоднозначна.
- `/calibrate` — конец сессии: исправления владельца → предложения правок роутеров/навыков/`memory/`; handoff.
- `/mydon-design` — толстый навык дизайн-системы: любой новый экран или компонент CC.

## Референсы

`README.md`, `CLAUDE.md`, `turbo.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`,
`.github/workflows/`, `docs/DEPLOY.md`, `docs/BACKUPS.md`, `docs/DATABASE_DR.md`, `docs/watchdog.md`, `docs/CUTOVER.md`.
