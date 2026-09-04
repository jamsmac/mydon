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

Новое решение: добавь строку сюда и файл в `docs/decisions/`. Не дублируй текст.
