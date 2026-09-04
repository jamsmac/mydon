# MYDON — контекст монорепо (главный роутер)

> Автономный проект «с нуля». Правила legacy-проектов (VendHub-OS и др.) здесь
> НЕ применяются — они только доноры готового кода по запросу.
> Основание архитектуры — аудит в `~/Developer/mydon-audit/` (11 фронтов + ARCHITECTURE.html).
>
> Этот файл — **роутер**, а не энциклопедия: он говорит, ГДЕ лежит контекст направления,
> а не пересказывает его. Подробности — в `routers/<направление>.md`, знания — в `memory/`,
> решения с причинами — в `docs/decisions/`.

## Что это

MYDON — единый инструмент управления всеми направлениями владельца.
Один продукт, один интерфейс, разные движки под капотом.

**Три слоя:** Core (данные) · Agents (исполнение) · CC/Shell (интерфейс).
**Принцип:** одна оболочка — много движков. Отдельный движок — да, отдельный интерфейс — нет.
**Дисциплина ARMS** (Applications · Routines · Memory · Skills, строим снизу вверх) — план и
текущее состояние: `docs/AGENTIC_OS_ARMS_PLAN.md`.

## Цели (текущие) — ПОДТВЕРДИТЬ ВЛАДЕЛЬЦУ

<!-- Короткий список, 3–5 пунктов. Обновляет /calibrate в конце сессии; устаревшее удаляется, не копится. -->
1. Волна S плана ARMS: исполняемые markdown-навыки (`executor: llm`), толстый навык `mydon-design`, skills deck.
2. Волна M: роутеры направлений, закрыть 51 битую ссылку из паспортов (`shared/`, `engine/`).
3. Venture Factory в интерактивном режиме (Scout + Analyst) — первые карточки и вердикты в Core.
4. Хвосты аудита 01–02.09 (owner-guard, RBAC enforcement пока выключен, свежесть данных панели).

## Направления (домены)

| Домен | Что это | Роутер |
|---|---|---|
| **GLOBERENT** | дистрибуция погрузчиков HELI (`/globerent`, `/domain/globerent`) | `routers/globerent.md` |
| **VendHub** | сеть кофейных автоматов; движок VHM24 отдельный, UI в оболочке (`/domain/vendhub`) | `routers/vendhub.md` |
| **Личный контур** | недвижимость, транспорт, накопления (`/domain/personal`, только владелец) | `routers/personal.md` |
| **MYDON** | Command Center, общие агенты, система (`/mydon`, `/agents`, `/system`) | `routers/mydon.md` |
| **Ventures** | фабрика направлений — планируется (`/domain/ventures`) | `routers/ventures.md` |
| *(процесс)* | разработка, деплой, тесты, CI — не домен, но свой роутер | `routers/dev.md` |

Открывая задачу по направлению — сначала его роутер, потом код.

## Стек (целевой, зафиксирован в ТЗ)

TypeScript (strict) · NestJS · Next.js · PostgreSQL · Drizzle · REST/class-validator · Turborepo · pnpm

## Правила разработки

- **TypeScript strict**, без `any`.
- **Часовой пояс Asia/Tashkent** везде, включая cron.
- **Язык:** русский в UI, английский в коде.
- **Секреты:** ни одного ключа в коде. Только `.env` (в `.gitignore`) + `.env.example` в репо.
- **Перенос кода, не переписывание:** готовый рабочий код переносить (`cp`/`git subtree`)
  из доноров (VendHub-OS для оболочки, mydon_1 для Command Center), чинить импорты — не генерировать заново.
- **Ничего не удалять** в проектах-донорах.
- **Базы движков не сливать:** общая оболочка — да, общая БД для всего — нет. VHM24 держит свою схему.
- **Факты — в Core, знания — в markdown.** Реестр, деньги, задачи, согласования живут в Postgres;
  правила, решения, устав, профили рынков — в `memory/`, `docs/`, `apps/agents/shared/`.
  Файлы паспортов и пакетов направлений — сид, после сида источник истины — база.
- **У каждого решения записана причина** (`docs/decisions/`, образец — 2026-08-22): решение без
  причины пересматривается дёшево и вслепую.
