# Исполнитель `executor: llm` — markdown-навык как исполняемая единица

Дата: 2026-09-04
Статус: **реализовано 2026-09-04** (см. раздел «Как реализовано» внизу); спека волны S плана ARMS (`docs/AGENTIC_OS_ARMS_PLAN.md` §6.1); первый паспорт — `globerent-sales/qualify-lead`
Предшественники: `2026-08-29-llm-ledger-design.md`, `2026-08-29-llm-durable-result-design.md`,
`2026-08-29-agent-execution-outbox-design.md`. Все цитаты строк — по дереву `main` @ d059ef8 (реализация легла на
11472ae; смещения строк ±30, имена символов те же).

## Цель

Сделать `SKILL.md` исполняемым. Сегодня навык агента = TypeScript-функция в реестре `SKILLS`
(`apps/agents/src/skills.ts:362-370`); 19 из 27 навыков, объявленных в паспортах, реализации не имеют, и
`runSkill` честно отвечает `not_implemented` (`apps/agents/src/runner.ts:164-171`). Вводится второй исполнитель:
для навыка с `executor: llm` во frontmatter рантайм собирает контекст из паспорта (устав, роль, тело навыка,
страницы KB, вход задачи), делает **один** metered-вызов модели через существующий `callModel`
(`apps/agents/src/llm.ts:130`) и превращает структурированный ответ в обычный `Proposal`
(`skills.ts:36-53`). Дальше — тот же `runner → policy → approval → Core commit`, без новых побочных эффектов.

Фаза закрывает ровно один сценарий: **порученная задача** (task-mode) с durable LLM-сессией. Cron-режим для
`llm`-навыков в этой фазе не включается (см. «Границы»).

## Почему не Claude Agent SDK и не подписка (коррекция плана)

План ARMS §6.1 предлагал перенести механизм из `packages/assistant/src/llm-subscription.ts` (Claude Agent SDK
по подписке владельца). Для рантайма агентов это неверно: денежная политика агентов fail-closed —
подписочные и CLI-маршруты заблокированы в `modelGatewayFromEnv` (`apps/agents/src/model-gateway.ts:472-528`:
`CLI_SUBSCRIPTION_DISABLED_REASON`, `CODEX_SUBSCRIPTION_DISABLED_REASON`), потому что auth status не доказывает,
что следующий вызов не спишет credits/overage. Единственный production-маршрут агентов — `LLM_ROUTE=openai-api`
через `HttpModelGateway` и Core-ledger (reserve → settle). Исполнитель `llm` обязан идти этим же путём — как
`assess-ideas`, `coach-review`, `find-solution` — и получает даром: бюджеты, replay-блок, durable result,
circuit по `resolvedModel`. Подписочный путь остаётся у помощника (`packages/assistant`), где расход не
агентный. План §6.1 и §9 п. 4 правятся в этом же PR.

## Инварианты

- **R-LS-1 Нет побочных эффектов.** `llm`-исполнитель ничего не пишет, не отправляет и не исполняет. Его
  единственный выход — `Proposal | null`. Все эффекты (approval, `agent.action`, память, итог задачи) создаёт
  Core в `commit-agent-outcome`, как для любого навыка. В `EXECUTORS` (`runner.ts`, реестр исполнителей действий)
  `llm`-навык не регистрируется — значит при любом пороге автономии он идёт через согласование.
- **R-LS-2 Один вызов модели на прогон.** Один шаг `chat` с ключом `llm-skill:<skill>`; цепочка моделей —
  `resolveModelChain()` (`model-gateway.ts:171`). Никаких циклов «подумай ещё», никаких инструментов у модели.
  Цикл с инструментами — следующая фаза (MCP `mydon-core`, план §6.4).
- **R-LS-3 Только metered через Core.** Вызов — `callModel` с `taskLlm` (durable task session) в task-mode;
  без `taskLlm` при metered-шлюзе — `LlmLedgerUnavailableError`, как сегодня (`llm.ts:156-158`). Локальный или
  подписочный обход ledger для `llm`-навыков не предусмотрен.
