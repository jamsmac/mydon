# Волна S, остаток: skills deck, cron-допуск llm-навыков, мета-навыки

Дата: 05.09.2026 · ветка `feat/skills-deck-cron-llm` · план ARMS `docs/AGENTIC_OS_ARMS_PLAN.md` §6.1 пп. 4–6, §9
(остаток волны S) · продолжение спеки `2026-09-04-llm-skill-executor-design.md` (снимает две её «явные границы»:
«нет cron для llm» и «нет ручного запуска из панели»).

## 1. Слово владельца — что должно быть

«Сделай всё по порядку до 100% production ready» (05.09). Критерий готовности волны S из плана §6.1 п. 6:
**любой навык запускается из deck и даёт предложение во Входящих; `check:passports` зелёный; один экран сделан через
`/mydon-design` без ручной правки токенов.** Владелец недоступен для вопросов — решения ниже приняты по правилу
«сначала факты, потом одно решение без вариантов» и записаны в `docs/decisions/2026-09-05-skills-deck-cron-llm.md`.

## 2. Что есть сейчас (факты из кода 05.09)

- Метаданные навыков (`description`, `executor`, `requires-approval`, `triggers`, `model-effort`, `allowed-tools`)
  живут ТОЛЬКО в файлах `apps/agents/agents/<agent>/skills/*.md`; их читает `apps/agents/src/skill-loader.ts`.
  Core в `agent.skills` хранит одни имена. Панель не знает ни тира навыка, ни исполнителя.
- Запуск навыка возможен двумя путями: cron (`apps/agents/src/index.ts` → `desiredJobs(agents, hasCodeSkill)`) и
  задача агенту (`task-worker.ts`: навык угадывается по заголовку — `matchSkill`). Из панели навык не запустить.
- Cron для `executor: llm` закрыт: `desiredJobs` пропускает llm-навыки, `scheduledInvocationMode` бросает на
  metered-навыке вне `DURABLE_SCHEDULED_SKILLS = ["coach-review"]`; `check-passports` ругается на llm в расписании
  (R-LS-11). При этом durable-путь «cron → задача в Core → worker» уже есть (`ensureAgentSchedule`,
  `clientKey = agent-schedule:v1:<sha256>`, `pollScheduledAgentTasks`).
- Усилие модели у llm-навыка — только `model-effort` из frontmatter (`llm-skill.ts:333`); цепочка моделей —
  глобальная (`LLM_MODEL` + `LLM_FALLBACK_MODELS`), тиров simple/complex в рантайме нет.
- Экраны консольной грамматики (§4 `rules.md`) ещё не сделаны: `.panel.console`, `.led`, `.av8`, тёмная тема на
  маршрутах — только описаны.
- Дубли согласований `chief-of-staff` починены (22ad1fb, `signatureFacts`) — cron для llm не размножит очередь.

## 3. Инварианты

- **R-SD-1 Каталог — зеркало файлов.** Источник истины о навыке — его `.md`. Агенты при каждом успешном старте
  ПОЛНОСТЬЮ переписывают каталог в Core (`PUT /agents/skills/catalog`, одна транзакция: удалить всё → вставить всё).
  Панель читает только Core. Нет каталога — deck пуст и говорит «запусти агентов».
- **R-SD-2 Запуск из deck = обычная задача агенту.** `POST /agents/:name/skills/:skill/run` создаёт `task`
  (`ownerKind=agent`, `ownerRef=<agent>`, `source=skills-deck`, `agentSkill=<skill>`), дальше тот же путь
  `task-worker → runner → policy → approval`. Ни тиры, ни бюджеты, ни `break_glass` не обходятся.
- **R-SD-3 Явный навык побеждает угадывание.** У задачи появляется поле `agent_skill`; worker берёт его прежде
  `matchSkill` (если навык закреплён за агентом и реализован). Задачи по расписанию тоже несут `agent_skill`.
  Без поля — прежнее поведение.
- **R-SD-4 Усилие per-run, модель — показ.** `task.run_options = {modelEffort?}`; llm-навык подставляет
  `runOptions.modelEffort ?? meta.modelEffort` в `reasoningEffort`. Код-навыки поле игнорируют. Модель в deck —
  глобальная цепочка из настроек (только чтение): per-run выбор модели в этой фазе НЕ вводится (rантайм его не
  умеет, спека llm-skill «Явные границы»).