- **Агент ничего не делает сам без тира.** Автономия по умолчанию T0, деньги/договоры/публикации
  от имени владельца — всегда T3 через согласование. `AGENT_AUTONOMY_MAX` не поднимать «ради автономии».
- **Мутирующие формы CC** (apps/cc) — принятая конвенция (решение 24.08.2026,
  миграция Codex принята осознанно): `onSubmit` + `event.preventDefault()` +
  `new FormData(event.currentTarget)` → вызов server action в
  `startTransition`; при `res.ok` — сброс ошибки и `router.refresh()`, при
  отказе — `setError(res.message)`, **поля сохраняют ввод**. НЕ возвращаться
  к `<form action={fn}>`: React 19 сбрасывает неуправляемые поля после
  экшена — ошибка Core теряла бы весь ввод длинных форм. Эталон —
  `components/customs-rates.tsx`; тесты обязаны проверять сохранение ввода
  при ошибке (см. customs-rates.test.tsx).
- **Не пушить в main напрямую** (hookify-правило `.claude/hookify.block-push-to-main.local.md`):
  ветка → PR → merge; пуш в main = немедленный прод-деплой без CI-гейта.
- **Экраны — через `/mydon-design`** (толстый навык дизайн-системы): токены, правило оранжевого,
  «плитка = вопрос владельца», «пустой экран говорит, что сделать». Новые токены не заводить.

## Инфраструктура

Hetzner (4 vCPU / 7.6 ГБ / 38 ГБ, диск ~70%) + Tailscale. Fly.io выводится.
Внешний watchdog обязателен (монитор на другом провайдере). Подробности — `routers/dev.md`, `docs/DEPLOY.md`.

## Карта репозитория

```
mydon/
├── CLAUDE.md / AGENTS.md→CLAUDE.md   # этот роутер (Codex читает через симлинк)
├── routers/                          # роутеры направлений — читать ПЕРВЫМИ
├── memory/                           # знания: decisions.md (указатель), constraints.md, glossary.md,
│                                     #   open-questions.md, session-log/ (handoff между сессиями)
├── .claude/skills/                   # onboard · calibrate · mydon-design (толстый) · …
├── apps/
│   ├── core/       # API + БД (NestJS): реестр, шина событий, approvals, ledger LLM
│   ├── agents/     # AgentOS: паспорта agents/<name>/{ROLE.md,config.yaml,skills/}, runner, policy T0–T4
│   ├── bot/        # Telegram: брифинг 07:30, approvals, полевые сценарии VendHub
│   ├── cc/         # веб-оболочка (Next.js): Command Center, рабочие места направлений
│   └── watchdog/   # внешний сторож
├── packages/       # db (Drizzle-схема Core) · shared (типы, TZ, домены) · connectors · assistant ·
│                   #   documents · history (RAG) · llm-ledger-outbox
├── engine/         # security.md (denylist, research-политика) · autonomy.yaml · eval-rubric.md
├── deploy/  tools/  docs/  design/   # см. routers/dev.md
└── docs/decisions/                   # решения с причинами (ADR)
```

Схема MYDON Core (`packages/db/src/schema.ts`): org · project · entity · person · task · approval ·
event · document · money_flow · note · audit_log · agent · system_config · llm_* + доменные таблицы.
Принцип: сначала реестр, потом дашборд. Дашборд без данных — картинка.

## Как работать в сессии

- Начало: `/onboard <направление|задача>` — бриф из роутера, целей и последних решений, потом код.
- Крупная задача: спека → план (`docs/superpowers/{specs,plans}/YYYY-MM-DD-<slug>-design.md`).
- Конец: `/calibrate` — что исправлял владелец → предложения правок роутеров, навыков, `memory/`;
  handoff в `memory/session-log/`.

## Доноры кода (только чтение)

- Оболочка (auth/RBAC/дизайн-система): `~/Projects/VendHub-OS/VendHub-OS`
- Command Center + агенты (прототип): `~/Developer/mydon_1`, `~/Developer/mydon-agent-os`
  (там же `PROTOCOL.md`, `MYDON_AGENT_BUILDER.md`, Run Inspector, Agent Studio)
- VendHub-движок: `~/Projects/VendHub/VendHubManager/VHM24`
- GLOBERENT-донор: PROMACH (`github.com/jamsmac/promach`) — карта переноса `docs/PROMACH_TRANSFER.md`