- **R-LS-4 Внешний текст — данные.** `description` задачи (туда владелец вставляет письма клиентов, тексты
  тендеров) и любые фрагменты, пришедшие не из репозитория, оборачиваются `wrapUntrusted`
  (`apps/agents/src/untrusted.ts:22`); `systemGuard()` (`:31`) — всегда в system (это уже делает `callModel`).
  Тело `SKILL.md`, `ROLE.md`, `COMPANY.md`, страницы KB — доверенный контекст (файлы образа, правятся через PR/согласование).
- **R-LS-5 Строгий контракт ответа.** Модель отвечает JSON фиксированной формы (§«Контракт ответа»).
  Ответ, который не разобрался или не прошёл схему после одной нормализации (срез до первого `{` … последнего `}`),
  → `Proposal` НЕ создаётся; прогон завершается `skipped / skipReason: "llm_invalid_output"` с сохранённым
  сырым текстом (обрезанным) в `reason`. Никакой «свободной прозы» во Входящие.
- **R-LS-6 Пол тира считается как сегодня.** `effectiveActionTier(agent.autonomyDefault, skillFloor)`
  (`runner.ts:141`), где `skillFloor` — максимум из `requires-approval` и пола по `allowed-tools`
  (`skillFloor`, `skill-loader.ts:132-136`). Для `qualify-lead` это **T2** (`write_task` → тип `write` → T2 по `tools.ts`),
  а не объявленный T1 — исполнитель ничего не меняет в этой арифметике.
- **R-LS-7 `allowed-tools` — не инструменты модели, а разрешение на контекст.** В этой фазе:
  `read_kb` → страницы `kb_pages` агента попадают в контекст; `read_db` → снимок Core **не собирается**
  (нет отображения на безопасные чтения; фиксируется в `facts.toolsIgnored`); `write_task` → эффект даёт
  Core-commit задачи, ничего дополнительно. Любое другое имя — игнорируется с записью в `facts.toolsIgnored`.
- **R-LS-8 Контекст ограничен и детерминирован.** Порядок сборки фиксирован (§«Сборка контекста»); каждая
  KB-страница обрезается до `LLM_SKILL_KB_PAGE_CHARS` (по умолчанию 12 000 символов) с пометкой обрезки; общий
  вход — `inputTokenCeiling` считает `callModel`. Отсутствующая страница KB не роняет прогон: пропуск фиксируется
  в `facts.kbMissing` и в `warn`.
- **R-LS-9 Дедуп — по входу задачи.** `signatureFacts = { skill, taskInputHash }`, где hash — тот же
  `claim.taskInputHash` Core (`task-worker.ts:200-204`). Волатильные `model`, `costUsd`, текст ответа в сигнатуру
  не входят — иначе одинаковый лид давал бы дубли (урок `assess-ideas`, `ideas.ts:198-201`).
- **R-LS-10 Паспорт остаётся файлом, база — истиной.** `executor`, `triggers`, `model-effort`, `max-tokens`
  живут во frontmatter `SKILL.md` (файлы — часть образа, читаются на старте, `index.ts:171`). `kb_pages`
  переезжают из `config.yaml` в таблицу `agent` (колонка `kb_pages jsonb`), как уже сделано для `web_sources`,
  `break_glass`, `idea_channels` (`toPassport`/`fromCore`, `index.ts:38-90`): иначе агент, заведённый из панели, не имел бы KB.
- **R-LS-11 Ноль магии в расписании.** *(снято 05.09: спека skills-deck-cron-llm, R-SD-5 — cron для llm
  разрешён через durable-задачу, аллоу-лист не нужен.)* `llm`-навык в `schedule:` паспорта — ошибка
  `check-passports` в этой
  фазе (рантайм и так бросит `Metered scheduled skill … blocked until it is allowlisted`, `schedule.ts:35-39`).
  Разрешение cron — отдельный срез с записью в `DURABLE_SCHEDULED_SKILLS` (`schedule.ts:19`).
- **R-LS-12 Наблюдаемость.** Каждый прогон оставляет в `facts`: `model`, `costUsd` (если провайдер сообщил),
  `ledgerWarning`, `kbPages`, `kbMissing`, `toolsIgnored`, `promptChars`, `outputChars`. Владелец во Входящих
  видит, чем модель пользовалась.