- **R-SD-5 Cron для llm — только durable-task.** `scheduledInvocationMode` отдаёт `durable-task` для любого
  `isLlmSkill`; `desiredJobs` принимает `hasSkill` (код ∨ llm). Legacy in-process путь для llm не существует.
  `check-passports` больше не считает llm в расписании проблемой.
- **R-SD-6 Пауза уважается сразу.** Запуск из deck — только у агента `active` и только навыка из `agent.skills`
  (иначе 409 с человеческим текстом). Worker и так не берёт задачи выключенного агента.
- **R-SD-7 «Последний запуск» — факт из задач.** Последняя задача агента с этим `agent_skill` (статус, когда,
  причина блокировки, `resultNote`, ссылка на `/tasks/<id>`). Отдельного журнала запусков нет.
- **R-SD-8 Экран — консольная грамматика без новых цветов.** Тёмная тема на маршруте `/skills`, `.panel.console`,
  `.led`, `.av8` — новые классы только на токенах и в обеих ветках темы; оранжевая заливка — не больше одной;
  пустые состояния говорят, что сделать; формы — по конвенции 24.08 (поля сохраняют ввод при ошибке).
- **R-SD-9 Мета-навыки — markdown без кода.** `.claude/skills/{devil,burst,plan-for-goal,search-connectors}/SKILL.md`
  по образцу `align`: frontmatter `name`/`description` с триггерными словами, русский язык, разделы «Когда»,
  «Шаги», «Формат», «Чего не делать», ссылки на правила MYDON (`engine/security.md`, `docs/decisions`, superpowers).
- **R-SD-10 Хеш durable-входа обратно совместим.** `taskInputHash` включает `agentSkill`/`runOptions` только когда
  они заданы: старые задачи и выполнения хешируются как раньше.

## 4. Модель данных (миграция `0087_agent_skill_catalog`)

```sql
CREATE TABLE "agent_skill_catalog" (
  "agent_name"    text NOT NULL,
  "skill"         text NOT NULL,
  "description"   text NOT NULL DEFAULT '',
  "executor"      text NOT NULL,             -- code | llm
  "tier"          text,                      -- requires-approval: T0..T4, NULL = не задан
  "triggers"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  "allowed_tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "model_effort"  text,
  "max_tokens"    integer,
  "has_code"      boolean NOT NULL DEFAULT false,
  "problems"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  "synced_at"     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("agent_name", "skill")
);
ALTER TABLE "task" ADD COLUMN "agent_skill" text;
ALTER TABLE "task" ADD COLUMN "run_options" jsonb;
CREATE INDEX "task_agent_skill_idx" ON "task" ("owner_ref", "agent_skill", "created_at" DESC) WHERE "agent_skill" IS NOT NULL;
```

Без FK на `agent`: каталог пишется из файлов, паспорт может ещё не быть в базе. Откат — `DROP TABLE`, `DROP COLUMN`
(данных не теряем: каталог пересоздаётся, поля задач — необязательные).

## 5. Core API

| Маршрут | Кто зовёт | Что делает |
|---|---|---|
| `PUT /agents/skills/catalog` `{skills: CatalogSkill[]}` | агенты при старте | транзакция: `DELETE` всего каталога → `INSERT` всех; ответ `{count, syncedAt}`; audit `agent.skill_catalog.synced` |
| `GET /agents/skills` | панель | `{syncedAt, models: {primary, fallbacks[]}, items: SkillDeckItem[]}` |
| `POST /agents/:name/skills/:skill/run` `{input?, modelEffort?, actor?}` | панель (server action) | проверки R-SD-6, `tasks.create({... source: "skills-deck", agentSkill, runOptions})`; ответ `{taskId}`; audit `agent.skill.run` |

`CatalogSkill = {agent, skill, description, executor: "code"|"llm", tier?: T0..T4, triggers: string[], allowedTools: string[],
modelEffort?: string, maxTokens?: number, hasCode: boolean, problems: string[]}`; имена — `^[a-z0-9][a-z0-9-]{0,63}$`.

