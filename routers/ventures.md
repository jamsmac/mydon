# Роутер · Ventures — фабрика направлений (планируется)

**Статус:** не начато. Домена `ventures` в `DOMAINS` ещё нет, экранов нет, агентов нет.
**Источник истины по замыслу:** навык `mydon-venture-factory` (SKILL.md владельца) и §7 `docs/AGENTIC_OS_ARMS_PLAN.md`.

## Что это

Пятое направление MYDON того же уровня, что GLOBERENT и VendHub: находит в мире работающие бизнесы,
проверяет по единственному критерию («приносит доход без участия владельца»), клонирует под рынок
(Узбекистан → ЦА → СНГ → ЛатАм/Азия), собирает под каждое направление агентов, workflow и навыки,
запускает и ведёт до дохода. Владелец — только на трёх гейтах: деньги · юрлицо/договор · репутация.

## Роли → будущие агенты

| Роль | Агент (план) | Тир | Навык фазы |
|---|---|---|---|
| Scout | `venture-scout` | T1 | разведка по `sources.md`, 3–7 карточек за запуск |
| Analyst | `venture-analyst` | T1 | вердикт GO/PARK/NO по `scoring.md` (H1–H5) |
| Localizer | `venture-localizer` | T2 | `clone-spec.md` по `markets/<x>.md` |
| Builder | `venture-builder` | T2 | пакет направления → агенты через Core (`agents.create`) |
| Launcher | `venture-launcher` | T3 | продукт, оплата, каналы — до первого дохода |
| Operator | `venture-operator` | T2 | KPI, недельный отчёт, kill-критерии |
| Curator | `venture-curator` | T1 | реестр уроков, правки `sources.md` / `scoring.md` через согласование |

## Где что будет лежать (решения §7 плана)

- Навык (интерактивный режим): `.claude/skills/mydon-venture-factory/{SKILL.md, references/, scripts/}`.
- Референсы для агентов: `apps/agents/shared/kb/venture-factory/{scoring,sources,direction-package}.md`,
  `…/markets/{uzbekistan,_template}.md`; `owner-profile.md` — только владельцу (как `/personal`).
- Реестр кандидатов и вердиктов — **в Core**: `entity(type='venture_candidate')`, дедуп по сигнатуре источника.
- Направление = `project` + `document` «DIRECTION.md» + агенты с `business='ventures:<slug>'` + `money_flow` + `task`.
- Пакеты `ventures/<slug>/` — формат авторства и сид (как паспорта агентов); скрипт — `tools/new-direction.mjs (план)`.
- Экран: `/domain/ventures` — конвейер (найдено → GO/PARK/NO → адаптация → сборка → гейт → запуск → эксплуатация → стоп),
  реестр кандидатов, карточка направления, гейт T3 во Входящих и в Telegram.

## Зависимости от волн плана

- Интерактивный режим (Scout + Analyst в Claude Code владельца) — после роутеров и `shared/` (первая неделя).
- Роли-агенты — вместе с `executor: llm` (волна S); Builder — после MCP `agents.create` (волна A); Launcher — последним.
- Вкладка — минимальная (реестр + конвейер + гейт) до Launcher: направление без Operator и kill-критериев не запускается.

## Не найдено в донорах

`PROTOCOL.md` и `MYDON_AGENT_BUILDER.md`, на которые ссылается навык, отсутствуют в `mydon-agent-os`, `mydon_1`,
`mydon-command-center` (проверено 04.09.2026). До их появления агенты пишутся по `apps/agents/agents/_template/`
и `references/direction-package.md` — так и предусмотрено навыком.