## Конфигурация навыка (frontmatter `SKILL.md`)

Существующие поля читает `buildMeta` (`skill-loader.ts:76-99`): `name`, `description`, `allowed-tools`,
`requires-approval`. Добавляются:

| Поле | Тип | По умолчанию | Смысл |
|---|---|---|---|
| `executor` | `code \| llm` | `code` | `code` — реализация в `SKILLS`; `llm` — этот исполнитель. `llm` при наличии кода в `SKILLS` — замечание валидатора (двусмысленность), побеждает `code`. |
| `triggers` | `string[]` | `[]` | Регулярные выражения (без флагов, применяются с `iu`) для `matchSkill` (`task-worker.ts:50-67`): аналог статической карты `HINTS`, но объявленный в паспорте. Пустой список → навык вызывается только прямым упоминанием имени в заголовке задачи. |
| `model-effort` | `none…max` (`ModelReasoningEffort`, `model-gateway.ts:68`) | не задан | Передаётся как `reasoningEffort`; шлюз применяет только к моделям, которые это поддерживают. |
| `max-tokens` | `number` | `DEFAULT_MAX_TOKENS` = 2048 (`llm.ts:28`) | Потолок ответа; `outputCeiling` (`llm.ts:76`) режет битые значения. |

`SkillMeta` (`skill-loader.ts:30-45`) получает `executor`, `triggers`, `modelEffort`, `maxTokens`, `body`
(тело файла без frontmatter — исполнителю нужен текст). Валидатор `check-passports` (`checkAll`, `check-passports.ts:117-146`)
добавляет замечания: неизвестный `executor`; `executor: llm` без `requires-approval`; невалидная регулярка в
`triggers`; `llm`-навык в `schedule:`; `kb_pages` агента, которых нет на диске.

## Сборка контекста (порядок фиксирован)

**system** (доверенное), в этом порядке, разделитель — пустая строка:
1. `systemGuard()` — добавляет `callModel`.
2. Роль исполнителя: «Ты — агент MYDON `<agent.name>` (`<agent.business>`). Отвечай строго JSON по схеме ниже. Русский язык. Цена и факты — только из контекста; нет данных — так и пиши, не выдумывай.»
3. `apps/agents/shared/COMPANY.md` (устав; целиком — ~4 КБ).
4. `agents/<agent>/ROLE.md` (роль; целиком).
5. Тело `SKILL.md` навыка (инструкция; целиком).
6. Страницы `kb_pages` агента, если в `allowed-tools` есть `read_kb`: каждая — под заголовком
   `### KB: <путь>` и обрезкой по R-LS-8. Порядок — как в паспорте.
7. Схема ответа (§ниже) и правило: «ответ — только JSON, без пояснений вокруг».

**prompt** (задача):
- `Задача: <taskInput.title>` — доверенная короткая формулировка владельца.
- `Подробности:` + `wrapUntrusted(taskInput.description)` — недоверенный блок (R-LS-4). Пустое описание → строка
  «(подробностей нет)».
- `Направление: <taskInput.domain ?? agent.business>`.

Файлы читаются один раз на старте вместе с `loadSkillMeta` (`index.ts:171`) и кэшируются: `COMPANY.md`,
`ROLE.md`, тело навыка, KB-страницы. Отсутствие `COMPANY.md`/`ROLE.md` — предупреждение на старте, прогон идёт
без них с пометкой в `facts`.

## Контракт ответа модели

```json
{
  "summary": "одна строка для владельца: что предлагается и почему (≤ 200 символов)",
  "details": "текст по формату из раздела «Выход / формат» навыка (≤ 4000 символов)",
  "facts": { "произвольные": "ключ-значение с фактами, на которых построен вывод" },
  "next": ["следующие шаги, по одному действию в строке"],
  "escalate": false,
  "confidence": 0.0
}
```

