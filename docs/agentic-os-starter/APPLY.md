# agentic-os-starter — первый шаг плана ARMS (файлы на проверку)

Пакет реализует §9 «С чего начать» из `docs/AGENTIC_OS_ARMS_PLAN.md` в части, которая не требует кода:
роутеры памяти, устав и KB агентов, зеркала политики, навыки Claude Code для процесса и дизайна.
Всё лежит здесь **зеркальными путями** и в репозиторий не вписано: применяется одной командой после проверки.
Код (`llm-skill.ts`, MCP, панели) — отдельными PR по спекам, сюда не входит.

> **Статус 04.09.2026: пакет применён** в рабочее дерево (`CLAUDE.md`, `routers/`, `memory/`, `.claude/skills/`,
> `engine/`, `apps/agents/shared/`), `verify-paths.mjs` — 253 ссылки без битых. Пакет остаётся как источник для
> повторного применения на другой машине; правки дальше делаются в применённых копиях, не здесь. Что проверить
> владельцу — `docs/FIRST_LOGIN_CHECKLIST.md`.

## Состав

| Путь в пакете → куда ляжет | Что это | Статус |
|---|---|---|
| `CLAUDE.md` → `CLAUDE.md` | главный роутер: три слоя · **цели (подтвердить)** · направления с ссылками на роутеры · правила (все прежние + 4 новых) · карта · порядок сессии | заменяет текущий (бэкап делает `apply.sh`) |
| `routers/{globerent,vendhub,personal,mydon,ventures,dev}.md` → `routers/` | роутеры направлений: агенты · экраны · данные · референсы · открытые вопросы — списками, без пересказа | новые |
| `memory/{decisions,constraints,glossary,open-questions}.md`, `memory/session-log/README.md` → `memory/` | знания: указатель решений · инварианты с источниками · глоссарий · открытые вопросы · шаблон handoff | новые |
| `claude-skills/mydon-design/{SKILL.md,rules.md,tokens.md,primitives.md,checklist.md}` → `.claude/skills/mydon-design/` | **толстый навык** дизайн-системы (аналог `/robo` из видео): роутер + правила + токены + примитивы + чек-лист | новый |
| `claude-skills/{onboard,calibrate,align}/SKILL.md` → `.claude/skills/` | мета-навыки процесса (адаптация идей RoboNuggets под правила MYDON). В пакете каталог без точки: удалённые инструменты не пишут в `.claude`, копирует `apply.sh` | новые |
| `engine/autonomy.yaml`, `engine/eval-rubric.md` → `engine/` | читаемые зеркала `policy.ts`/`tools.ts` и `coach.ts` — файлы, на которые ссылаются паспорты | новые |
| `apps/agents/shared/COMPANY.md` → `apps/agents/shared/` | устав агентов v1.1 (донор v1.0 + текущее состояние) | новый |
| `apps/agents/shared/kb/**` (14 файлов) → `apps/agents/shared/kb/` | база знаний из донора `mydon-agent-os` **как есть** (перенос, не переписывание) | новые |
| `verify-paths.mjs`, `apply.sh`, `APPLY.md` | проверка ссылок, установка, этот файл | служебные |

## Применить

```bash
cd ~/Developer/mydon
git checkout -b feat/agentic-os-starter
bash docs/agentic-os-starter/apply.sh      # бэкап CLAUDE.md, копирование без перезаписи, проверка ссылок
git diff CLAUDE.md                          # посмотреть замену; поправить раздел «Цели»
```

Затем в Claude Code: `/onboard vendhub` — бриф должен собраться из роутера за один проход; `/calibrate lite` в конце.

Проверка ссылок отдельно (из корня репо): `node docs/agentic-os-starter/verify-paths.mjs`.

## Что проверено