`SkillDeckItem = CatalogSkill & {agentStatus, business, autonomyDefault, enabled: boolean (skill ∈ agent.skills), crons: string[],
tierFloor: T0..T4 | null (максимум тира среди одноимённых), duplicates: number, lastRun: {taskId, status, createdAt,
completedAt, blockedReason, resultNote} | null}`. Агент из файлов, которого нет в базе, отдаётся с `agentStatus: "draft"`,
`enabled: false`. Модели — `LLM_MODEL` / `LLM_FALLBACK_MODELS` через `settingValue`.

`POST /tasks` (`CreateTaskDto`) принимает необязательные `agentSkill` (`^[a-z0-9-]+$`, ≤ 64) и `runOptions.modelEffort`
(`none|minimal|low|medium|high|xhigh|max`). Claim (`POST /tasks/:id/agent-run/claim`) возвращает их в `taskInput`.
`ensureAgentSchedule` кладёт `agentSkill = input.skill`; проверка replay допускает `NULL` у строк, созданных до миграции.

## 6. Рантайм агентов

- `skill-catalog.ts` (новый): `catalogFromMetas(metas, hasCode)` → `CatalogSkill[]` (чистая функция).
- `index.ts`: после успешного `seedAgents` — `core.putSkillCatalog(...)`; сбой пишется в лог и НЕ мешает старту.
- `task-worker.ts`: `skill = execution.skill ?? checkpoint.skill ?? explicit(taskInput.agentSkill) ?? matchSkill(...)`,
  где `explicit` — только если навык в `agent.skills` и `hasSkill(skill)`.
- `llm-skill.ts`: `reasoningEffort: input.runOptions?.modelEffort ?? meta.modelEffort`.
- `schedule.ts`: `scheduledInvocationMode(skill, hasMetered, isLlm)` → llm ⇒ `durable-task`; `desiredJobs(agents, hasSkill)`.
- `check-passports.ts`: снять замечание R-LS-11; оставить «executor: llm, но есть код».

## 7. Панель `/skills`

- Маршрут `apps/cc/src/app/skills/page.tsx` (server): `core.skillDeck()`; шапка `.page-head`: «Навыки» + `.lead`
  «N навыков у M агентов · каталог обновлён <когда> · модель <primary> (+K запасных)». Ошибка Core — `CoreDown`.
  Пусто — `.empty`: «Каталог ещё не синхронизирован — перезапусти контейнер агентов; он перепишет каталог при старте».
- `components/skills-deck.tsx` (client): чипы-фильтры по агенту и направлению; сетка карточек `.panel.console`:
  аватар `.av8` + агент + `.led` (active → working, paused → idle, draft → blocked); имя навыка; описание; чипы
  «код | модель», тир словами (`TIER_LABEL`), усилие, расписания (`crons.length`), «без карточки»/«выключен у агента».
  Последний запуск: статус словами + `when()` + ссылка `/tasks/<id>`; заблокирован — причина.
  Форма запуска (`onSubmit` + `preventDefault` + `FormData` → `runSkill` в `startTransition`): textarea «Вход задачи»
  (необязательно), select «Усилие» только у `executor: llm` (`как в навыке | low | medium | high | xhigh`), кнопка
  «Запустить» (обычная, не оранжевая); успех — `router.refresh()` + строка «Задача поставлена → открыть»;
  отказ — `setError`, поля сохраняют ввод. Запуск недоступен (агент не active / навык выключен) — кнопка
  заблокирована с подсказкой «включи агента в карточке».
- `components/skill-tree.tsx`: «Карта навыков» — агент → навыки → инструменты (`allowedTools`); одноимённые у
  разных агентов помечены «×N, тир не ниже <tierFloor>».
- `components/console-theme.tsx` (client): на маршруте ставит `document.documentElement.dataset.theme = "dark"`,
  при уходе возвращает прежнее значение. Первый экран консольной грамматики; остальные маршруты §4 подключат его
  в дизайн-волне.
- `globals.css`: `.panel.console`, `.led` (+`.led.working/.idle/.blocked`), `.av8` — по `rules.md` §4, цвета только
  токенами, в обеих ветках темы. `nav.tsx`: пункт «Навыки» (`/skills`) после «Агенты».
