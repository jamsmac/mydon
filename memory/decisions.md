# Решения — указатель

> Здесь только указатель. Полный текст решения с причиной — в `docs/decisions/YYYY-MM-DD-<slug>.md`
> (образец формата — `2026-08-22-navigaciya-i-gamma.md`: решение · почему · цена ошибки · что не отменяется).
> Правило: решение без записанной причины пересматривается дёшево и вслепую — так больше не делаем.

| Дата | Решение | Где |
|---|---|---|
| 2026-08-22 | Р-1 «Номенклатура» — отдельный сквозной разрез VendHub (ключ `settings` сохранён); Р-2 подписи вкладок русские | `docs/decisions/2026-08-22-navigaciya-i-gamma.md` |
| 2026-08-24 | Мутирующие формы CC: `onSubmit` + server action в `startTransition`, поля сохраняют ввод при ошибке | `CLAUDE.md` → Правила разработки; эталон `apps/cc/src/components/customs-rates.tsx` |
| 2026-08-19 | Прямой пуш в main запрещён (прод-деплой без CI-гейта) | `.claude/hookify.block-push-to-main.local.md` |
| 2026-08-04 | GLOBERENT: переносится вся ERP PROMACH, модуль за модулем | `docs/PROMACH_TRANSFER.md` |
| 2026-07-29 | Оранжевый — лицо продукта: «увидел оранжевое — надо нажать»; две глубины (`--accent` заливка, `--hot` тонкое) | `apps/cc/src/app/globals.css` (комментарии к токенам) |
| 2026-09-04 | MYDON строится по ARMS (Skills → Memory → Routines → Applications); память — роутер-файлы; факты — Core, знания — markdown | `docs/AGENTIC_OS_ARMS_PLAN.md` |
| 2026-09-04 | Markdown-навык без кода исполняется общим `executor: llm` (один metered-вызов, строгий JSON → Proposal); агенты — только metered `openai-api`, не Agent SDK/подписка; первый паспорт `globerent-sales/qualify-lead`; ответ не по контракту блокирует задачу (`skill_failed`) до owner retry | `docs/superpowers/specs/2026-09-04-llm-skill-executor-design.md` |
| 2026-09-04 | Данные, заполненные Claude (паспорта, KB, цели), — значения по умолчанию до ревизии владельца; ревизия идёт квизом по одной карточке, система их не ждёт | `docs/FIRST_LOGIN_CHECKLIST.md`, `docs/superpowers/specs/2026-09-04-owner-review-quiz-design.md` |
| 2026-09-05 | Каталог навыков — зеркало файлов в `agent_skill_catalog` (агенты переписывают целиком на старте); запуск из deck — обычная задача агенту (`source=skills-deck`), пауза уважается сразу; per-run настраивается только усилие; llm-навык на cron — только durable-задачей; явный навык задачи побеждает подбор по заголовку | `docs/decisions/2026-09-05-skills-deck-cron-llm.md` |

Новое решение: добавь строку сюда и файл в `docs/decisions/`. Не дублируй текст.