Правила разбора (R-LS-5): обязательные `summary` (непустая строка) и `details` (строка); `facts` — объект или
отсутствует; `next` — массив строк или отсутствует; `escalate` — boolean или отсутствует; `confidence` — число
0…1 или отсутствует. Лишние поля отбрасываются. Отображение в `Proposal`:

- `action` = `summary` (обрезка до 200 символов);
- `facts` = `{ details, ...facts, model, costUsd?, ledgerWarning?, kbPages, kbMissing?, toolsIgnored?, promptChars, outputChars, escalate?, confidence? }`;
- `next` = `next` (обрезка до 5 пунктов); при `escalate: true` первым пунктом добавляется
  «Эскалация владельцу: модель считает случай нестандартным»;
- `signatureFacts` = `{ skill, taskInputHash }` (R-LS-9).

`summary` пустой или «повода нет» — модель обязана вернуть `summary: "нет повода"` и `details` с объяснением;
исполнитель превращает это в `null` (прогон `no_signal`) **только** если `summary` в точности `нет повода` —
иначе владелец увидит предложение и сам решит.

## Поток: порученная задача (task-mode)

1. Владелец создаёт задачу агенту в панели/боте: `Квалифицируй лид: OLMA, 3× CPD25, срочно, бюджет есть`,
   исполнитель — `globerent-sales`. Агент должен быть `active` (сейчас `paused`, `config.yaml`; статус меняется
   в панели `/agents/globerent-sales`, база — истина).
2. `runAgentTasks` (`task-worker.ts`) забирает задачу; `matchSkill(agent, title)` (`:50-67`) находит навык:
   прямое имя → или `triggers` из frontmatter → или существующие `HINTS`. `hasSkill` заменяется на `isWired`
   (§«Карта изменений»), иначе `llm`-навык невидим для подбора.
3. `buildTaskLlmWorkflowPlan(skill)` (`task-llm-workflow.ts:73`) для `llm`-навыка возвращает один шаг
   `chatStep("llm-skill:<skill>", …)` при metered-шлюзе; без metered-маршрута — план пуст, и задача **возвращается
   владельцу** с причиной «LLM-маршрут выключен» (не висит: тот же паттерн `route_unavailable`, что у
   `find-solution`, `task-worker.ts:218-259`, обобщённый на любой `llm`-навык).
4. `startAgentTaskExecution` создаёт immutable execution с планом; `runSkill(agent, skill, core, threshold, floor, ctx)`
   (`index.ts:322`, `task-worker.ts`) — в `runner.ts:164` вместо `SKILLS[skill]` — `resolveSkill(skill)`:
   `SKILLS[skill] ?? llmSkillFor(skill)`.
5. Исполнитель собирает контекст, вызывает `callModel(gateway, {…, feature: "llm-skill:<skill>", taskLlm: ctx.task.llm,
   requestKey: ctx.requestKey + ":llm", traceKey, assertLease})`; при `!res.ok` → `null` с `reason` провайдера
   (как `assess-ideas`, `ideas.ts:157`); разбирает JSON (R-LS-5); возвращает `Proposal | null`.
6. `runner` сохраняет checkpoint (`saveCheckpoint`, `runner.ts:187-197`), считает сигнатуру, формирует
   `commit` — Core создаёт approval во Входящих и итог задачи одной транзакцией (спека outbox, инвариант 5).
7. Takeover после аварии читает checkpoint и модель не зовёт (`runner.ts:177-180`) — без изменений.
8. Владелец во Входящих видит: `action` (summary), `facts.details` (разбор по формату навыка), `facts.model`,
   `facts.costUsd`, `next`. Решение владельца — как для любого предложения.

Ошибки → `skipReason`, все существующие: `budget_denied`, `execution_unknown` (replay), `ledger_unavailable`,
`workflow_changed`; новый — `llm_invalid_output` (R-LS-5). Новое значение добавляется в союз `RunResult.skipReason`
(`runner.ts:41-50`) и в подписи панели/бота, где `skipReason` показывается словами.

## Карта изменений