- Тесты (vitest): `skills-deck.test.tsx` — фильтр по агенту, форма сохраняет ввод при ошибке, кнопка заблокирована
  у paused; `skill-tree.test.tsx` — дубли по имени показывают `tierFloor`.

## 8. Мета-навыки (`.claude/skills/`)

| Навык | Назначение | Формат результата |
|---|---|---|
| `devil` | контр-мнение к решению: «причина у каждого решения» — что сломается, что дешевле, что не учли | 3–5 возражений с ценой ошибки + вердикт «делать / переделать / отложить» |
| `burst` | N вариантов (по умолчанию 3) экрана/текста/подхода, каждый с тезисом в одну строку, затем рекомендация | таблица вариантов + «выбираю №, потому что»; экраны — через `/mydon-design` |
| `plan-for-goal` | план от цели в 10 секциях, совместимый со спеками superpowers | файл `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` или ответ в чате |
| `search-connectors` | поиск коннектора: официальный → CLI/API/MCP сообщества → проверка по `engine/security.md` | таблица: источник · доступ · цена · риск · рекомендация; агентный аналог — `solution-scout` |

## 9. Тесты

- Core: `agents.controller.test.ts` (+валидация каталога и run), `agents.service.test.ts` (+`skillDeck`: enabled,
  tierFloor, lastRun), `tasks.test.ts` (+`agentSkill`/`runOptions` в create/claim/schedule identity, хеш без полей
  не меняется — R-SD-10).
- Agents: `skill-catalog.test.ts`, `schedule.test.ts` (+llm → durable, desiredJobs с llm), `task-worker.test.ts`
  (+явный навык побеждает matchSkill; чужой навык игнорируется), `llm-skill.test.ts` (+effort override),
  `check-passports.test.ts` (−R-LS-11).
- CC: см. §7. Smoke `tools/smoke-core.mjs`: сценарий «каталог навыков и запуск из deck» (PUT → GET → run у
  active → задача с `agent_skill`; run у paused → 409). CI гоняет его на `postgres:17`.

## 10. Приёмка

1. Локально: gate зелёный (build/test/lint/typecheck по всем пакетам), `check:passports` зелёный, smoke ✔.
2. Прод после деплоя: `GET /agents/skills` → `items.length ≥ 25` (12 паспортов, 30 навыков на 05.09),
   `syncedAt` ≈ время старта агентов;
   `/skills` отвечает 200 и рисует карточки; запуск `vendhub-ops/parts-audit` из deck → задача со `source=skills-deck`
   → worker берёт её → предложение/задача во Входящих. Числа заранее не фиксируются — каталог зависит от файлов.
3. `check:passports` в CI зелёный при `executor: llm` в расписании (проверяется тестом, паспорта не меняются).

## 11. Выкатка и откат

Миграция аддитивна. Порядок: Core (миграция + маршруты) и агенты выходят одним образом — агенты на старте пишут
каталог; панель до первого старта агентов показывает пустое состояние с подсказкой. Откат — предыдущий образ;
колонки и таблица остаются (безвредны).

## 12. Границы этой фазы

- Нет per-run выбора модели и нет tool-calling у модели (MCP — волна A).
- Нет истории запусков как отдельной витрины (`/flows` — волна R); deck показывает последний запуск.
- Нет изменения паспортов: какие навыки перевести в `executor: llm` и поставить на cron — решает владелец через
  файлы (`FIRST_LOGIN_CHECKLIST.md`).
- Тёмная тема на остальных маршрутах §4 — дизайн-волна.

## 13. Как реализовано (as-built, 05.09.2026)

Расхождения с текстом спеки выше — осознанные, каждое покрыто тестом:

