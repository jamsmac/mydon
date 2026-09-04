# 2026-09-05 · Чтения остатков товаров через одну дверь (У6, добивка)

## Активный контекст
Ветка `feat/goods-stock-reads-to-ledger` (от `main`, коммит-основание `a029e3a`), HEAD после Задачи 6 —
`f269778`. Спека `docs/superpowers/specs/2026-09-05-vending-stock-reads-to-ledger-design.md`, план
`docs/superpowers/plans/2026-09-05-vending-stock-reads-to-ledger.md`. Это добивка среза У6 (товары в
леджере) с прошлой сессии (`memory/session-log/2026-09-04-agentic-os-arms.md`): там появилась двойная
запись и тумблер `VENDING_STOCK_SOURCE`, но чтения в режиме `ledger` шли вразнобой (где-то одна дверь,
где-то ещё построчно по таблице) и пустая `vending_stock` давала ложный «0 из 0» на сверке.

## Сделано
- **Одна дверь.** `apps/core/src/stock/goods-stock.ts` (чистая логика, без импортов БД) +
  `VendingLedgerService.goodsStock()` в `vending-ledger.ts` — список позиций из прайса (не из таблицы),
  остаток по леджеру одним групповым запросом на все карточки (`ledgerQtyMany`), дата пересчёта из
  истории (`vending_stock_count`, `lastCountedByProduct`). В режиме `ledger` `vending_stock` не читается
  вообще ни одним читателем.
- **Все читатели переведены на `goodsStock()` в режиме `ledger`** (в режиме `table` — байт-в-байт старый
  код, без изменений): `stockLevels()` и приватный `stockRows()` (план закупа) в
  `apps/core/src/vending/vending.service.ts`; повтор заливки по `clientKey` в
  `apps/core/src/vending/refill.service.ts` (`stockLeft` из леджера, не из таблицы); мёртвый сток в
  `apps/core/src/vending/analytics.service.ts` (строки с `quantity === null` — в «неизвестно», не в
  отчёт). Позиции без карточки реестра дают `quantity: null` (не `0`) и не вычитаются из плана/отчётов —
  только предупреждают (`stock_unknown_card` в `PlanWarning`/`AnalyticsWarningCode`,
  `packages/shared/src/vending-reports.ts`).
- **Честная сверка.** `vendingParity()` строит объединение прайса и таблицы (не просто перебор таблицы),
  статусы словами: `ok | mismatch | no_row | no_card | inactive_with_stock | no_warehouse`; `no_row` с
  ненулевым леджером — это расхождение, а не «всё ок». Новые счётчики отчёта: `missingRows` (строк без
  записи в таблице) и `products` (число позиций прайса). Пустая `vending_stock` больше не даёт зелёную
  сверку «0 из 0».
- **Панель `/stock/goods`** (`apps/cc`): типы-зеркала `VendingParityStatus`/`VendingParityRow` в
  `apps/cc/src/lib/core.ts`, компонент `ParityStatusPill` (`apps/cc/src/components/parity-status.tsx`),
  шапка «Позиций прайса: N · без строки в таблице: N · расхождений: N · без карточки реестра: N»,
  подсказка про `no_row` с ненулевым леджером. Текст настройки `VENDING_STOCK_SOURCE` в
  `apps/core/src/system/config-spec.ts` — переформулирован под критерий катовера.
- **Проверка.** Сценарий (д) в `tools/pglite-checks/check-parts-u6.mjs`: одна дверь читает список
  прайса даже без карточки реестра, повтор заливки по леджеру, `delete from vending_stock` (пустая
  таблица) → `missingRows`/`mismatched` НЕ нулевые, `stockLevels()` в ledger-режиме не зависит от
  состояния таблицы, режим `table` — прежнее поведение (пустой ответ на пустой таблице). Дымовой сценарий
  `проверитьОстаткиТоваровВЛеджере()` в `tools/smoke-core.mjs` (`GET /vending/stock`,
  `GET /stock/vending-parity` в режиме `ledger`, настройка восстанавливается в `finally`).
- Спека дополнена абзацем «Срез 05.09» (§12, товары), `docs/OWNER_NEXT_STEPS_parts.md` — критерий
  катовера (§7) и переформулированный пункт про снятие тени/таблицы (§8).

## Урок
Правка общего типа (`PurchasePlan.stock.unknown` в `packages/shared/src/vending-reports.ts`, Задача 3)
дважды пробила гейт: сначала фикстуры `apps/cc` (чинилось в рамках Задачи 3, коммит `9d658aa`), потом
фикстуры `apps/bot` (пропущено до Задачи 7, дочинено отдельным коммитом `036747d`) — оба раза потому,
что проверяли `core`/`shared`, а не `pnpm typecheck` по ВСЕМ пакетам сразу. Правка общего типа обязана
сразу сопровождаться прогоном `pnpm typecheck` по всему монорепо, а не только по пакету, где тип завёлся.

## Что НЕ сделано (сознательно, не в этом срезе)
- **Тень не убрана.** Все четыре писателя (`intake`/`consumption`/`adjustment`/пересчёт) продолжают
  писать в `vending_stock` даже в режиме `ledger` — двойная запись осталась как есть с прошлой сессии.
- **Таблица `vending_stock` не удалена и не заморожена.**
- **Прод не переключён.** `VENDING_STOCK_SOURCE` на проде НЕ трогали — этот срез только чинит чтения на
  случай, когда владелец включит `ledger`; переключение остаётся ручным шагом владельца из
  `docs/OWNER_NEXT_STEPS_parts.md` §7, после недели нулевой сверки.

## Как проверить на проде после мержа
Настройка сейчас `table` (флип этим срезом не делается) — проверка на неизменность поведения:
- `GET /stock/vending-parity` → `missingRows = 28`, `mismatched = 0`, `products = 52`.
- `GET /vending/stock` → те же 24 строки, что и раньше (режим `table` — код не менялся, только физически
  перенесён под условие).

Если к моменту проверки настройка уже `ledger` (после катовера владельцем) — сверка не должна давать
ложный «0 из 0» на пустой/неполной `vending_stock`; расхождения и `no_row` с ненулевым леджером обязаны
быть видны в `missingRows`/`mismatched` и в статусах строк панели `/stock/goods`.

## Откат
Вернуть `VENDING_STOCK_SOURCE=table` (Система → Настройки). Код читателей ветвится по этому значению —
откат на `table` возвращает байт-в-байт старое поведение (чтение из `vending_stock`), без миграций назад.

## Ожидает
- Владелец: смёржить PR (после зелёного CI, шаг «Scenarios on real SQL (parts U1-U6)» обязателен),
  squash. После деплоя — сверить `GET /stock/vending-parity` на проде (см. выше), настройку не трогать.
- Дальше по `docs/OWNER_NEXT_STEPS_parts.md` §8: снять тень (четыре писателя) и затем таблицу —
  отдельным срезом, после недели жизни на `ledger`.