| Файл | Изменение |
|---|---|
| `apps/agents/src/llm-skill.ts` (+) — плоский модуль рядом с `web-read.ts`/`ideas.ts`; **не** каталог `executors/`: рядом уже есть `executors.ts` (реестр `EXECUTORS`), и каталог с тем же именем создал бы двусмысленность резолва `./executors` | `buildLlmSkill(meta, deps): Skill` — сборка контекста, вызов `callModel`, разбор ответа, `Proposal`. Чистые функции `assembleSystem`, `assemblePrompt`, `parseModelJson` — тестируются без сети. |
| `apps/agents/src/skill-loader.ts` | `SkillMeta` + `executor`, `triggers`, `modelEffort`, `maxTokens`, `body`; `buildMeta` читает и валидирует новые поля (замечания — в `problems`). |
| `apps/agents/src/skills.ts` | `hasSkill` → учитывает реестр `llm`-навыков: `registerLlmSkills(metas)` на старте, `isWired(name) = name in SKILLS || llmSkills.has(name)`; `resolveSkill(name)`. |
| `apps/agents/src/runner.ts:164` | `const impl = resolveSkill(skill)`; новый `skipReason: "llm_invalid_output"`. |
| `apps/agents/src/task-worker.ts:50-67, 218-259` | `matchSkill` учитывает `triggers` из meta и `isWired`; обобщение `route_unavailable` (`:218-259`) на любой навык с пустым планом при metered-требовании. |
| `apps/agents/src/task-llm-workflow.ts:73` | Ветка: `executor === "llm"` → один `chatStep("llm-skill:<skill>", …)`. |
| `apps/agents/src/schedule.ts` | Без изменений в этой фазе (R-LS-11); допуск cron — отдельный срез. *(снято 05.09: спека skills-deck-cron-llm, R-SD-5.)* |
| `apps/agents/src/registry.ts:20-38` | `kbPages?: string[]` из `kb_pages` паспорта (валидация: относительный путь внутри `shared/`, без `..`). |
| `apps/agents/src/index.ts:38-90, 171` | `toPassport`/`fromCore` переносят `kbPages`; `registerLlmSkills(loadSkillMeta(AGENTS_DIR))`; предзагрузка `COMPANY.md`/`ROLE.md`/KB в кэш. |
| `packages/db/src/schema.ts` (`agent`, `:1601`) + миграция | `kb_pages jsonb default '[]' not null`. |
| `apps/core/src/agents/*` | `seedAgents`/`listAgents`/карточка агента принимают и отдают `kbPages` (по образцу `ideaChannels`). |
| `apps/agents/src/check-passports.ts` (`checkPassport` :91, `checkAll` :117) | Новые замечания (§«Конфигурация навыка»); проверка существования `kb_pages` на диске. |
| `apps/cc/src/components/agent-editor.tsx` | Поле «Страницы знаний» (список путей) — редактирование `kbPages`; показ `executor` навыка в списке навыков карточки (`/agents/[name]`). |
| `apps/agents/agents/globerent-sales/skills/qualify-lead.md` | frontmatter: `executor: llm`, `triggers: ["квалифиц", "лид", "lead", "запрос на погрузчик", "тендер"]`, `model-effort: medium`. Тело — без изменений (формат вывода уже задан). |
| `apps/agents/agents/globerent-sales/config.yaml` | `kb_pages` — сузить до `heli-models.md`, `pricelist.md`, `lead-criteria.md` (`faq.md`, `clients.md` не нужны для квалификации и раздувают контекст; `clients.md` содержит дебиторку — least privilege). |
| `apps/agents/shared/COMPANY.md`, `shared/kb/**` | Появляются из пакета `docs/agentic-os-starter/` (применить до этого PR). |
| `docs/AGENTS_ACTIVATION.md` | Раздел «Навыки `executor: llm`»: как включить, что увидеть, как откатить. |
| `docs/AGENTIC_OS_ARMS_PLAN.md` §6.1, §7 (строка S), §9 п. 4 | Замена «Claude Agent SDK / llm-subscription» на «`callModel` + ledger/taskLlm, маршрут `openai-api`». |