| Спека | Реализация | Почему |
|---|---|---|
| Один тип `TaskRunOptions` на вход и на выдачу | Два: `TaskRunOptions` (вход, `modelEffort: ModelEffort`) и `StoredTaskRunOptions = NonNullable<TaskRow["runOptions"]>` (выдача claim, `modelEffort?: string`) | Колонка — jsonb без enum: значение могло попасть в базу мимо DTO (ручная правка, старый клиент). Каст к `ModelEffort` был бы ложью; рантайм сам решает, что делать с незнакомым усилием. |
| «Параметров нет» проверяется по месту | Единый предикат `presentRunOptions(row)`: `null`/`undefined`/`{}` → `undefined` | «Нет параметров» и «пустые параметры» — одно и то же. Один предикат зовут и `durableTaskInputHash`, и claim, поэтому хеш и выдача не могут разойтись (R-SD-10). |
| Каталог — зеркало файлов, пишется при загрузке из Core | Пишется **один раз за процесс**, после первого успешного сида (флаг `catalogPushed` ставится только после успешной записи) | `loadFromCore` вызывается ещё и перечиткой раз в 10 минут: без флага Core получал бы ~144 одинаковые перезаписи в сутки и столько же строк аудита ни о чём. Не записалось — следующий круг попробует снова. |
| Claim отдаёт `agentSkill`/`runOptions` как есть | Клиент агентов **валидирует и молча отбрасывает** мусор: `agentSkill` по `AGENT_SKILL_NAME`, `modelEffort` по списку `MODEL_EFFORTS` | Испорченная подсказка — не повод не сделать задачу: без навыка worker возвращается к подбору по тексту (R-SD-3), без усилия — к объявленному в паспорте (R-SD-4). Уронить claim здесь значило бы заблокировать задачу из-за пустяка. |
| Архивный агент в deck → `agentStatus: "deprecated"` | На практике `draft`: `archive()` переименовывает строку в `<имя>#archived-<ts>`, и джойн deck по имени её не находит. Ветка `deprecated` (пустые навыки, пустые `crons`) срабатывает только при мягкой архивации — `archived_at` без переименования | R-SD-6 не нарушен в обоих случаях: `enabled: false`, запуск отказан. Чинится джойном по `split_part(name, '#archived-', 1)` или отдельной колонкой — за границей среза; смоук поэтому проверяет «не запускается», а не подпись статуса. |
| Необязательные поля каталога приходят `null` | На проводе они **опущены** (условные спреды в мэппинге), типы `apps/cc` — `?: T \| null` | Панель одинаково готова и к `null`, и к отсутствию ключа; сервер не обещает того, чего нет. |
| `duplicates` — сколько ещё агентов несут это имя | Считает строку саму: уникальный навык → `1`. Панель рисует `×N` только при `> 1` | Число читается как «сколько всего носителей», а не как «сколько лишних»; порог в одном месте — в разметке. |
| Тёмная тема на `/skills` | `ConsoleTheme` ставит `data-theme="dark"` после гидратации — первый кадр светлый | Пофайлового механизма темы в проекте нет. Правильный — сегментный `app/(console)/layout.tsx`, но он трогает все маршруты §4 сразу: это дизайн-волна, не этот срез. |
| `.led.working` → `--accent` (rules.md §4) | `--accent-tx` (текстовая глубина) | §1 отдаёт `--accent` только сплошным заливкам с тёмными чернилами; лампа — мелкая нетекстовая метка, заливка ею нарушила бы «оранжевого мало». `rules.md` §4 приведён в соответствие тем же коммитом, там же `.av8` — всегда `--agent`. |
| Smoke на `postgres:17` | Локально прогнан на Homebrew PostgreSQL 15.14 (скретч-база, миграции + сиды): **22 сценария, 0 провалов**; в CI — на `postgres:17` | Docker после инцидента с диском был недоступен. Сценарий без version-specific SQL, поэтому разницы движков не касается. |
| «13 агентов, ≥ 40 навыков» (§10 до правки) | Реальный каталог на паспортах 05.09 — **30 строк / 12 агентов** (13-я папка `_template` — не агент) | Числа зависят от файлов образа; порог приёмки снижен до `≥ 25`, чтобы не ломаться от одного удалённого навыка. |
| `check:passports` ругается на `executor: llm` в расписании (R-LS-11) | Проверка снята: llm-навык на cron — законный путь (durable-задача) | Ровно то, что открывал этот срез; закреплено тестом `check-passports.test.ts`, паспорта не менялись. |

Тесты as-built (все зелёные): core **1827**, agents **492**, cc **401**, shared **854**, bot **828**, db **170**.
