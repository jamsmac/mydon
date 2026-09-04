# Роутер · VendHub — сеть кофейных и снековых автоматов

> Роутер = список, куда смотреть. Движок VHM24 отдельный (своя схема, не сливать), UI — в оболочке MYDON.

**Домен в коде:** `vendhub`. **Парк:** 31 автомат (кофе + снек), полевая работа через Telegram-бот.
**Доноры:** `~/Projects/VendHub/VendHubManager/VHM24` (движок), `~/Projects/VendHub-OS/VendHub-OS` (оболочка),
`~/Developer/mydon-command-center` (структура рабочего места — `src/lib/vendhub/nav.ts`).

## Агенты

| Агент | Статус | Тир | Навыки | Cron | Исполнение |
|---|---|---|---|---|---|
| `vendhub-ops` | active | T1 | monitor-stock | 08:00 ежедневно | исполняется (`skills.ts`) — деплеция, заявки, маршрут |
| `vendhub-ceo` | paused | T1 | business-brief | 18:00 ежедневно | паспорт без кода |

Мониторы вне навыков: `coffee-monitor.ts`, `maintenance-monitor.ts`, `ourvend-sync.ts`, `ourvend-accounting.ts`
(`apps/agents/src/`). Правило: пустой ответ OurVend — не зелёный синк (#247); окна сверки — от ташкентских суток (#248).

## Экраны CC

- Рабочее место `/domain/vendhub` (`VENDHUB_GROUPS` в `lib/domain-nav.ts`; дерево — решение Р-1/Р-2 от 22.08):
  **Полевая работа** (Лента · Кофе · Снек · Инкассация · Остатки в автоматах) ·
  **Номенклатура** (Профиль · Товары · Правила закупа · Компоненты · Ингредиенты · Контрагенты · Автоматы · Склады · Справочники) ·
  **Отчёты** (По источникам · Журнал продаж · Расход сырья · Сроки годности · Норма и факт · Приход · История склада ·
  План закупа · Усушка · Журнал заливок · Маржа · Мёртвый сток · Цены · Сверка кассы · Пробелы · Себестоимость).
- Сквозные: `/maintenance` (графики ТО и журнал работ), `/places` (аппарат = точка), `/coffee`, `/vending`,
  `/stock`, `/collections`, `/catalog`, `/sources`, `/imports`, `/imports/[id]`.
- Компоненты: `machine-card-360.tsx`, `machines-browser.tsx`, `machine-map.tsx`/`live-map.tsx` (Leaflet),
  `bunker-*.tsx`, `coffee-panel.tsx`, `collections-view.tsx`, `cash-reconcile.tsx`, `consumption-view.tsx`,
  `norm-fact-book.tsx`, `expiry-book.tsx`, `dead-stock-view.tsx`, `margin-view.tsx`, `menu-editor.tsx`,
  `ourvend-health-view.tsx`, `imports-panel.tsx`.

## Telegram-бот (полевые сценарии, `apps/bot/src/`)

`coffee-visit` · `coffee-refill` · `coffee-fix` · `coffee-returns` · `coffee-report` · `cash-intake` ·
`field-work` · `machine-picker` · `numpad` · `purchase-plan` · `purchase-brief` · `sales-brief` ·
`analytics-brief` · `out-rate` · `product-card` · `product-rules` · `push-hours` · `schedules` · `my-records` · `as-staff`.

## Данные и источники

- Core-модули: `apps/core/src/{coffee, collections, vending, stock, supply, sales, ourvend, raw, ingest, imports,
  maintenance, catalog, rules, gaps, verification, units}`.
- Таблицы: `machine_card`, `machine_slot`, `slot_snapshot`, `machine_sale`, `product_sale`, `sale`, `collection`,
  `purchase`, `stock_batch`, `stock_movement`, `machine_stock`, `vending_*`, `coffee_*`, `raw_*`, `operational_issue`.
- Коннекторы: `packages/connectors/src/ourvend.ts` (телеметрия/продажи OurVend), `telegram.ts`;
  разовые выгрузки — `tools/fetch-gjvending.mjs`, `tools/fetch-vendinghub.mjs`, `tools/fetch-telegram-history.mjs`,
  `tools/import-telegram-coffee.mjs`, `tools/import-raw.mjs`, `tools/smoke-collections.mjs`.
- Сиды: `packages/db` → `db:seed:vending`, `db:seed:coffee`, `db:import:stock-history`, `db:import:fiscal`.

## Референсы

- Узлы с инвентарными номерами, инвентаризация узлов, возврат бункеров → склад, товары на перепродажу в леджере:
  спека `docs/superpowers/specs/2026-09-04-vendhub-parts-inventory-design.md` (as-built §12, этапы У1–У6 сделаны
  04.09.2026 на ветке `feat/agentic-os-arms`); что делать владельцу — `docs/OWNER_NEXT_STEPS_parts.md`.
  Код: `apps/core/src/maintenance/parts.service.ts`, `part-count.service.ts`, `apps/core/src/coffee/coffee-ledger.service.ts`,
  `apps/core/src/stock/vending-ledger.ts`; бот `apps/bot/src/part-numbers.ts`, `part-wash.ts`, `part-count.ts`,
  `stock-tabs.ts`; панель `/parts`, `/parts/queue`, `/parts/count`, `/stock/goods`; проверки `tools/pglite-checks/`.
- Спеки: `docs/FIELD_OPS_SPEC.md`, `docs/WAREHOUSE_SPEC.md`, `docs/REPLENISHMENT_MODEL.md`,
  `docs/MACHINE_COMMON_LAYER.md`, `docs/MACHINE_STATUS_SPEC.md`, `docs/PLAN_STOCK_ABSORPTION.md`,
  `docs/PLAN_UCHET_SYRYA.md`, `docs/GJVENDING_RECIPES.md`, `docs/coffee-workflow.md`,
  `docs/DATA_QUALITY_CHECKS.md`, `docs/DATA_SOURCES.md`.
- SDD-спеки и планы (`docs/superpowers/`): vendhub-workspace-redesign, p4-field-snack, p5a-procurement-plan,
  p5b-analytics, p8a-stock-history, gigiena-snek, hvosty-snek, inkassacii-truth, p6-fiscal, p7-tasks, p8b-cutover-readiness;
  слои B (ингредиенты), C (партии/сроки), D (импорт закупок), F (норма/факт), K (касса/инкассация).
- Решения: `docs/decisions/2026-08-22-navigaciya-i-gamma.md` (Р-1 Номенклатура, Р-2 русские подписи).
- Дизайн: `docs/DESIGN_BRIEF_2026-08-22-navigaciya-i-gamma.md`, `docs/design-brief-nav-palette.html`,
  `docs/design-tokens-vendhub.css`, `design/dashboard-redesign/*.dc.html` (Main, Navigation, List, Service, Tasks).

## Правила направления

- «Аппарат = точка»: второй справочник мест не заводим.
- Узел — постоянная карточка (`part_unit`), период — где он сейчас; статус вычисляется, номер — наклейка, а не догадка (R-PU-1, R-PU-2, R-PU-5).
- «Плитка = вопрос владельца, клик = подробный ответ»; «пустой экран всегда говорит, что сделать».
- Порогов/светофоров на сверке сырья нет, пока фактическая сторона неполна (R-F3).
- Не глубже двух уровней навигации в поле зрения.