Тесты (все `node --test` по dist, как в репо):
- `llm-skill.test.ts`: сборка system/prompt (порядок, обёртка untrusted, обрезка KB, отсутствующая страница);
  `parseModelJson` — валидный, с мусором вокруг, битый, без `summary`, `summary: "нет повода"`; отображение в `Proposal`,
  `signatureFacts`; `toolsIgnored` для `read_db`.
- `skill-loader.test.ts`: новые поля, дефолты, замечания валидатора, `body`.
- `skills.test.ts`/`runner.test.ts`: `resolveSkill` предпочитает код; `llm_invalid_output`; `not_implemented`
  для навыка без кода и без `executor: llm` — прежнее поведение.
- `task-worker.test.ts`: `matchSkill` по `triggers`; возврат задачи владельцу при пустом плане.
- `task-llm-workflow.test.ts`: план `llm`-навыка = один шаг `llm-skill:<skill>`; версия не меняется.
- `check-passports.test.ts`: `llm`-навык в `schedule:` → замечание; несуществующая `kb_pages` → замечание.
- `packages/db` `migrations.test.ts`: новая миграция в списке; `schema.test.ts`: колонка `kb_pages`.
- Smoke: `tools/smoke-core.mjs` — карточка агента с `kbPages` round-trip.

## Первый паспорт: `globerent-sales/qualify-lead`

Почему он: T1 по замыслу, читает только KB, ничего наружу не отправляет («КП никогда не уходит клиенту из этого
скилла»), формат вывода уже задан в теле, данные лида приходят **в тексте задачи** — навыку не нужны таблицы Core,
которых нет (сущности «лид» в Core нет: `packages/db/src/schema.ts`, `apps/cc/src/lib/labels.ts`). Единственная
правка тела — нет; frontmatter — три поля.

Сценарий приёмки: включён LLM по runbook (`LLM_ENABLED=1`, `LLM_ROUTE=openai-api`, `LLM_MODEL`, `LLM_PRICE_PROVIDER_ID=openai`,
серверный `LLM_API_KEY`, `AGENTS_TASKS_PAUSED=0`), агент `globerent-sales` переведён в `active` в панели,
`kb_pages` на диске. Владелец создаёт задачу агенту с описанием лида → в течение `agentTaskIntervalMs` во Входящих
появляется предложение: класс hot/warm/cold, score, сигналы, следующий шаг; в `facts` — `model`, `costUsd`,
`kbPages`. Повторная такая же задача (тот же текст) → `no_change`. Задача с пустым описанием → предложение
«недостаточно данных: … » (модель просит поля из раздела «Вход» навыка), не выдумка. При `LLM_ENABLED=0` задача
возвращается владельцу с причиной, а не висит.

## Явные границы этой фазы

- Нет инструментов у модели (tool calling), нет многошаговости, нет чтения Core «по запросу модели» — это MCP
  `mydon-core` (план §6.4). `read_db` в `allowed-tools` пока игнорируется (R-LS-7).
- Нет cron для `llm`-навыков (R-LS-11): `hunt-leads`, `scan-*`, `business-brief`, `evening-standup` остаются
  `not_implemented` на расписании до среза «durable cron для llm». *(снято 05.09: спека
  skills-deck-cron-llm, R-SD-5.)*
- Нет ручного запуска из панели (skills deck) — в этой фазе запуск = задача агенту. Deck — план §6.1 п. 5.
  *(снято 05.09: спека skills-deck-cron-llm, R-SD-2 — `/skills` и `POST /agents/:name/skills/:skill/run`.)*
- Нет подписочного маршрута для агентов (см. «Почему не Agent SDK»).
- Нет per-agent `model_routing` из `config.yaml` (`globerent-sales/config.yaml` содержит `simple/complex:
  claude-p` — поле рантаймом не читается и в этой фазе не оживает; единственная ручка — `model-effort` навыка и
  глобальная цепочка `LLM_MODEL`/`LLM_FALLBACK_MODELS`).
- Не меняются `policy.ts`, `tools.ts`, ledger, Core-транзакция commit.

## Приёмка

1. `pnpm build && pnpm test` зелёные; `pnpm --filter @mydon/agents check:passports` — без замечаний по
   `globerent-sales`, и **ровно одно** замечание появляется, если временно поставить `qualify-lead` в `schedule:`.
