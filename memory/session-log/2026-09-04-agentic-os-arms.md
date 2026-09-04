# 2026-09-04 · Agentic OS (ARMS): стартовый пакет, паспорта, `executor: llm`

## Активный контекст
Ветка `main`, всё в **рабочем дереве без коммита** (63 записи `git status`, ~130 файлов с новыми каталогами):
стартовый пакет применён (`CLAUDE.md`, `routers/`, `memory/`, `.claude/skills/`, `engine/`, `apps/agents/shared/`),
паспорта 12 агентов дополнены, реализован исполнитель `executor: llm` (`apps/agents/src/llm-skill.ts`), миграция
`0083_agent_kb_pages`, причина release `skill_failed` в Core, поле «Страницы знаний (KB)» в панели,
`tools/apply-passport-fields.mjs`, шаги CI «Passports (агенты)» и «Tools (unit)».
Проверено локально: typecheck/lint всех пакетов, тесты agents 466 · core 1763 · db 170 · cc 382, `check:passports`
чистый, `verify-paths` 260 ссылок. Смоуки против Postgres и docker-тесты гоняет только CI.

## Сделано
- См. `docs/AGENTIC_OS_ARMS_PLAN.md` §9 (врезка «Сделано») и as-built в
  `docs/superpowers/specs/2026-09-04-llm-skill-executor-design.md`.
- Ревизия значений по умолчанию — квиз «Ревизия MYDON» (149 карточек, артефакт claude.ai; ссылка в
  `docs/FIRST_LOGIN_CHECKLIST.md`).

## Ожидает
- Владелец: коммит с ветки → PR → merge (пуш в main заблокирован hookify). После деплоя один раз
  `tools/apply-passport-fields.mjs` на сервере (`docs/FIRST_LOGIN_CHECKLIST.md` п. 0).
- Владелец: ревизия квиза и включение агентов по одному (еженедельное напоминание Пн 09:00 заведено).

## Решения этой сессии
- `memory/decisions.md` — две строки от 2026-09-04 (llm-исполнитель; значения по умолчанию до ревизии).

## Исправления владельца → куда легли
- «Квиз — это данные и настройки внутри системы, а не вопросы плана» → `docs/superpowers/specs/2026-09-04-owner-review-quiz-design.md`, артефакт.
- «Делай всё сам, я поменяю при первом входе, ты напоминай» → `docs/FIRST_LOGIN_CHECKLIST.md`, напоминание.

## Известные мелочи
- `docs/agentic-os-starter/_backup/` в `.gitignore` — можно удалить после коммита.
- Пустой `.git/index.lock` мог остаться от проверок через мост к Mac — `rm -f .git/index.lock`.
- `apps/cc` тесты (vitest) на arm64-Linux требовали нативные бинарники rollup/esbuild — на Mac это не нужно.

## Следующий шаг
`git switch -c feat/agentic-os-arms` → полный гейт (`pnpm typecheck && pnpm lint && pnpm build && pnpm -r --if-present test`,
`pnpm --filter @mydon/agents check:passports`, `node --test tools/apply-passport-fields.test.mjs`) → один коммит → PR.
Дальше по плану: skills deck в CC (§6.1 п. 5), затем первая сессия Venture Factory (§9 п. 5).