- Все пути в обратных кавычках во всех файлах пакета существуют в репозитории или в пакете (`verify-paths.mjs`, 04.09.2026).
- Агенты, статусы, тиры, навыки и cron — из `apps/agents/agents/*/config.yaml` на коммите d059ef8; какие навыки исполняются — из `apps/agents/src/skills.ts` (`SKILLS`).
- Вкладки рабочих мест — из `apps/cc/src/lib/domain-nav.ts`; токены — из `apps/cc/src/app/globals.css`; рубрика — из `apps/agents/src/coach.ts`.
- Правила из прежнего `CLAUDE.md` перенесены дословно (формы, секреты, доноры, TZ, strict).
- Frontmatter навыков — формат Claude Code (`name`, `description` с триггерами).

## Что НЕ найдено / требует слова владельца

1. **`PROTOCOL.md`, `MYDON_AGENT_BUILDER.md`** — нет ни в `mydon-agent-os`, ни в `mydon_1`, ни в `mydon-command-center`.
   Навык Venture Factory это допускает (шаблон из `direction-package.md`). Если оригиналы есть в чате/артефактах —
   положить в `apps/agents/shared/` и добавить строку в `routers/ventures.md`.
2. **Цели** в `CLAUDE.md` — черновик из плана; подтвердить или переписать.
3. **KB из донора** датирована июнем 2026: `pricelist.md`, `faq.md`, `machines-map.md` помечены TODO в `kb/index.md`;
   `clients.md` содержит данные по дебиторке. Перенесено как есть — актуализация за `knowledge-curator` (`kb-review`).

## Найденные несоответствия и предложения (сверх пакета)

| # | Наблюдение | Предложение |
|---|---|---|
| 1 | `apps/agents/src/registry.ts` **не читает `kb_pages`** из паспортов, код не открывает ни `COMPANY.md`, ни `shared/kb/*` — файлы читают только люди и будущий `llm-skill` | В спеке `llm-skill.ts` (волна S): собирать контекст = `COMPANY.md` + `ROLE.md` + `SKILL.md` + страницы из `kb_pages`; `check-passports` — проверять существование `kb_pages` |
| 2 | Тиры донора (`autonomy.yaml` v1) описывали надзор над действием (T0 = «авто-тихо»), а рантайм MYDON трактует тир как потолок (T0 = самый строгий) — прямой перенос создал бы противоречие | Зеркало переписано под семантику `policy.ts` (v2); в `mydon_1/agents/autonomy.yaml` та же ловушка описана в шапке — донор 1 старее |
| 3 | 19 навыков объявлены в паспортах без реализации; `runner` честно отдаёт `not_implemented` | Порядок оживления через `executor: llm` — предложен `globerent-sales/qualify-lead` первым (T1, только чтение) |
| 4 | `engine/security.md` есть, а `engine/autonomy.yaml` и `eval-rubric.md`, на которые ссылаются 4 паспорта и `coach-agent/ROLE.md`, — нет | Добавлены как зеркала с явным `source_of_truth`; при правке кода — править файл (генерацию из кода можно сделать позже) |
| 5 | `CLAUDE.md` перечислял коннекторы VHM24, Multikassa, Zadarma, cbu.uz, n8n, а в `packages/connectors/src` — `cowork, didox, github, notion, ourvend, telegram, web` | В роутерах указаны фактические; планируемые — как «планировалось». Подпись в `CLAUDE.md` → карта без списка коннекторов |
| 6 | `.eyebrow` уже существует как uppercase-метка — новый класс `.lbl` из плана не нужен | В `rules.md` — использовать `.eyebrow`; новыми остаются только `.panel.console`, `.led`, `.av8` |
| 7 | Скрипт фабрики `scripts/new_direction.py` — Python, а весь инструментарий репо — `tools/*.mjs`, Python-тулчейна в Docker нет | При переносе навыка — `tools/new-direction.mjs (план)` |

## Откат

`git checkout -- CLAUDE.md` и удалить скопированные каталоги (`git clean -n` покажет список; затем `git clean -fd routers memory .claude/skills engine apps/agents/shared` — только если они не существовали до применения). Бэкап `CLAUDE.md` — в `docs/agentic-os-starter/_backup/`.