2. `node docs/agentic-os-starter/verify-paths.mjs` — без битых ссылок (KB-страницы на месте).
3. Юнит: `parseModelJson` отклоняет 5 битых форм из тестов; `assembleSystem` даёт детерминированный порядок и
   стабильный `promptChars` на одном входе.
4. Живой прогон по сценарию §«Первый паспорт»: предложение во Входящих ≤ `agentTaskIntervalMs` + таймаут шлюза
   (30 с, `model-gateway.ts:472-528` → `HttpModelGateway(…, 30_000, …)`); в `llm_spend` — одна запись
   `feature = llm-skill:qualify-lead`, `consumer = agents`, `agent_id` → карточка `globerent-sales`.
5. Повтор задачи с тем же текстом → `no_change`; изменённый текст → новое предложение.
6. `LLM_ENABLED=0` → задача возвращена владельцу с причиной; никаких записей в `llm_spend`.
7. Takeover-тест (kill worker после ответа провайдера, до commit): второй worker коммитит из checkpoint, второго
   вызова модели нет (`llm_spend` не растёт).
8. В `docs/AGENTS_ACTIVATION.md` — раздел с точным набором тумблеров и откатом.

## Выкатка и откат

Выкатка: PR → CI → автодеплой (правило репо). Фича инертна, пока ни один паспорт не объявил `executor: llm`;
первый — `qualify-lead` в том же PR, но агент `globerent-sales` остаётся `paused` до слова владельца в панели.
Порядок включения: миграция (`kb_pages`) → образ → `LLM_*` тумблеры → `active` агенту → одна тестовая задача.

Откат уровня 1 (мгновенно, без деплоя): агент → `paused` в панели или `AGENTS_TASKS_PAUSED=1`.
Откат уровня 2: убрать `executor: llm` из frontmatter → навык снова `not_implemented`. Откат уровня 3: revert PR;
миграция `kb_pages` обратно-совместима (колонка с дефолтом, код без неё работает).

## Риски

- **Расход.** Один вызов ≤ 2048 токенов ответа, вход ограничен обрезкой KB; потолки `per_day_usd` агента (3 $),
  `LLM_MAX_RESERVATION_USD`, глобальный дневной бюджет — уже действуют через ledger. Включать один паспорт, смотреть `llm_spend` неделю.
- **Качество вывода.** Модель может «натянуть» фит (правило навыка: «нет фита → честно cold»). Контроль —
  `coach-review` уже судит результаты по `eval-rubric` (T2, Пн 10:00); первые 10 предложений владелец читает целиком.
- **Инъекция через описание задачи.** Обёртка + страж (R-LS-4); модель не имеет инструментов — максимум
  испортит одно предложение, которое владелец отклонит.
- **Раздувание контекста KB.** `pricelist.md` 13,7 КБ + `heli-models.md` 9 КБ + устав/роль/навык ≈ 30 КБ ≈ 8–9 тыс.
  токенов на вызов — приемлемо для одного паспорта; для следующих — сужать `kb_pages`, не поднимать лимит.
- **Дрейф frontmatter.** `check:passports` сегодня в CI **не гоняется** (`.github/workflows/ci.yml`: lint · typecheck · build · test · миграции · audit) — добавить шаг `pnpm --filter @mydon/agents check:passports` после `build` тем же PR, иначе битый frontmatter доедет до прода.

## Открытые вопросы владельцу

1. Перевести `globerent-sales` в `active` сразу после деплоя или сначала одна ручная задача на `paused`-агенте
   через явный тумблер «разрешить задачи paused-агенту» (сейчас такого нет; предлагается не вводить — `active` и точка).
2. Второй паспорт после недели наблюдения: `globerent-service/triage-service` (T1, тоже вход текстом) или
   `chief-of-staff/evening-standup` (потребует чтения Core → ждать `read_db` отображения)? Предложение — `triage-service`.
3. Показывать `costUsd` владельцу в карточке предложения (уже в `facts`) — оставить как есть или вынести в подпись.

## Как реализовано (as-built, 2026-09-04)

Расхождения с текстом спеки выше — осознанные, каждое покрыто тестом:

| Спека | Реализация | Почему |
|---|---|---|
| п. 5 «при `!res.ok` → `null`» | `LlmSkillFailedError` → `skipped / llm_failed` | Молчание провайдера сливалось бы с «повода нет» (R-LS-5 требует различать); `reason` несёт причину провайдера. |
| Один новый `skipReason: llm_invalid_output` | Два: `llm_invalid_output` (ответ не по контракту, `reason` содержит первые 200 символов ответа) и `llm_failed` | См. выше. |
| Task-mode при ошибке → release без причины | Оба исхода → **новая причина release `skill_failed`** (Core `ReleaseAgentRunDto`, `releaseAgentRun`): задача блокируется до owner retry, текст ошибки — в `agentExecutionBlockedReason` (панель: «Агент ждёт решения владельца») | Durable результат job терминален и на повторном claim воспроизводится тем же; без block задача крутилась бы claim→replay→release на каждом poll (без денег, но с audit-спамом). Owner retry ротирует attempt — одна новая платная попытка. |
| `isWired(name)` | Имя `hasSkill` сохранено (`= hasCodeSkill ∨ isLlmSkill`), добавлен `hasCodeSkill` для мест, где нужен именно код (`desiredJobs`, `registerLlmSkills`) | Меньше правок по коду; семантика та же. |
| `requiredChatStep` | `task-worker.ts:requiredChatStep(skill)` — `find-solution:rank` для find-solution, `llm-skill:<skill>` для llm-навыка; `route_unavailable` обобщён | Как в спеке, с именем. |
| `check-passports`: llm в schedule, kb_pages | + замечание «executor: llm, но есть код в SKILLS — исполняться будет код» | Двусмысленность резолва видна до рантайма. |
| Обрезка KB | `LLM_SKILL_KB_PAGE_CHARS` (мин. 500, по умолчанию 12 000), в `facts.kbPages` пометка «(обрезана)» | Ручка вынесена в env/compose, задокументирована в `.env.example`. |
| `apps/cc` `agent-editor.tsx` | Поле «Страницы знаний (KB)» добавлено; показ `executor` в списке навыков карточки — **не сделано** (навыки в карточке — просто список строк) | Отложено: ценность низкая, пока llm-навык один. |
| Smoke `kbPages` round-trip | `tools/smoke-core.mjs` → `проверитьКарточкуАгента` (POST/GET/PATCH/DELETE, отсечка `..` и путей вне `shared/`) | Как в спеке. |
| Существующие агенты в базе без `kb_pages`/`mission` | `tools/apply-passport-fields.mjs` (+ `.test.mjs`, шаг CI «Tools (unit)»): заполняет пустое, объединяет skills, заданное владельцем не трогает | Seed идемпотентен нарочно и существующих не обновляет; без этого llm-навык шёл бы к модели без KB. |
| CI | Шаг «Passports (агенты)» после Test: `pnpm --filter @mydon/agents check:passports` | Риск «дрейф frontmatter» закрыт тем же срезом. |

Тесты as-built: `llm-skill.test.ts` (31), `skill-loader.test.ts` (+6), `check-passports.test.ts` (+4),
`task-worker.test.ts` (+2), `agents.test.ts` (+2: `skill_failed` для обоих исходов), Core `tasks.test.ts` /
`tasks.controller.test.ts` (+2), `agents.controller.test.ts` (6, валидация `kbPages`/`webSources`), CC
`agent-forms.test.tsx` (+1), `tools/apply-passport-fields.test.mjs` (8). Итого: agents 466, core 1763, db 170,
cc 382 — зелёные.

Открытые вопросы владельцу (см. выше) решены дефолтами до первого входа: (1) `globerent-sales` остаётся `paused`,
включается кнопкой в панели; (2) второй паспорт — `globerent-service/triage-service`, после недели наблюдения;
(3) `costUsd` остаётся в `facts` (в карточке предложения виден). Список того, что проверить при первом входе —
`docs/FIRST_LOGIN_CHECKLIST.md`.
