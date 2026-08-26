# Хвосты снек-контура — план реализации (8 задач поверх П8b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Восемь хвостов, которые четыре предыдущих среза (П4 · П5a · П5b · П8a) записали в бэклог, закрываются кодом — и на каждый вопрос владельца из §1 спеки появляется ответ в витрине, а не в `curl`. 460 импортированных инвентаризаций получают лист «История склада»; суммы снек-листов начинают находиться поиском по странице (нет U+00A0); бэкфилл `product_id` дотягивается до заливок и инвентаризаций; журнал детектора заливок получает лист и собственный потолок чтения (90, а не чужие 30); формы `Shrink*`/`VendingPlan*` перестают жить тремя рукописными копиями; `detect`/`list` получают впрыскиваемые часы; `vending_stock_count` попадает под еженедельную ретенцию своим ключом; блок здоровья в понедельничном письме начинает говорить про ОТЧЁТНУЮ неделю, а не про момент отправки.

**Architecture:** Ничего нового не заводится там, где уже есть готовое. Лист истории склада зовёт СУЩЕСТВУЮЩИЙ `GET /vending/stock-counts` (Core прирастает двумя аддитивными полями ответа, см. «Отклонения» №1); лист журнала заливок — СУЩЕСТВУЮЩИЙ `core.vendingRefillEvents`, у которого сегодня ноль вызовов. Формы отчётов переезжают в `@mydon/shared` (`vending-reports.ts`), а бот и панель оставляют себе только реэкспорт с `as`-алиасами — ни один вызывающий не правится. Ретенция истории склада — ПЯТАЯ цель уже существующего `RetentionService` (П8b), тем же кроном, тем же событием `system.retention`, но со своим ключом и своим типом границы (`cutoffAs: "date"`). Недельное здоровье — АДДИТИВНОЕ поле `WeeklyDigest.weekHealth`, считается из трёх источников (`runsInWindow`, `worstFailedStreak`, отфильтрованные по неделе `ParityDay[]`), под своим `catch`, в том же `Promise.all` и в том же кеше `weekly-digest|<неделя>|<ташкентские сутки>`.

**Tech Stack:** TypeScript strict, NestJS + class-validator, Drizzle/Postgres (**одна миграция — 0071, только индекс**), `croner` с `timezone: TZ`, `node:test` по dist (core/bot/shared) + vitest (cc), Testing Library, `tools/smoke-core.mjs` и `tools/smoke-panel.mjs` против живого Postgres и поднятой панели, Telegram-бот, Next.js App Router (панель — только чтение).

**Spec:** `docs/superpowers/specs/2026-08-26-hvosty-snek-design.md` (рулинги R-H-1…9)
**Опись:** `.superpowers/sdd/2026-08-26-hvosty-snek/inventory.md` — каталог `.superpowers/` не версионируется и в worktree `mydon-hvosty` его НЕТ; опись лежит в основном чекауте (`~/Developer/mydon/.superpowers/sdd/2026-08-26-hvosty-snek/`).

> **R-H-8 — пол 730, а не 365.** План написан по ДЕЙСТВУЮЩЕЙ редакции рулинга: `STOCK_COUNT_RETENTION_DAYS` имеет `fallback: "730"` И `validate: atLeast(730, …)`, то есть **пол равен дефолту и ключом можно только ПРОДЛИТЬ хранение**. 730 — это ровно `STOCK_COUNTS_DAYS_MAX` (`vending.service.ts:144`), потолок `?days=` листа «История склада»: окно ретенции не бывает уже окна витрины (урок R-FW-S8, где пол снапшотов подняли с 90 до 180 по этой же причине). В ветке это зафиксировано коммитом `0e2a3a2` («R-H-8 — пол ретенции инвентаризаций = окно чтения 730»); если в читаемой вами копии спеки в R-H-8 стоит пол 365 — это черновик до амендмента, и план с тестами всё равно считают по 730.

> **Зависимость от П8b.** Задачи 1–6 от П8b НЕ зависят и делаются на ветке от `origin/main` c860a1c + коммит спеки. Задачи 7 и 8 строятся ПОВЕРХ П8b и делаются ПОСЛЕ его мержа в `main`: перед ними — `git fetch && git rebase origin/main`, и `retention.service.ts` / `sync-runs.ts` / `parity-streak.ts` / `vending-reports.ts` перечитываются в дереве, а не по цитатам отсюда.

## Global Constraints

Копия §4 спеки плюс рулинги, связывающие несколько задач сразу. Нарушение здесь — не стилевая правка: срез трогает ЕДИНСТВЕННУЮ таблицу ручного труда владельца (`vending_stock_count`, 460 строк, не восстановимых ничем) и текст письма, которое приходит само.

- **R-H-1 Охват.** Ровно восемь задач описи, в её порядке. Явно ВНЕ: пачечная вставка событий детектора (O9), уникальный индекс дедупа сторожа застоя (O10), read-token для денежных GET (O11 — уходит в П8 пп. 3–5 вместе с гашением `STOCK_DATABASE_URL`). Всё, что требует решения владельца (пороги по автоматам, заведение 11 карточек, подписки на рассылку), — не задача среза.
- **R-H-2 История склада — существующий роут.** Лист зовёт `GET /vending/stock-counts?days=` (потолок 730, дефолт 90). Второго эндпоинта нет, второго потолка окна нет. `note` значит РАЗНОЕ у разных источников: у `source='own'` — **кто считал** (`vending.service.ts:1526`, `note: actor`), у `source='stock-import'` — **место донора** («2 Холодильник», `packages/shared/src/stock-history.ts:485` → `packages/db/src/import-stock-history.ts:263`, R-FW-P2). Лист обязан подписывать группу ПО ИСТОЧНИКУ, иначе имя оператора встанет в заголовок как склад.
- **R-H-3 Числа снек-листов — без U+00A0.** `money()` (`apps/cc/src/lib/format.ts:15`) ОСТАЁТСЯ с неразрывным пробелом и получает докблок: её зовут 42 раза, в основном в GLOBERENT и финансах, где число читают глазами. Снек-листы переходят на `count()` (число) и `amount()` (сумма с «сум»), локальные форматтеры удаляются. Тесты утверждают БАЙТ, а не «выглядит одинаково».
- **R-H-4 Бэкфилл дотягивается до заливок и инвентаризаций.** Расширяется СУЩЕСТВУЮЩИЙ `packages/db/src/backfill-product-ids.ts` (каталога `packages/db/scripts/` в репозитории нет; запуск — `packages/db/dist/backfill-product-ids.js`, `.github/workflows/ci.yml:82`, `packages/db/package.json:27`). Цепочка резолва НЕ меняется: алиас → `ourvend_name` → имя, тот же `productIndex` из `@mydon/shared`. Голый запуск без флагов остаётся ЗАПИСЬЮ (CI на нём и держится).
- **R-H-5 Два потолка разные по природе.** `DETECT_DAYS_MAX = 30` — потолок СКАНА СНИМКОВ (четверть миллиона строк в память, комментарий на `refill-events.service.ts:117-121`). Чтение журнала — `limit(LIST_LIMIT)` по индексированной `window_to`, и у него собственный `LIST_DAYS_MAX = 90`. Кнопка «90 дн» над сервером, который молча зажимает до 30, — тот же класс ошибки «показываем не то, что измеряли».
- **R-H-6 Ноль изменений поведения.** Переезд форм в shared делается реэкспортом **с сохранением своих имён через `as`**; ни один вызывающий в боте и панели не правится. Расхождение (панель переписала союз кодов усушки в другом порядке, инлайнила `summary`, звала план `VendingPlan` вместо `PurchasePlan`) исчезает вместе с копией.
- **R-H-7 Часы — параметр.** После задачи 6 в `refill-events.service.ts` НЕТ ни одного `new Date()` / `Date.now()` вне значений параметров по умолчанию. Контроллер не правится: умолчание и есть «сейчас», как у `stockCounts` (`vending.controller.ts:592`).
- **R-H-8 Свой ключ ретенции.** `STOCK_COUNT_RETENTION_DAYS`, `fallback "730"`, `validate: atLeast(730, …)`, колонка возраста — **`dt`, а не `counted_at`**, граница уходит голыми сутками `YYYY-MM-DD` (`cutoffAs: "date"`). `SNAPSHOT_RETENTION_DAYS` (180) описывает СНИМКИ — телеметрию, которая пересчитывается следующим сбором; инвентаризация склада не восстановима ничем.
- **R-H-9 Аддитивное поле, а не переопределение.** `WeeklyDigest.health` остаётся состоянием НА МОМЕНТ отправки; неделя едет своим `weekHealth`. `failedStreak` значит «сколько подряд падает ПРЯМО СЕЙЧАС», и подсунуть под это имя недельное число — соврать под старой подписью.
- **Время.** Только `packages/shared/src/tashkent-time.ts` (`tashkentDay`, `tashkentDayStart`, `tashkentDayStartOf`). Вторая копия смещения запрещена (R-FW-11). Голые сутки — `YYYY-MM-DD`, ISO-неделя — `IYYY-IW`. Кроны — `{ timezone: TZ }`.
- **Настройки.** Только через `apps/core/src/system/config-spec.ts` (`CONFIG_SPECS`, поля `key/label/kind/fallback/help/validate`) с русским `help`; чтение — `readIntSetting` (`apps/core/src/system/settings.ts:40`); база важнее env, но ПОЛ важнее обоих (`Math.max` в вызывающем).
- **`@Throttle`** — только именованные лимитеры `burst`/`sustained`; `default` ThrottlerGuard не читает (сторожевой тест `vending.controller.test.ts:15`). Новых роутов в срезе нет, троттлы существующих не трогаем.
- **Мутации — под `ServiceTokenGuard`; чтения — без токена.** Изменение этого — П8 пп. 3–5 (R-H-1), не здесь.
- **TS strict, без `any`.** Русский в UI, тестах и документации; идентификаторы — английские, экспортируемые имена общего слоя — латиницей (правило `report-cache.ts`).
- **Ноль ≠ «всё хорошо».** Пустая выборка рендерится ТРЕТЬИМ состоянием («не считали» / «не привозили»), а не зелёной галкой. Пустой список без объяснения запрещён и в письме (`health_unavailable`), и в листе.
- **Деньги — «N сум», проценты — «N %»** (с пробелом), минус — U+2212.
- **Документация правится ВНУТРИ задачи, которой она нужна** (`docs/DATA_SOURCES.md` — T1 и T7, `docs/DEPLOY.md` — T3, `docs/PLAN_STOCK_ABSORPTION.md` — T7), а не отдельным коммитом в конце.
- **Записей в прод из задач плана — НИ ОДНОЙ.** Единственная запись среза — прогон бэкфилла `--apply` — это шаг 4 раздела «Выкатка», его делает владелец после мержа и деплоя.
- **Тесты по dist:** `pnpm --filter @mydon/shared build` ПЕРЕД `pnpm --filter core test` / `pnpm --filter bot test`; `pnpm --filter cc test` — vitest. Существующие наборы остаются зелёными.
- **Смоук.** Каждое новое поле ответа и каждое новое окно — в `tools/smoke-core.mjs` (юнит-заглушка БД SQL не исполняет); каждый новый лист — в `tools/smoke-panel.mjs`. `tools/smoke-import.mjs` не трогаем (R-FW-S4: требует `SMOKE_SCRATCH=1` либо базы со словом `smoke` в имени).
- **Коммиты в общем worktree.** Ветка `feat/hvosty-snek` (от `main@c860a1c` + коммиты спеки `e8b6098` и `0e2a3a2` — последний и есть амендмент R-H-8 про пол 730). Коммитим ТОЛЬКО свои пути: `git commit -m "…" -- <путь> <путь>`; `git add -A` / `git commit -a` утащат чужие несохранённые правки (Codex работает на тех же репозиториях — перед правкой дерева сверять `mtime`). Conventional Commits + трейлеры `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` и `Claude-Session: …`. Push только в свою ветку: после `git checkout main` ПЕРВОЙ командой `git checkout -b` — фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты.

### Отклонения от буквы спеки, зафиксированные кодом

Пять — каждое проверено в дереве, каждое уходит в аддендум спеки шагом T8 Step 10.

1. **`StockCountsReport` получает ВТОРОЕ аддитивное поле — `since: string`.** R-H-2 говорит «единственное изменение Core — поле `note`», но подпись листа, которую задаёт та же спека («Пересчёты склада за N дн. · **с ДД.ММ.ГГГГ** · M строк»), без него печатается только двумя способами, и оба плохи: либо панель заводит ВТОРУЮ копию правила окна (`− (дни − 1)` по Ташкенту — прямо запрещено R-FW-11 и урок `stockCounts`), либо подписывает окно датой самой старой ПОКАЗАННОЙ строки, что при `history_capped` — прямая ложь. `since` уже вычисляется в `stockCounts()` (`vending.service.ts:1665`) и выбрасывается; отдать его — три символа диффа. Прецедент рядом: `DeadStockReport.since` живёт ровно за этим.
2. **Сторож снек-форматтеров запрещает `toLocaleString("ru-RU")` БЕЗ второго аргумента, а не любой `toLocaleString(`.** Спека формулирует сторож как «ни одного `toLocaleString(`», но `vending-panel.tsx:47` форматирует ДАТУ (`toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", … })`), а в списке правок R-H-3 этой строки нет вовсе — то есть буквальный сторож упал бы на строке, которую спека менять не просит. Проверяемое утверждение — «лист не заводит своего форматтера ЧИСЕЛ», и регулярка на форму без опций ловит ровно все пять локальных форматтеров и все четыре голых числовых вызова.
3. **`parityDaysInWeek` — новая чистая функция в `packages/shared/src/parity-streak.ts`.** §8 спеки требует тест «дни серии режутся границами недели» именно в `parity-streak.test.ts`, а нарезка по неделе — это правило, а не вызов. Оставь фильтр инлайном в `weekly-digest.service.ts` — и тест лёг бы не туда, где живёт код. Функция трёхстрочная, чистая, тестируется без базы.
4. **`WeeklyDigestService` получает ЧЕТВЁРТЫЙ аргумент конструктора — `OurvendParityService`.** Спека говорит «дни паритета — из `parityStreak(...).days`», но не называет, кто их приносит. Цикла нет и правки модуля не нужно: `OurvendParityService` УЖЕ провайдер и экспорт `VendingModule` (`vending.module.ts:41,53`), а живёт он там ровно потому, что `OurvendModule` импортирует `VendingModule`, а не наоборот (шапка `vending.module.ts:16-24`). Правится один стенд — `weekly-digest.service.test.ts:202`.

5. **Ссылка спеки на «место донора» в `note` поправлена.** R-H-2 и R-H-4 цитируют `import-stock-history.ts:310` — по этой строке лежит `note` ЗАКУПКИ (`d?.note` донорской накладной). Место пересчёта складывает `importNote(row.location_name)` в `packages/shared/src/stock-history.ts:485` (докблок `:456`), а в базу оно уезжает через `packages/db/src/import-stock-history.ts:263`. Смысл рулинга не меняется, меняется адрес: реализующий по цитате `:310` открыл бы не тот код.

## Карта файлов

| Файл | Задача | Роль |
|---|---|---|
| `packages/shared/src/vending-reports.ts` | T1·T5·T8 | `StockCountRow.note` + `StockCountsReport.since`; восемь форм `Shrink*`/`Plan*`; `WeeklyHealth` + `WeeklyDigest.weekHealth` |
| `packages/shared/src/vending-reports-contracts.test.ts` | T1·T5·T8 | наборы полей: история склада, `ShrinkReport`/`PurchasePlan`, `WeeklyHealth` |
| `packages/shared/src/parity-streak.ts` (+test) | T8 | `parityDaysInWeek` |
| `apps/core/src/vending/vending.service.ts` | T1·T5 | `note`/`since` в `stockCounts()`; `PlanMachine`/`PlanWarning`/`PurchasePlan` → импорт из shared |
| `apps/core/src/vending/vending.service.test.ts` | T1 | строка истории с пометкой, подпись окна |
| `apps/core/src/vending/shrinkage.service.ts` | T5 | пять форм `Shrink*` → импорт + реэкспорт из shared |
| `apps/core/src/vending/refill-events.service.ts` (+test) | T4·T6 | `LIST_DAYS_MAX = 90`; `detect(days, now)` / `list(days, now)` |
| `apps/core/src/vending/vending.controller.ts` (+test) | T4 | `RefillEventsListDto` `@Max(90)` |
| `apps/core/src/vending/retention.service.ts` (+test) | T7 | пятая цель `vending_stock_count`, `cutoffAs: "date"` |
| `apps/core/src/vending/sync-streak.ts` (+test) | T8 | `worstFailedStreak` |
| `apps/core/src/vending/weekly-digest.service.ts` (+test) | T8 | `здоровьеНедели()`, `НЕДЕЛЯ_НЕИЗВЕСТНА`, `weekHealth` в ответе |
| `apps/core/src/ourvend/sync-runs.ts` | T8 | `RunWindow`, `WEEK_RUNS_LIMIT`, `runsInWindow`, окно у `lastSuccessRunAt` |
| `apps/core/src/system/config-spec.ts` (+test) | T7 | ключ `STOCK_COUNT_RETENTION_DAYS` |
| `packages/db/src/backfill-product-ids.ts` (+test) | T3 | четыре цели, `--dry-run` / `--apply` |
| `packages/db/src/schema.ts`, `packages/db/drizzle/0071_stock_count_retention_idx.sql` | T7 | индекс `vending_stock_count_dt_idx` |
| `apps/cc/src/lib/core.ts` (+`core-types.test.ts`) | T1·T5 | клиент `vendingStockCounts`, реэкспорт форм с алиасами |
| `apps/cc/src/lib/format.ts` (+`format.test.ts`) | T2 | докблок `money()`, тесты байта |
| `apps/cc/src/components/stock-history-view.tsx` (+test) | T1 | лист «История склада» |
| `apps/cc/src/components/refill-events-view.tsx` (+test) | T4 | лист «Журнал заливок» |
| `apps/cc/src/components/report-warnings.tsx` | T1 | `COVERED_BY_STOCK_HISTORY` |
| `apps/cc/src/components/{shrinkage,purchase-plan,sales,supply,vending-panel}-view*.tsx` | T2 | снятие U+00A0 |
| `apps/cc/src/components/snack-format.test.tsx` | T2 | сторож по исходнику |
| `apps/cc/src/lib/domain-nav.ts` | T1·T4 | два листа в `reports` + `TABLE_BACKED_LEAVES` |
| `apps/cc/src/app/domain/[domain]/page.tsx` | T1·T4 | разбор `?days=`, рендер, список исключений |
| `apps/bot/src/core-client.ts` (+test) | T5·T8 | реэкспорт `Shrink*`/`VendingPlan*` и `WeeklyHealth` |
| `apps/bot/src/weekly-digest.ts` (+test) | T8 | блок здоровья: неделя, потом «сейчас» |
| `tools/smoke-core.mjs`, `tools/smoke-panel.mjs` | T1·T4·T8 | новые поля, новое окно, два листа |
| `docs/DATA_SOURCES.md` · `docs/DEPLOY.md` · `docs/PLAN_STOCK_ABSORPTION.md` | T1·T3·T7 | где смотреть, как гонять скрипт, что снято с бэклога |

---

### Task 1: Лист «История склада» — 460 инвентаризаций перестают быть доступны только через `curl`

**Files:** Modify `packages/shared/src/vending-reports.ts` (`StockCountRow` стр. 985–993, `StockCountsReport` 996–1002), `packages/shared/src/vending-reports-contracts.test.ts` (набор «Общие формы ответов Core», стр. 64+); `apps/core/src/vending/vending.service.ts` (`stockCounts`, `select` стр. 1678–1684, маппинг 1709–1716, `return` 1717); `apps/core/src/vending/vending.service.test.ts` (набор «Вендинг Core: чтение истории склада (R-P8a-3)», тип `ИсторияRow` стр. 1564, фабрика `строка()` 1566, тест «окно, порядок и форма строки» 1606); `apps/cc/src/lib/core.ts` (блок реэкспорта стр. 308–325, клиент рядом с `vendingDeadStock` стр. 2392); `apps/cc/src/components/report-warnings.tsx` (константы `COVERED_BY_*`, конец файла); `apps/cc/src/lib/domain-nav.ts` (лист после «Приход» стр. 123, `TABLE_BACKED_LEAVES` стр. 236–274); `apps/cc/src/app/domain/[domain]/page.tsx` (импорты стр. 67, разбор окна стр. 699, рендер стр. 1986, список исключений стр. 2490–2523); `tools/smoke-core.mjs` (шаг `/vending/stock-counts?days=90`, стр. 88); `tools/smoke-panel.mjs` (список путей, стр. 88–96); `docs/DATA_SOURCES.md` (абзац «История пересчётов живёт в `vending_stock_count`», стр. 961). Create `apps/cc/src/components/stock-history-view.tsx`, `apps/cc/src/components/stock-history-view.test.tsx`.

**Interfaces (consumes):** `GET /vending/stock-counts?days=&product=` (`vending.controller.ts:591`, троттл 12/мин, DTO `@Max(730)`), `VendingService.stockCounts(days, product?, now?)` (`vending.service.ts:1658`), `ReportWindow` (`report-window.tsx`), `ReportWarnings` (`report-warnings.tsx`), `count`/`day`/`when`/`plural` (`lib/format.ts`).

**Interfaces (produces):**
```ts
/** packages/shared/src/vending-reports.ts */
export interface StockCountRow {
  dt: string;
  product: string;
  qty: number;
  source: string;
  countedAt: string;
  /**
   * Пометка строки. ЗНАЧИТ РАЗНОЕ У РАЗНЫХ ИСТОЧНИКОВ (R-H-2):
   * `own` — КТО считал (`ingestStock` пишет сюда actor, `vending.service.ts:1526`),
   * `stock-import` — МЕСТО донора («2 Холодильник»): правило — `packages/shared/src/stock-history.ts:456,485` (`importNote(row.location_name)`), запись — `packages/db/src/import-stock-history.ts:263`.
   * `null` — пометки нет; выдумывать «Основной склад» нельзя.
   */
  note: string | null;
}

export interface StockCountsReport {
  days: number;
  /**
   * Первые сутки окна, `YYYY-MM-DD` по Ташкенту — ТО ЖЕ число, по которому
   * шла выборка (`stockCounts`, `− (дни − 1)`). Едет в ответе, а не считается
   * витриной: вторая копия правила окна разошлась бы с выборкой на первом же
   * уточнении, а подписать окно датой самой старой ПОКАЗАННОЙ строки нельзя —
   * при `history_capped` это прямая ложь.
   */
  since: string;
  product: string | null;
  rows: StockCountRow[];
  warnings: AnalyticsWarning[];
}

/** apps/cc/src/lib/core.ts */
/** История пересчётов склада (П8a). Окно зажимает ядро: 1..730, дефолт 90. */
vendingStockCounts: (days = 90, product?: string) => Promise<StockCountsReport>;

/** apps/cc/src/components/report-warnings.tsx */
export const COVERED_BY_STOCK_HISTORY: AnalyticsWarningCode[] = ["stock_missing"];

/** apps/cc/src/components/stock-history-view.tsx */
export const STOCK_HISTORY_WINDOWS = [30, 90, 365, 730] as const;
/** Группа строк одних суток: пара (источник, пометка) — заголовок, строки — позиции. */
export interface StockHistoryGroup { source: string; note: string | null; rows: StockCountRow[] }
export interface StockHistoryDay { dt: string; groups: StockHistoryGroup[] }
/** Чистая группировка — тестируется без рендера. Сутки вниз, внутри суток — по паре. */
export function groupStockCounts(rows: readonly StockCountRow[]): StockHistoryDay[];
export function StockHistoryTables({ report }: { report: StockCountsReport }): JSX.Element;
export async function StockHistoryView(
  { domain, days, q }: { domain: string; days: number; q: string },
): Promise<JSX.Element>;
```

Что обязана делать реализация:
- Core: `note: vendingStockCount.note` в `select`, `note: r.note` в маппинге, `since` — уже посчитанная в `stockCounts()` переменная `since` уходит в ответ. Окно, потолки (`STOCK_COUNTS_DAYS_MAX = 730`, `STOCK_COUNTS_MAX = 2000`), кеш, троттл и оба предупреждения (`history_capped`, `stock_missing`) — БЕЗ изменений.
- `groupStockCounts`: сутки сортируются `dt` вниз ЯВНО, а не «как пришло»: Core сортирует по `counted_at desc`, и строка, введённая сегодня за июнь, иначе разорвала бы июньскую группу. Внутри суток — по паре `(source, note)` в порядке первого появления.
- Заголовок группы: `note ?? "без пометки"`, рядом `<small>` — «место» для `stock-import`, «кто считал» для `own`. Единый заголовок «место» запрещён (R-H-2): владелец прочитает «Рустам» как название склада и заведёт его в справочник.
- Пустое состояние БЕЗ фильтра — третье состояние: «Инвентаризаций за окно нет. Пересчёты копятся сами: их пишет бот («склад …») и панель — история появится после первого счёта.» С фильтром лист молчит: `stock_missing` от Core уже говорит нужное, и он в `covered`.
- `history_capped` НЕ покрыт: про обрезку окна лист сам не говорит, её печатает хвост «Посчитано не всё».
- Переключатель окна — существующий `<ReportWindow>` и его `?days=`-ссылки; они не несут `?q=`, то есть смена окна сбрасывает фильтр по товару — ровно как на трёх соседних листах П5b. Это сказано докблоком, а не оставлено сюрпризом; расширять общий компонент ради одного листа — вне охвата (R-H-1).

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/vending/vending.service.test.ts — правка набора «чтение истории склада»
// 1) тип фикстуры и фабрика получают пометку
type ИсторияRow = { dt: string; productName: string; qty: string; source: string; countedAt: Date; note: string | null };

const строка = (dt: string, productName: string, qty: number, source = "own", note: string | null = null): ИсторияRow => ({
  dt,
  productName,
  qty: qty.toFixed(2),
  source,
  countedAt: new Date(`${dt}T09:00:00+05:00`),
  note,
});

// 2) существующий тест «окно, порядок «свежее сверху» и форма строки»: в
//    ожидаемой строке появляются `note` и `since`.
    assert.deepEqual(о.rows[0], {
      dt: "2026-08-25",
      product: "Montella Вода минеральная 330ml",
      qty: 7,
      source: "own",
      countedAt: "2026-08-25T04:00:00.000Z",
      note: null,
    });

// 3) два новых теста в том же наборе
  it("в строке едет `note` — без него лист не сгруппирует ни по месту, ни по счётчику", async () => {
    // `note` значит РАЗНОЕ у разных источников (R-H-2): у своей строки это
    // человек, у импортированной — локация донора. Одно поле, два смысла, и
    // различает их `source` — поэтому оба обязаны доехать до витрины.
    const db = historyDb([
      строка("2026-08-25", "Sprite 250ml", 19, "own", "Рустам"),
      строка("2026-08-24", "Sprite 250ml", 12, "stock-import", "2 Холодильник"),
    ]);
    const о = await new VendingService(db).stockCounts(90, undefined, СЕЙЧАС);
    assert.deepEqual(
      о.rows.map((r) => [r.source, r.note]),
      [["own", "Рустам"], ["stock-import", "2 Холодильник"]],
    );
  });

  it("`since` — первые сутки окна, те же, по которым шла выборка", async () => {
    // Витрина подписывает окно этим числом. Считай его панель сама — в
    // репозитории появилась бы вторая копия правила `− (дни − 1)` (R-FW-11), и
    // разошлась бы она молча: подпись на сутки мимо выборки не видна никак.
    const db = historyDb([строка("2026-08-25", "Sprite 250ml", 19)]);
    const о = await new VendingService(db).stockCounts(90, undefined, СЕЙЧАС);
    assert.equal(о.since, "2026-05-28");
    const однодневное = await new VendingService(historyDb([])).stockCounts(1, undefined, СЕЙЧАС);
    assert.equal(однодневное.since, "2026-08-25", "days=1 — это «сегодня», а не «вчера»");
  });
```
```ts
// packages/shared/src/vending-reports-contracts.test.ts — новый тест в существующем describe
  it("история склада: пометка и первые сутки окна едут в ответе (R-H-2)", () => {
    const строка: StockCountRow = {
      dt: "2026-08-25",
      product: "Sprite 250ml",
      qty: 19,
      source: "stock-import",
      countedAt: "2026-08-25T04:00:00.000Z",
      note: "2 Холодильник",
    };
    const отчёт: StockCountsReport = { days: 90, since: "2026-05-28", product: null, rows: [строка], warnings: [] };
    assert.deepEqual(Object.keys(строка).sort(), ["countedAt", "dt", "note", "product", "qty", "source"]);
    assert.deepEqual(Object.keys(отчёт).sort(), ["days", "product", "rows", "since", "warnings"]);
    // `null` — законная пометка («её нет»), а не пропуск поля: выдумывать
    // «Основной склад» вместо неё нельзя.
    const безПометки: StockCountRow = { ...строка, source: "own", note: null };
    assert.equal(безПометки.note, null);
  });
```
```tsx
// apps/cc/src/components/stock-history-view.test.tsx — новый файл
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StockCountsReport } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import { STOCK_HISTORY_WINDOWS, StockHistoryTables, StockHistoryView, groupStockCounts } from "./stock-history-view";

const mocks = vi.hoisted(() => ({ vendingStockCounts: vi.fn() }));
// В одном файле с таблицами живёт серверный `StockHistoryView`, а он тянет
// клиент Core — тот первой строкой импортирует пакет `server-only`, которого
// вне RSC не существует.
vi.mock("../lib/core", () => ({
  core: { vendingStockCounts: mocks.vendingStockCounts },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

/** Боевая форма: импорт донора (три локации) плюс свой пересчёт владельца. */
const ИСТОРИЯ: StockCountsReport = {
  days: 90,
  since: "2026-05-28",
  product: null,
  rows: [
    { dt: "2026-08-25", product: "Sprite 250ml", qty: 19, source: "own", countedAt: "2026-08-25T09:40:00+05:00", note: "Рустам" },
    { dt: "2026-08-25", product: "TUC Sour cream", qty: 6, source: "own", countedAt: "2026-08-25T09:40:00+05:00", note: "Рустам" },
    { dt: "2026-06-01", product: "Montella Вода минеральная 330ml", qty: 3, source: "stock-import", countedAt: "2026-06-01T07:00:00+05:00", note: "2 Холодильник" },
    { dt: "2026-06-01", product: "Snickers", qty: 41, source: "stock-import", countedAt: "2026-06-01T07:00:00+05:00", note: "1 Склад (основной)" },
  ],
  warnings: [],
};

describe("Лист «История склада» (R-H-2)", () => {
  it("сутки идут свежими сверху, внутри суток — группы по пометке", () => {
    const дни = groupStockCounts(ИСТОРИЯ.rows);
    expect(дни.map((d) => d.dt)).toEqual(["2026-08-25", "2026-06-01"]);
    expect(дни[1]!.groups.map((g) => g.note)).toEqual(["2 Холодильник", "1 Склад (основной)"]);
    expect(дни[0]!.groups).toHaveLength(1);
    expect(дни[0]!.groups[0]!.rows.map((r) => r.product)).toEqual(["Sprite 250ml", "TUC Sour cream"]);
  });

  it("сутки сортируются ЯВНО: строка, введённая сегодня за июнь, июньскую группу не разрывает", () => {
    // Core сортирует по `counted_at desc`, а не по `dt`: поздний ввод за старый
    // день приезжает первым, и группировка «как пришло» дала бы три группы
    // вместо двух и июнь дважды.
    const поздняяЗаИюнь = { ...ИСТОРИЯ.rows[2]!, countedAt: "2026-08-25T18:00:00+05:00" };
    const дни = groupStockCounts([поздняяЗаИюнь, ...ИСТОРИЯ.rows.filter((_, i) => i !== 2)]);
    expect(дни.map((d) => d.dt)).toEqual(["2026-08-25", "2026-06-01"]);
    expect(дни[1]!.groups).toHaveLength(2);
  });

  it("пометка импортированной строки подписана «место», своей — «кто считал»", () => {
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(within(screen.getByText("Рустам").closest("div")!).getByText("кто считал")).toBeVisible();
    expect(within(screen.getByText("2 Холодильник").closest("div")!).getByText("место")).toBeVisible();
  });

  it("подпись окна берёт `since` из ответа, а не пересчитывает его", () => {
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(screen.getByText(/Пересчёты склада за 90 дн\. · с 28\.05\.2026 · 4 строк/)).toBeVisible();
  });

  it("пустая история без фильтра — третье состояние «пересчёты копятся сами», а не зелёная галка", () => {
    render(<StockHistoryTables report={{ ...ИСТОРИЯ, rows: [] }} />);
    expect(screen.getByText("Инвентаризаций за окно нет")).toBeVisible();
    expect(screen.getByText(/Пересчёты копятся сами/)).toBeVisible();
  });

  it("`history_capped` показывается хвостом «Посчитано не всё», `stock_missing` — нет: лист его покрыл", () => {
    render(
      <StockHistoryTables
        report={{
          ...ИСТОРИЯ,
          rows: [],
          product: "Загадка",
          warnings: [
            { code: "history_capped", message: "Показаны первые 2000 строк истории — сузь окно или задай товар" },
            { code: "stock_missing", message: "Истории пересчётов по «Загадка» за окно нет" },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Показаны первые 2000 строк/)).toBeVisible();
    expect(screen.queryByText(/Истории пересчётов по «Загадка»/)).toBeNull();
  });

  it("Core не ответил — лист говорит это, а не рисует пустую историю", async () => {
    const { CoreUnavailable } = await import("../lib/core");
    mocks.vendingStockCounts.mockRejectedValueOnce(new CoreUnavailable("ECONNREFUSED"));
    render(await StockHistoryView({ domain: "vendhub", days: 90, q: "" }));
    expect(screen.getByText(/ECONNREFUSED/)).toBeVisible();
  });

  it("окна листа — те, что сервер отдаёт целиком: 730 — его потолок", () => {
    expect(STOCK_HISTORY_WINDOWS).toEqual([30, 90, 365, 730]);
  });
});

describe("навигация: лист «История склада»", () => {
  it("стоит в «Отчётах» сразу за «Приходом» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    const i = reports!.leaves.findIndex((l) => l.type === "purchase");
    expect(reports!.leaves[i + 1]).toEqual({ label: "История склада", type: "stock_history" });
    // Считается на чтении (`/vending/stock-counts`), своих карточек реестра не
    // заводит — счёт по `byType` всегда 0, и чип бы погас.
    expect(isTableBackedLeaf("stock_history")).toBe(true);
  });
});
```
- [x] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → RED («note» нет в ответе, `since` не существует); `pnpm --filter cc test` → RED («Cannot find module ./stock-history-view»).
- [x] **Step 3: Общий контракт.** `packages/shared/src/vending-reports.ts`: `note: string | null` в `StockCountRow` и `since: string` в `StockCountsReport` — с докблоками из «Interfaces (produces)» выше. Докблок `note` обязан назвать ОБА смысла и источник каждого: это единственное место, где различие записано в типе, и первый же читатель без него подпишет всё «местом».
- [x] **Step 4: Core.** `vending.service.ts`, `stockCounts()`: `note: vendingStockCount.note` в `select` (после `countedAt`), `note: r.note` в маппинге строк, `since` — в `return { days: дни, since, product: канон, rows: строки, warnings }`. Больше в Core ничего: окно, потолки, кеш, троттл и оба предупреждения остаются как есть (R-H-2).
- [x] **Step 5: Клиент панели.** `apps/cc/src/lib/core.ts`: в блок `export type { … } from "@mydon/shared"` (`:308-325`) — `StockCountRow, StockCountsReport`; рядом с `vendingDeadStock` (`:2392`):
```ts
  /** История пересчётов склада (П8a). Окно зажимает ядро: 1..730, дефолт 90. */
  vendingStockCounts: (days = 90, product?: string) =>
    get<StockCountsReport>(
      `/vending/stock-counts?days=${days}${product ? `&product=${encodeURIComponent(product)}` : ""}`,
    ),
```
- [x] **Step 6: Лист.** `apps/cc/src/components/stock-history-view.tsx` по образцу `dead-stock-view.tsx`:
```tsx
import { core, CoreUnavailable, type StockCountRow, type StockCountsReport } from "../lib/core";
import { CoreDown } from "./core-down";
import { ReportWindow } from "./report-window";
import { COVERED_BY_STOCK_HISTORY, ReportWarnings } from "./report-warnings";
import { count, day, plural, when } from "../lib/format";

/**
 * Окна листа — ровно те, которые сервер отдаёт ЦЕЛИКОМ: 730 — его потолок
 * (`STOCK_COUNTS_DAYS_MAX`), 90 — его дефолт. Кнопка над окном, которое ядро
 * молча зажмёт, — это подпись, не совпадающая с числами (R-H-5).
 */
export const STOCK_HISTORY_WINDOWS = [30, 90, 365, 730] as const;

const TAB = "reports:stock_history";

export interface StockHistoryGroup { source: string; note: string | null; rows: StockCountRow[] }
export interface StockHistoryDay { dt: string; groups: StockHistoryGroup[] }

/**
 * Сутки вниз, внутри суток — по паре (источник, пометка).
 *
 * Сортировка суток ЯВНАЯ, а не «в порядке прихода»: Core отдаёт строки по
 * `counted_at desc` (`vending.service.ts`), и пересчёт, введённый сегодня за
 * июнь, приехал бы первым — июньская группа разорвалась бы на две.
 */
export function groupStockCounts(rows: readonly StockCountRow[]): StockHistoryDay[] {
  const поДням = new Map<string, Map<string, StockHistoryGroup>>();
  for (const r of rows) {
    const сутки = поДням.get(r.dt) ?? new Map<string, StockHistoryGroup>();
    поДням.set(r.dt, сутки);
    const ключ = `${r.source}|${r.note ?? ""}`;
    const группа = сутки.get(ключ) ?? { source: r.source, note: r.note, rows: [] };
    группа.rows.push(r);
    сутки.set(ключ, группа);
  }
  return [...поДням.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([dt, сутки]) => ({ dt, groups: [...сутки.values()] }));
}

/**
 * Что значит пометка — ЗАВИСИТ ОТ ИСТОЧНИКА (R-H-2). У `own` это ЧЕЛОВЕК
 * (`ingestStock` пишет в `note` актора), у `stock-import` — МЕСТО донора
 * («2 Холодильник»). Общий заголовок «место» поставил бы имя оператора в
 * колонку склада, и владелец завёл бы «Рустам» в справочник локаций.
 */
function видПометки(source: string): string {
  return source === "stock-import" ? "место" : "кто считал";
}

export function StockHistoryTables({ report }: { report: StockCountsReport }) {
  const дни = groupStockCounts(report.rows);
  const пусто = report.rows.length === 0;
  const фильтр = report.product;

  return (
    <>
      <p className="lead">
        {`Пересчёты склада за ${count(report.days)} дн. · с ${day(report.since)} · ${count(report.rows.length)} ${plural(report.rows.length, "строка", "строки", "строк")}`}
        {фильтр ? ` · товар «${фильтр}»` : ""}
      </p>

      {пусто ? (
        фильтр ? (
          // По ЗАДАННОМУ товару Core уже сказал словами (`stock_missing`), и
          // лист его не дублирует: одну причину владелец читает один раз.
          <div className="empty">
            <b>По этому товару истории нет</b>
            {"Причина — ниже, в «Посчитано не всё»: чаще всего дело в имени, а не в складе."}
          </div>
        ) : (
          <div className="empty">
            <b>Инвентаризаций за окно нет</b>
            {"Пересчёты копятся сами: их пишет бот («склад …») и панель — история появится после первого счёта."}
          </div>
        )
      ) : (
        дни.map((d) => (
          <div key={d.dt}>
            <div className="section-title">{day(d.dt)}</div>
            {d.groups.map((g) => (
              <div key={`${g.source}|${g.note ?? ""}`}>
                <div className="t">
                  <b>{g.note ?? "без пометки"}</b>
                  <small>{видПометки(g.source)}</small>
                </div>
                <div className="rows">
                  {g.rows.map((r) => (
                    <div className="row" key={`${r.countedAt}|${r.product}`}>
                      <div className="t">
                        <b>{r.product}</b>
                        <small>{when(r.countedAt)}</small>
                      </div>
                      <span className="pill">{`${count(r.qty)} шт`}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))
      )}

      <ReportWarnings warnings={report.warnings} covered={COVERED_BY_STOCK_HISTORY} />
    </>
  );
}

/**
 * Лист «История склада»: один поход в ядро, окно — из адреса (`?days=`),
 * фильтр по товару — из общего поля поиска страницы (`?q=`).
 *
 * Смена окна СБРАСЫВАЕТ фильтр: `ReportWindow` строит ссылки только с `?days=`,
 * как на всех трёх листах П5b. Расширять общий переключатель ради одного листа
 * — вне охвата среза (R-H-1); поведение одинаково у всех отчётов, и именно
 * поэтому оно не сюрприз.
 */
export async function StockHistoryView({ domain, days, q }: { domain: string; days: number; q: string }) {
  const товар = q.trim();
  let report: StockCountsReport;
  try {
    report = await core.vendingStockCounts(days, товар === "" ? undefined : товар);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  return (
    <>
      <ReportWindow domain={domain} tab={TAB} days={days} windows={STOCK_HISTORY_WINDOWS} />
      <StockHistoryTables report={report} />
    </>
  );
}
```
В `report-warnings.tsx`, рядом с `COVERED_BY_PRICE_GAP`:
```ts
/**
 * История склада сама объясняет пустоту по ЗАДАННОМУ товару своим третьим
 * состоянием. `history_capped` НЕ покрыт: про обрезку окна лист не говорит
 * ничего, и молчать о ней нельзя — показан хвост, а не всё окно.
 */
export const COVERED_BY_STOCK_HISTORY: AnalyticsWarningCode[] = ["stock_missing"];
```
- [x] **Step 7: Навигация и страница.** `domain-nav.ts`, в `VENDHUB_GROUPS` → `reports`, сразу за `{ label: "Приход", type: "purchase" }` (`:123`):
```ts
      // «Хвосты» (R-H-2): приход отвечает «что привезли», история склада —
      // «что лежало». 460 импортированных инвентаризаций (П8a) до этого листа
      // были доступны только через `curl`.
      { label: "История склада", type: "stock_history" },
```
В `TABLE_BACKED_LEAVES` (`:236`), рядом с `"dead_stock"`:
```ts
  // «Хвосты»: история склада считается на чтении (/vending/stock-counts),
  // своих карточек реестра не заводит — счёт по byType всегда 0, и чип бы погас.
  "stock_history",
```
`page.tsx`: импорт рядом с `DeadStockView` (`:67`) — `import { STOCK_HISTORY_WINDOWS, StockHistoryView } from "../../../components/stock-history-view";`; разбор окна рядом с `deadStockDays` (`:699`) — `const stockHistoryDays = (STOCK_HISTORY_WINDOWS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 90;`; рендер рядом с `dead_stock` (`:1986`) — `{group && leaf?.type === "stock_history" && <StockHistoryView domain={domain} days={stockHistoryDays} q={q ?? ""} />}`; `"stock_history"` — в список исключений generic-книги (`:2490-2523`, рядом с `"dead_stock"`).
- [x] **Step 8: Смоук и документация.** В `tools/smoke-core.mjs`, шаг `/vending/stock-counts?days=90` (`:88`) дополнить:
```js
      if (typeof о?.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(о.since))
        throw new Error(`stock-counts.since=${о?.since} — не голые сутки YYYY-MM-DD`);
      // Ключ `note` обязан ПРИСУТСТВОВАТЬ, даже когда он null: лист группирует
      // по нему, и его отсутствие — это одна безымянная куча вместо истории.
      for (const r of о.rows ?? []) if (!("note" in r)) throw new Error("в строке истории склада нет ключа note");
```
В `tools/smoke-panel.mjs`, рядом с существующими листами отчётов (`:88-96`):
```js
  // «Хвосты» (R-H-2): 460 импортированных инвентаризаций получили витрину.
  // Слово берём из содержимого листа, а не из чипа навигации: чипы группы
  // рисуются на КАЖДОМ её листе, и проверка по подписи прошла бы на чужом.
  { path: "/domain/vendhub?tab=reports:stock_history", должно: "Пересчёты склада" },
```
`docs/DATA_SOURCES.md`, к абзацу «История пересчётов живёт в `vending_stock_count`» (`:961`) — дописать: где смотреть («панель → Отчёты → **История склада**», окна 30/90/365/730) и что `note` значит РАЗНОЕ у разных источников — у `source='own'` это КТО считал, у `source='stock-import'` МЕСТО донора; лист подписывает группу по источнику, и читать `note` как «склад» безусловно нельзя.
- [x] **Step 9:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test && pnpm --filter cc test` → GREEN. `pnpm -s typecheck`. Локально на scratch-БД: `node tools/smoke-core.mjs` — шаг истории склада зелёный.
- [x] **Step 10:** `git commit -m "feat(cc,core,shared): лист «История склада» — 460 инвентаризаций получили витрину (хвосты, R-H-2)" -- packages/shared/src/vending-reports.ts packages/shared/src/vending-reports-contracts.test.ts apps/core/src/vending/vending.service.ts apps/core/src/vending/vending.service.test.ts apps/cc/src/lib/core.ts apps/cc/src/lib/domain-nav.ts apps/cc/src/components/stock-history-view.tsx apps/cc/src/components/stock-history-view.test.tsx apps/cc/src/components/report-warnings.tsx "apps/cc/src/app/domain/[domain]/page.tsx" tools/smoke-core.mjs tools/smoke-panel.mjs docs/DATA_SOURCES.md`

---

### Task 2: Числа снек-листов без U+00A0 — сумма из панели снова находится поиском

**Files:** Modify `apps/cc/src/lib/format.ts` (докблок `money()`, стр. 14–19); `apps/cc/src/components/shrinkage-view.tsx` (импорт стр. 10, локальная `n` стр. 17–21, `money()` на 100, 101, 160, 164, 244); `apps/cc/src/components/purchase-plan-view.tsx` (импорт стр. 8, локальная `n` стр. 11, все её вызовы); `apps/cc/src/components/sales-view.tsx` (локальная `money` стр. 4, вызовы 50, 51, 55, 56, 60, 61, 125); `apps/cc/src/components/supply-views.tsx` (локальная `money` стр. 5–6, вызовы 93, 116); `apps/cc/src/components/vending-panel.tsx` (локальная `sum` стр. 240, голые `toLocaleString` на 254, 271, 393, 418); `apps/cc/src/components/shrinkage-view.test.tsx`, `apps/cc/src/components/purchase-plan-view.test.tsx` (по одному тесту на байт). Create `apps/cc/src/lib/format.test.ts`, `apps/cc/src/components/snack-format.test.tsx`.

**Interfaces (consumes):** `count(v: number): string` и `amount(v: number): string` (`apps/cc/src/lib/format.ts:58`, `:63`) — обе срезают U+00A0; `money(amount, currency?)` (`:15`) — оставляет.

**Interfaces (produces):** новых экспортов нет. Меняется ГАРАНТИЯ: в выводе пяти снек-листов символа U+00A0 нет, и это утверждают два теста — по байту вывода и по исходнику.

Что обязана делать реализация:
- **`money()` НЕ ТРОГАЕМ.** Её зовут 42 раза по всей панели, в том числе в GLOBERENT и финансах, где число читают глазами, а не ищут поиском по странице. Правка `money()` — это тихая перерисовка сорока двух чужих мест без единого теста под ними (R-H-3).
- `shrinkage-view.tsx`: `money(...)` → `amount(...)` (она уже печатает «сум», подпись не меняется), локальная `n` удаляется, её вызовы → `count`. Импорт: `import { amount, count, plural } from "../lib/format";`.
- `purchase-plan-view.tsx`: локальная `n` удаляется, все её вызовы → `count`. **Денежные места `:75` и `:170` берут `count`, а не `amount`**: слово «сум» там печатает сама разметка ВНЕ `<b>` (`на <b>{n(...)}</b> сум`), и `amount()` либо задвоила бы его, либо утащила внутрь жирного — это изменение вёрстки, а не форматирования. `day()` (`toLocaleDateString`) не трогаем: это дата, а не число.
- `sales-view.tsx`: локальная `money` удаляется; вызовы → `count(Number(...))` там, где приходит `string` (`r.amount`, `SaleRow.amount: string`), и `count(...)` там, где число (`summary.today.amount`). Слово «сум» лист печатает своим `<span className="u">` — оно остаётся.
- `supply-views.tsx`: локальная `money` удаляется с СОХРАНЕНИЕМ ветки `null → "—"`: `PurchaseRow.total` — `string | null`, и ноль вместо прочерка читался бы как «партия на ноль сум».
- `vending-panel.tsx`: локальная `sum` удаляется, её вызовы и четыре голых `toLocaleString("ru-RU")` → `count`. Форматирование ДАТЫ на `:47` (`toLocaleString("ru-RU", { timeZone: … })`) не трогаем — это не форматтер чисел (см. «Отклонения» №2).

- [x] **Step 1: Тесты RED.**
```ts
// apps/cc/src/lib/format.test.ts — новый файл
import { describe, expect, it } from "vitest";
import { amount, count, money } from "./format";

/**
 * Сверка БАЙТА, а не вида. U+00A0 и обычный пробел на экране неотличимы —
 * ровно поэтому баг «скопированная из панели сумма не находится ни поиском по
 * странице, ни в боте» прожил до среза «Хвосты».
 */
describe("Форматтеры чисел панели (R-H-3)", () => {
  it("count() и amount() не содержат U+00A0 — эти числа копируют и сверяют", () => {
    expect(count(1_234_567)).not.toContain("\u00a0");
    expect(amount(1_234_567)).not.toContain("\u00a0");
    expect(count(1_234_567)).toBe("1 234 567");
  });

  it("money() U+00A0 СОХРАНЯЕТ: это решение R-H-3, а не забытая правка", () => {
    // Её зовут 42 раза, в основном в GLOBERENT и финансах, где число читают
    // глазами. Если этот тест однажды покраснеет «сам собой» — значит,
    // `money()` правили вместо листа, и сорок два чужих места поехали молча.
    expect(money(1_234_567)).toContain("\u00a0");
  });

  it("amount() — это money() без NBSP, а не второе правило округления", () => {
    expect(amount(1_234_567)).toBe(money(1_234_567).replace(/\u00a0/g, " "));
  });
});
```
```tsx
// apps/cc/src/components/snack-format.test.tsx — новый файл
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Сторож ПО ИСХОДНИКУ, а не по рендеру (R-H-3), тем же приёмом, что
 * `vending.controller.test.ts:15`.
 *
 * Три из пяти снек-листов — асинхронные серверные компоненты, ходящие в Core
 * (`SalesView`, `SupplyViews`, `VendingPanel`): отрендерить их в юните дороже,
 * чем прочитать файл, а утверждение всё равно про исходник — «снек-лист не
 * заводит своего форматтера чисел».
 *
 * Запрещены ровно две формы:
 *  · `toLocaleString("ru-RU")` БЕЗ второго аргумента — форматирование ЧИСЛА,
 *    оно и ставит U+00A0 между тройками разрядов;
 *  · вызов `money(` — она NBSP оставляет НАМЕРЕННО (докблок в `format.ts`).
 * Дата с опциями (`toLocaleString("ru-RU", { timeZone… })` в `vending-panel.tsx`)
 * под запрет НЕ попадает: разрядов там нет, и в списке правок R-H-3 этой
 * строки тоже нет.
 */
const СНЕК_ЛИСТЫ = [
  "shrinkage-view.tsx",
  "purchase-plan-view.tsx",
  "sales-view.tsx",
  "supply-views.tsx",
  "vending-panel.tsx",
] as const;

describe("Снек-листы не заводят своего форматтера чисел (R-H-3)", () => {
  for (const файл of СНЕК_ЛИСТЫ) {
    it(`${файл}: ни toLocaleString("ru-RU") для числа, ни money()`, () => {
      const код = readFileSync(new URL(`./${файл}`, import.meta.url), "utf8");
      expect(код).not.toMatch(/toLocaleString\("ru-RU"\)/);
      expect(код).not.toMatch(/\bmoney\(/);
    });
  }
});
```
```tsx
// apps/cc/src/components/shrinkage-view.test.tsx — дописать в конец
describe("числа усушки копируются (R-H-3)", () => {
  it("в выводе листа нет неразрывного пробела", () => {
    const { container } = render(<ShrinkageTables report={report} />);
    expect(container.textContent ?? "").not.toContain("\u00a0");
  });
});

// apps/cc/src/components/purchase-plan-view.test.tsx — дописать в конец
describe("числа плана закупа копируются (R-H-3)", () => {
  it("в выводе листа нет неразрывного пробела", () => {
    const { container } = render(<PurchasePlanTables plan={ПЛАН} />);
    expect(container.textContent ?? "").not.toContain("\u00a0");
  });
});
```
> Имена фикстуры и экспортируемой таблицы в `purchase-plan-view.test.tsx` берутся ИЗ ФАЙЛА как есть — он уже существует и уже рендерит план; новый тест только дописывает утверждение к тому, что там отрисовано.
- [x] **Step 2:** `pnpm --filter cc test` → RED (сторож падает на всех пяти файлах; тест байта — на усушке и плане).
- [x] **Step 3: Докблок `money()`.** `apps/cc/src/lib/format.ts`, заменить однострочный комментарий над `money` (`:14`):
```ts
/**
 * Сумма с разделителями разрядов. Валюта проекта — сум.
 *
 * ОСТАЁТСЯ С U+00A0 НАМЕРЕННО. Числа, которые владелец КОПИРУЕТ и сверяет с
 * ботом, печатают `count()`/`amount()` — они NBSP срезают. Здесь неразрывный
 * пробел уместен: `money()` зовут 42 раза, в основном в GLOBERENT и финансах,
 * где число читают глазами, а не ищут поиском по странице. Снек-контур на неё
 * больше не опирается (срез «Хвосты», R-H-3) — если новый снек-лист позовёт
 * `money()`, это регрессия, а не выбор, и её ловит `snack-format.test.tsx`.
 */
```
- [x] **Step 4: Усушка и план закупа.** `shrinkage-view.tsx`: `import { amount, count, plural } from "../lib/format";`, удалить локальную `n` вместе с её объясняющим комментарием (`:17-21`), `n(` → `count(`, `money(` → `amount(`. `purchase-plan-view.tsx`: `import { count, when } from "../lib/format";`, удалить `const n = …` (`:11`), `n(` → `count(`; `day` (`toLocaleDateString`) оставить.
- [x] **Step 5: Продажи, приход, панель вендинга.** `sales-view.tsx`: удалить `const money = …` (`:4`), `import { count } from "../lib/format";`, вызовы на числах → `count(v)`, на строках (`r.amount`) → `count(Number(r.amount))`. `supply-views.tsx`: удалить `const money = …` (`:5-6`), `import { count } from "../lib/format";`, места `:93` и `:116` → `count(Number(v))` с СОХРАНЁННОЙ веткой `null → "—"` (ноль вместо прочерка читался бы как «партия на ноль сум»). `vending-panel.tsx`: удалить `const sum = …` (`:240`), добавить `count` в существующий импорт из `../lib/format`, `sum(` → `count(`, четыре голых `X.toLocaleString("ru-RU")` (`:254`, `:271`, `:393`, `:418`) → `count(X)`.
- [x] **Step 6:** `pnpm --filter cc test` → GREEN; `pnpm -s typecheck`. Глазами: `pnpm --filter cc dev` + «Отчёты → Усушка» — сумма копируется и находится `Ctrl+F` по странице.
- [x] **Step 7:** `git commit -m "fix(cc): числа снек-листов без неразрывного пробела — сумма из панели снова находится поиском (хвосты, R-H-3)" -- apps/cc/src/lib/format.ts apps/cc/src/lib/format.test.ts apps/cc/src/components/snack-format.test.tsx apps/cc/src/components/shrinkage-view.tsx apps/cc/src/components/shrinkage-view.test.tsx apps/cc/src/components/purchase-plan-view.tsx apps/cc/src/components/purchase-plan-view.test.tsx apps/cc/src/components/sales-view.tsx apps/cc/src/components/supply-views.tsx apps/cc/src/components/vending-panel.tsx`

---

### Task 3: Бэкфилл `product_id` дотягивается до заливок и инвентаризаций

**Files:** Modify `packages/db/src/backfill-product-ids.ts` (шапка стр. 1–24, `бэкфиллWhere` стр. 75, `backfillTable` стр. 82, `backfillProductIds` стр. 118, `отчёт` стр. 130, `main` стр. 138), `packages/db/src/backfill-product-ids.test.ts` (набор «UPDATE не трогает уже привязанные строки (N2)», стр. 68+), `docs/DEPLOY.md` (после блока «Разовый перенос истории склада (П8a)», стр. 121).

**Interfaces (consumes):** `productIndex` (`@mydon/shared`), `бэкфиллWhere` (тот же предикат), `vendingRefill` / `vendingStockCount` / `machineSlot` / `vendingStock` (`packages/db/src/schema.ts:1683`, `:1568`), образец флагов `--dry-run` / `--apply` (`packages/db/src/import-stock-history.ts:661-668`).

**Interfaces (produces):**
```ts
/** packages/db/src/backfill-product-ids.ts */
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

/** Одна таблица бэкфилла: имя товара + пустая ссылка на карточку. */
export interface BackfillTarget {
  /** Ключ результата — тем же словом, что в отчёте вызывающего. */
  key: "stock" | "slots" | "refills" | "stockCounts";
  /** Человеческая подпись отчёта — её читает владелец на выкатке. */
  name: string;
  table: PgTable;
  nameColumn: AnyPgColumn;
  idColumn: AnyPgColumn;
}

export const BACKFILL_TARGETS: BackfillTarget[] = [
  { key: "stock",       name: "Склад вендинга (vending_stock)",       table: vendingStock,      nameColumn: vendingStock.productName,      idColumn: vendingStock.productId },
  { key: "slots",       name: "Планограмма (machine_slot)",           table: machineSlot,       nameColumn: machineSlot.productName,       idColumn: machineSlot.productId },
  { key: "refills",     name: "Заливки (vending_refill)",             table: vendingRefill,     nameColumn: vendingRefill.productName,     idColumn: vendingRefill.productId },
  { key: "stockCounts", name: "История склада (vending_stock_count)", table: vendingStockCount, nameColumn: vendingStockCount.productName, idColumn: vendingStockCount.productId },
];

/** Предикат не меняется, меняются только типы колонок: целей теперь четыре. */
export function бэкфиллWhere(nameColumn: AnyPgColumn, idColumn: AnyPgColumn, raw: string): SQL | undefined;

export async function backfillProductIds(
  db: Database,
  opts: { dryRun?: boolean } = {},
): Promise<Record<BackfillTarget["key"], BackfillResult>>;
```

Что обязана делать реализация:
- Цепочка резолва НЕ меняется: `resolveProductIds` тот же, `productIndex` тот же, `бэкфиллWhere` тот же предикат `and(eq(nameColumn, raw), isNull(idColumn))`. Своя копия резолва (например, в миграции) разошлась бы с Core на первом же новом алиасе — это уже написано в шапке скрипта и подтверждено правкой П8a.
- `dryRun`: тот же резолв, тот же список неразрешённых имён, `UPDATE` НЕ выполняется, а `updated` считается по числу СТРОК-кандидатов на каждое разрешённое имя (в отчёте это «обновилось БЫ N»). Отчёт при `dryRun` печатает «обновилось БЫ», а не «обновлено»: одно слово отличает примерку от записи.
- `main()`: `--apply` и `--dry-run` вместе — отказ с текстом и `exit(1)`, дословно приёмом `import-stock-history.ts:663-666`. **Без флагов — ЗАПИСЬ**, как сегодня: `.github/workflows/ci.yml:82` зовёт скрипт без аргументов, и весь смысл того шага — исполнить настоящий `UPDATE` против настоящего Postgres (сценарий N2). `--apply` — явный синоним умолчания.
- Шапка файла дописывается: целей четыре, `vending_refill` и `vending_stock_count` добавлены потому, что импорт истории честно назвал владельцу 11 неопознанных имён (`import-stock-history.ts:624-628`), но привязать их после заведения карточек было нечем — петля «скрипт назвал проблему → владелец починил → система подхватила» была разомкнута в последнем звене.

- [x] **Step 1: Тесты RED.**
```ts
// packages/db/src/backfill-product-ids.test.ts — дописать
import { BACKFILL_TARGETS, backfillProductIds, бэкфиллWhere, resolveProductIds } from "./backfill-product-ids";
import { machineSlot, vendingRefill, vendingStock, vendingStockCount } from "./schema";

/**
 * Стенд: `select` отдаёт имена по таблице, `update` только СЧИТАЕТ вызовы.
 * Проверяемое утверждение у `--dry-run` — «резолв прошёл, записи не было», и
 * доказывает его именно счётчик, а не отсутствие исключения.
 */
function стенд(имена: Partial<Record<string, (string | null)[]>>) {
  const обновления: { таблица: unknown; id: string }[] = [];
  const db = {
    select: (поля?: Record<string, unknown>) => ({
      from: (t: unknown) => {
        if (t === vendingProduct) return Promise.resolve(ТОВАРЫ);
        if (t === vendingAlias) return Promise.resolve(АЛИАСЫ);
        const ключ =
          t === vendingStock ? "stock" : t === machineSlot ? "slots" : t === vendingRefill ? "refills" : "stockCounts";
        const строки = (имена[ключ] ?? []).map((name) => ({ name }));
        return { where: () => Promise.resolve(строки), then: (r: (v: unknown) => unknown) => Promise.resolve(строки).then(r) };
      },
    }),
    update: (t: unknown) => ({
      set: (patch: { productId: string }) => ({
        where: () => ({ returning: async () => { обновления.push({ таблица: t, id: patch.productId }); return [{ id: patch.productId }]; } }),
      }),
    }),
  } as never;
  return { db, обновления };
}

describe("Бэкфилл product_id: четыре цели, включая заливки и историю склада (R-H-4)", () => {
  it("цели — ровно четыре таблицы, и обе новые на месте", () => {
    assert.deepEqual(
      BACKFILL_TARGETS.map((t) => t.key),
      ["stock", "slots", "refills", "stockCounts"],
    );
    assert.equal(BACKFILL_TARGETS.find((t) => t.key === "refills")!.table, vendingRefill);
    assert.equal(BACKFILL_TARGETS.find((t) => t.key === "stockCounts")!.table, vendingStockCount);
  });

  it("имя заливки и имя строки истории резолвятся тем же правилом, что склад", async () => {
    // Импорт истории (П8a) назвал владельцу 11 неопознанных имён, но привязать
    // их после заведения карточек было нечем: бэкфилл обходил обе таблицы.
    const { db, обновления } = стенд({ refills: ["18+"], stockCounts: ["  COCA-COLA  CLASSIC 0,5 "] });
    const итог = await backfillProductIds(db);
    assert.equal(итог.refills.updated, 1);
    assert.equal(итог.stockCounts.updated, 1);
    assert.deepEqual(обновления.map((u) => u.id).sort(), ["p-cola", "p-mont"]);
  });

  it("`--dry-run` резолвит имена и НЕ зовёт update", async () => {
    const { db, обновления } = стенд({ refills: ["18+"], stockCounts: ["Coca-Cola Classic 0,5"] });
    const итог = await backfillProductIds(db, { dryRun: true });
    assert.equal(итог.refills.updated, 1, "примерка обязана посчитать то же, что записала бы");
    assert.equal(обновления.length, 0, "примерка не пишет ни одной строки");
  });

  it("имя без карточки остаётся NULL и едет списком, а не выдуманной привязкой", async () => {
    const { db } = стенд({ stockCounts: ["Загадка", "Coca-Cola Classic 0,5"] });
    const итог = await backfillProductIds(db);
    assert.deepEqual(итог.stockCounts.unresolved, ["Загадка"]);
  });

  it("предикат для новых целей тот же: `product_id IS NULL` на месте", () => {
    for (const t of BACKFILL_TARGETS) {
      const выражение = текстSQL(бэкфиллWhere(t.nameColumn, t.idColumn, "Snickers"));
      assert.match(выражение, /product_id.*is null/, `${t.key}: без этого UPDATE задел бы уже привязанные строки`);
      assert.match(выражение, /product_name/, `${t.key}: фильтр по имени не пропал`);
    }
  });
});
```
> Существующие наборы файла (резолв имени, предикат `бэкфиллWhere` для `vending_stock`/`machine_slot`) НЕ трогаются — они и есть доказательство, что правило резолва не поехало.
- [x] **Step 2:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → RED (`BACKFILL_TARGETS` не экспортируется, `backfillProductIds` не принимает `opts`).
- [x] **Step 3: Обобщить типы и завести цели.** В `backfill-product-ids.ts`: импорт `import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";` и `vendingRefill`, `vendingStockCount` из `./schema`; `бэкфиллWhere(nameColumn: AnyPgColumn, idColumn: AnyPgColumn, raw: string)` — тело без изменений; `backfillTable(db, t: BackfillTarget, products, aliases, dryRun)`; `BACKFILL_TARGETS` по интерфейсу выше. Комментарий у `BACKFILL_TARGETS`: почему цели перечислены ДАННЫМИ, а не четырьмя вызовами подряд — отчёт, тест и выкаточная команда обязаны говорить об одном и том же списке, и четвёртая цель, забытая в одном из трёх мест, — это ровно тот дефект, который здесь и чинится.
- [x] **Step 4: Примерка.** `backfillTable` при `dryRun` считает кандидатов тем же `select … where isNull(idColumn)` и НЕ выполняет `update`. `backfillProductIds(db, opts)` возвращает `Record<key, BackfillResult>` по циклу над `BACKFILL_TARGETS`. `отчёт(что, r, dryRun)` печатает `обновлено N` либо `обновилось БЫ N`, дальше — прежний хвост `осталось NULL M (имена…)`.
- [x] **Step 5: Точка входа.** `main()`:
```ts
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply && dryRun) {
    console.error("--apply и --dry-run вместе не имеют смысла: первый пишет, второй обещает не писать. Выберите один.");
    process.exit(1);
  }
  // БЕЗ ФЛАГОВ — ЗАПИСЬ, как было. `ci.yml:82` зовёт скрипт без аргументов, и
  // весь смысл того шага — исполнить настоящий UPDATE против настоящего
  // Postgres (сценарий N2). Дефолт `--dry-run` сделал бы этот шаг зелёным и
  // пустым: он проверял бы, что скрипт не падает, и ничего больше.
  const итог = await backfillProductIds(createDb(url), { dryRun });
  for (const t of BACKFILL_TARGETS) отчёт(t.name, итог[t.key], dryRun);
```
- [x] **Step 6: `docs/DEPLOY.md`.** Новый подраздел сразу после «Разовый перенос истории склада (П8a)» (после абзаца про `</dev/null`, `:121`):
```
### Разовый бэкфилл `product_id` (П4 → «Хвосты»)

Скрипт идемпотентен (трогает только строки с `product_id IS NULL`) и
автодеплоем НЕ запускается. Гонять после того, как владелец завёл недостающие
карточки прайса, — сначала примерка, потом запись:

docker exec -i mydon-core node packages/db/dist/backfill-product-ids.js --dry-run </dev/null
docker exec -i mydon-core node packages/db/dist/backfill-product-ids.js --apply   </dev/null

Целей четыре: `vending_stock`, `machine_slot`, `vending_refill`,
`vending_stock_count`. Первые две на проде уже прогонялись — по ним ждём 0
новых привязок; `vending_refill` и `vending_stock_count` привяжутся по тем
именам, которым карточка уже есть. Имена без карточки остаются `NULL` и
печатаются списком — это не отказ шага, а список на разбор владельцу.
`</dev/null` обязателен по той же причине, что и выше: без него остаток
скрипта уходит в контейнер и шаги после молча не выполняются.
```
(в самом файле блок команд обрамить тройными обратными кавычками с `bash`).
- [x] **Step 7:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `node packages/db/dist/backfill-product-ids.js --dry-run` — четыре строки отчёта со словами «обновилось БЫ»; затем без флагов — четыре строки «обновлено», повторный прогон — нули по всем четырём.
- [x] **Step 8:** `git commit -m "feat(db): бэкфилл product_id дотягивается до заливок и истории склада, флаги --dry-run/--apply (хвосты, R-H-4)" -- packages/db/src/backfill-product-ids.ts packages/db/src/backfill-product-ids.test.ts docs/DEPLOY.md`

---

### Task 4: Журнал детектора заливок в панели — мёртвый клиент получает потребителя

**Files:** Modify `apps/core/src/vending/refill-events.service.ts` (константы окон стр. 18–25, `list()` стр. 391–392), `apps/core/src/vending/refill-events.service.test.ts` (один тест границы окна), `apps/core/src/vending/vending.controller.ts` (`RefillEventsListDto` стр. 425–434), `apps/core/src/vending/vending.controller.test.ts` (набор границы DTO, по образцу «StockCountsDto: потолок окна — 730 суток», стр. 47+); `apps/cc/src/lib/domain-nav.ts` (лист после «Усушка» стр. 131, `TABLE_BACKED_LEAVES` стр. 236–274); `apps/cc/src/app/domain/[domain]/page.tsx` (импорты стр. 67, разбор окна стр. 699, рендер стр. 1986, список исключений стр. 2490–2523); `tools/smoke-core.mjs` (рядом с `"/vending/refill-events?days=14"`, стр. 81); `tools/smoke-panel.mjs` (стр. 88–96). Create `apps/cc/src/components/refill-events-view.tsx`, `apps/cc/src/components/refill-events-view.test.tsx`.

**Interfaces (consumes):** СУЩЕСТВУЮЩИЙ клиент `core.vendingRefillEvents(days = 14)` (`apps/cc/src/lib/core.ts:2401`, тип `VendingRefillEvent` `:341`) — снимать его не надо, у него сегодня ноль вызовов вне `lib/core.ts`; `RefillEventsService.list()` (`refill-events.service.ts:391`), `GET /vending/refill-events` (`vending.controller.ts:736`); `count`/`when` (`lib/format.ts`).

**Interfaces (produces):**
```ts
/** apps/core/src/vending/refill-events.service.ts */
/**
 * Потолок ЧТЕНИЯ журнала — СВОЙ, а не `DETECT_DAYS_MAX`.
 *
 * У детектора 30 суток — это потолок СКАНА СНИМКОВ: четверть миллиона строк в
 * память разом (комментарий внутри `detect`). Чтение журнала — `limit(LIST_LIMIT)`
 * по индексированной `window_to`, и держать его на чужом потолке значит
 * показывать владельцу тридцать суток под кнопкой «90 дн».
 */
export const LIST_DAYS_MAX = 90;

/** apps/cc/src/components/refill-events-view.tsx */
export const REFILL_EVENT_WINDOWS = [14, 30, 90] as const;
export function RefillEventsTable({ rows }: { rows: VendingRefillEvent[] }): JSX.Element;
export async function RefillEventsView({ domain, days }: { domain: string; days: number }): Promise<JSX.Element>;
```

Что обязана делать реализация:
- `list()`: `зажать(days, LIST_DAYS_DEFAULT, LIST_DAYS_MAX)` вместо `DETECT_DAYS_MAX`. `detect()` свой потолок не меняет — 30 суток скана снимков остаются 30 сутками скана снимков.
- `RefillEventsListDto`: `@Max(90)` плюс докблок про ДВА разных потолка и правило «страховка HTTP-входа обязана совпадать с зажимом сервиса» — как у `StockCountsDto` (`:357`).
- Панель предлагает `[14, 30, 90]` — ровно те окна, которые сервер отдаёт целиком.
- Колонки листа (R-H-5): **автомат · товар · единиц · обнаружено · источник**. Автомат без карточки подписан ТЕМ ЖЕ текстом, что в марже (`margin-view.tsx:123`) — «карточки автомата нет»: два отчёта об одном факте обязаны говорить одно. Признак «карточки нет» — `name === serial` (так `list()` и заполняет: `nameBySerial.get(канон) ?? r.machineSerial`).
- Источник: `matchedRefillId === null ? "только снимки" : "снимки + запись оператора"`. «Только снимки» — НЕ ошибка: заливка = факт снимка (R-P4-2), запись оператора — уточнение.
- Пустое состояние — третье состояние: «За N дн. детектор заливок не находил. Он смотрит снимки слотов каждые 3 часа и пишет событие при приходе от `REFILL_DETECT_MIN_UNITS` единиц — пусто значит «не привозили», а не «не считали».»
- `@Throttle` у `GET /vending/refill-events` НЕ заводим: у роута его нет сегодня, добавление лимитера — не одна из восьми задач описи (R-H-1), а выборка зажата `LIST_LIMIT = 500` по индексированной колонке.

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/vending/refill-events.service.test.ts — дописать
import { LIST_DAYS_MAX, RefillEventsService } from "./refill-events.service";

describe("Окно ЧТЕНИЯ журнала — своё, а не потолок скана снимков (R-H-5)", () => {
  it("`?days=90` читается целиком: 90 — потолок журнала, 30 — потолок детектора", async () => {
    // Раньше `list()` зажимал окно чужим `DETECT_DAYS_MAX = 30`, и кнопка
    // «90 дн» в панели показала бы тридцать суток под подписью «90».
    const { svc, окна } = сервисЧтения({ events: ЖУРНАЛ });
    await svc.list(90, СЕЙЧАС);
    const от = окна.at(-1)!;
    assert.equal(Math.round((СЕЙЧАС.getTime() - от.getTime()) / 86_400_000), 90);
    assert.equal(LIST_DAYS_MAX, 90);
  });

  it("`?days=91` зажимается до 90, а не до 30", async () => {
    const { svc, окна } = сервисЧтения({ events: ЖУРНАЛ });
    await svc.list(91, СЕЙЧАС);
    assert.equal(Math.round((СЕЙЧАС.getTime() - окна.at(-1)!.getTime()) / 86_400_000), 90);
  });
});
```
> `сервисЧтения` и `окна` — тонкая обёртка над уже существующим стендом файла: `db.select().from(vendingRefillEvent)` копит границы из условия тем же `границыОкна(условие)` (`refill-events.service.test.ts:57+`), которым файл уже пользуется. `СЕЙЧАС` появляется здесь и остаётся: Task 6 переводит на него весь набор.
```ts
// apps/core/src/vending/vending.controller.test.ts — дописать, по образцу набора StockCountsDto
import { RefillEventsListDto, StockCountsDto, VendingController } from "./vending.controller";

describe("RefillEventsListDto: потолок ЧТЕНИЯ журнала — 90 суток, не 30 (R-H-5)", () => {
  it("90 — законная верхняя граница", async () => {
    assert.deepEqual(await validate(plainToInstance(RefillEventsListDto, { days: "90" })), []);
  });

  it("91 — уже за границей, отказ", async () => {
    assert.ok((await validate(plainToInstance(RefillEventsListDto, { days: "91" }))).length > 0);
  });

  it("30 — больше не особая граница: потолок скана снимков не потолок чтения", async () => {
    assert.deepEqual(await validate(plainToInstance(RefillEventsListDto, { days: "30" })), []);
  });
});
```
```tsx
// apps/cc/src/components/refill-events-view.test.tsx — новый файл
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VendingRefillEvent } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import { REFILL_EVENT_WINDOWS, RefillEventsTable, RefillEventsView } from "./refill-events-view";

const mocks = vi.hoisted(() => ({ vendingRefillEvents: vi.fn() }));
vi.mock("../lib/core", () => ({
  core: { vendingRefillEvents: mocks.vendingRefillEvents },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

/** Боевая форма: 6 событий / 430 ед. за 14 дней на живых данных (П4). */
const СОБЫТИЯ: VendingRefillEvent[] = [
  {
    id: "ev-1",
    serial: "2508160376",
    name: "Olma Администрация",
    windowFrom: "2026-08-24T22:00:00+05:00",
    windowTo: "2026-08-25T01:00:00+05:00",
    units: 42,
    slots: [
      { coilId: "11", product: "TUC Sour cream", before: 2, after: 20, delta: 18 },
      { coilId: "12", product: "Snickers", before: 0, after: 24, delta: 24 },
    ],
    matchedRefillId: null,
  },
  {
    id: "ev-2",
    serial: "2508160359",
    // Карточки автомата нет — `list()` кладёт в `name` сам серийник.
    name: "2508160359",
    windowFrom: "2026-08-20T04:00:00+05:00",
    windowTo: "2026-08-20T07:00:00+05:00",
    units: 12,
    slots: [],
    matchedRefillId: "r-77",
  },
];

describe("Лист «Журнал заливок» (R-H-5)", () => {
  it("событие без записи оператора подписано «только снимки», с записью — «снимки + запись оператора»", () => {
    render(<RefillEventsTable rows={СОБЫТИЯ} />);
    // «Только снимки» — НЕ ошибка: заливка = факт снимка (R-P4-2), а запись
    // оператора лишь уточняет. Красить её тревогой значило бы будить владельца
    // о нормальном ходе дел.
    expect(screen.getByText("только снимки")).toBeVisible();
    expect(screen.getByText("снимки + запись оператора")).toBeVisible();
  });

  it("автомат без карточки подписан «карточки автомата нет» — тем же текстом, что маржа", () => {
    render(<RefillEventsTable rows={СОБЫТИЯ} />);
    expect(screen.getByText(/карточки автомата нет/)).toBeVisible();
  });

  it("слоты события печатаются строками, пустой список назван словами", () => {
    render(<RefillEventsTable rows={СОБЫТИЯ} />);
    expect(screen.getByText(/TUC Sour cream/)).toBeVisible();
    expect(screen.getByText("слоты не записаны")).toBeVisible();
  });

  it("пустой журнал — «не привозили», а не «не считали»", () => {
    render(<RefillEventsTable rows={[]} />);
    expect(screen.getByText(/не привозили/)).toBeVisible();
  });

  it("окна листа — те, что сервер отдаёт целиком после поднятия потолка", () => {
    expect(REFILL_EVENT_WINDOWS).toEqual([14, 30, 90]);
  });

  it("Core не ответил — лист говорит это, а не рисует пустой журнал", async () => {
    const { CoreUnavailable } = await import("../lib/core");
    mocks.vendingRefillEvents.mockRejectedValueOnce(new CoreUnavailable("ECONNREFUSED"));
    render(await RefillEventsView({ domain: "vendhub", days: 14 }));
    expect(screen.getByText(/ECONNREFUSED/)).toBeVisible();
  });
});

describe("навигация: лист «Журнал заливок»", () => {
  it("стоит в «Отчётах» сразу за «Усушкой» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    const i = reports!.leaves.findIndex((l) => l.type === "shrinkage");
    expect(reports!.leaves[i + 1]).toEqual({ label: "Журнал заливок", type: "refill_events" });
    expect(isTableBackedLeaf("refill_events")).toBe(true);
  });
});
```
- [x] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED (`LIST_DAYS_MAX` не экспортируется, `days=91` зажимается до 30, DTO отбивает 90); `pnpm --filter cc test` → RED («Cannot find module ./refill-events-view»).
- [x] **Step 3: Свой потолок чтения.** `refill-events.service.ts`: `LIST_DAYS_MAX = 90` с докблоком из «Interfaces (produces)» — рядом с `LIST_DAYS_DEFAULT`; в `list()` — `зажать(days, LIST_DAYS_DEFAULT, LIST_DAYS_MAX)`. `vending.controller.ts`: `@Max(90)` в `RefillEventsListDto` плюс докблок:
```ts
/**
 * Окно журнала детектора. Потолок 90, а НЕ 30: тридцать суток — это потолок
 * СКАНА СНИМКОВ у `detect` (четверть миллиона строк в память), а чтение
 * журнала идёт `limit(LIST_LIMIT)` по индексированной `window_to`. Число здесь
 * обязано совпадать с `LIST_DAYS_MAX` сервиса: страховка HTTP-входа, которая
 * шире зажима, молча отдаёт не то окно, которое просили (как у `StockCountsDto`).
 */
```
- [x] **Step 4: Лист.** `apps/cc/src/components/refill-events-view.tsx`:
```tsx
import { core, CoreUnavailable, type VendingRefillEvent } from "../lib/core";
import { CoreDown } from "./core-down";
import { ReportWindow } from "./report-window";
import { count, plural, when } from "../lib/format";

/** Окна — ровно те, что сервер отдаёт целиком после поднятия `LIST_DAYS_MAX` (R-H-5). */
export const REFILL_EVENT_WINDOWS = [14, 30, 90] as const;

const TAB = "reports:refill_events";

/**
 * Подпись автомата. `list()` кладёт в `name` сам серийник, когда карточки нет
 * (`nameBySerial.get(канон) ?? r.machineSerial`), и владельцу надо сказать это
 * словами — ТЕМ ЖЕ текстом, что печатает маржа (`margin-view.tsx`): два отчёта
 * об одном факте обязаны говорить одно.
 */
function автомат(e: VendingRefillEvent): { title: string; hint: string | null } {
  return e.name === e.serial ? { title: e.serial, hint: "карточки автомата нет" } : { title: e.name, hint: e.serial };
}

/**
 * Источник факта. «Только снимки» — НЕ ошибка и не тревога: заливка ЕСТЬ факт
 * снимка (R-P4-2), а запись оператора — уточнение (`matched_refill_id`).
 * Красить её как проблему значило бы будить владельца о нормальном ходе дел.
 */
function источник(e: VendingRefillEvent): string {
  return e.matchedRefillId === null ? "только снимки" : "снимки + запись оператора";
}

export function RefillEventsTable({ rows }: { rows: VendingRefillEvent[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <b>Заливок за окно не найдено</b>
        {"Детектор смотрит снимки слотов каждые 3 часа и пишет событие при приходе от порога REFILL_DETECT_MIN_UNITS — пусто значит «не привозили», а не «не считали»."}
      </div>
    );
  }
  return (
    <div className="rows">
      {rows.map((e) => {
        const м = автомат(e);
        return (
          <div className="row" key={e.id}>
            <div className="t">
              <b>{м.title}</b>
              <small>
                {[м.hint, `${when(e.windowFrom)} — ${when(e.windowTo)}`, источник(e)].filter((v): v is string => v !== null).join(" · ")}
              </small>
              {e.slots.length === 0 ? (
                <small>слоты не записаны</small>
              ) : (
                e.slots.map((s) => (
                  <small key={s.coilId}>{`${s.coilId} · ${s.product} · +${count(s.delta)} (${count(s.before)} → ${count(s.after)})`}</small>
                ))
              )}
            </div>
            <span className="pill">{`${count(e.units)} ${plural(e.units, "единица", "единицы", "единиц")}`}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Лист «Журнал заливок»: один поход в ядро, окно — из адреса (`?days=`). */
export async function RefillEventsView({ domain, days }: { domain: string; days: number }) {
  let rows: VendingRefillEvent[];
  try {
    rows = await core.vendingRefillEvents(days);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  return (
    <>
      <ReportWindow domain={domain} tab={TAB} days={days} windows={REFILL_EVENT_WINDOWS} />
      <p className="lead">
        {`Приход по снимкам за ${count(days)} дн. · ${count(rows.length)} ${plural(rows.length, "событие", "события", "событий")}`}
      </p>
      <RefillEventsTable rows={rows} />
    </>
  );
}
```
- [x] **Step 5: Навигация и страница.** `domain-nav.ts`, в `reports` сразу за `{ label: "Усушка", type: "shrinkage" }` (`:131`):
```ts
      // «Хвосты» (R-H-5): усушка говорит, КУДА делось, журнал — ЧТО привезли.
      // Клиент `vendingRefillEvents` жил без единого вызова с самого П4.
      { label: "Журнал заливок", type: "refill_events" },
```
В `TABLE_BACKED_LEAVES` — `"refill_events"` с комментарием «считается на чтении (`/vending/refill-events`), своих карточек реестра не заводит». `page.tsx`: импорт `{ REFILL_EVENT_WINDOWS, RefillEventsView }`; `const refillEventDays = (REFILL_EVENT_WINDOWS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 14;`; рендер `{group && leaf?.type === "refill_events" && <RefillEventsView domain={domain} days={refillEventDays} />}`; `"refill_events"` — в список исключений generic-книги.
- [x] **Step 6: Смоук.** В `tools/smoke-core.mjs` рядом с существующим `"/vending/refill-events?days=14"` (`:81`):
```js
  {
    // «Хвосты» (R-H-5): потолок ЧТЕНИЯ журнала — 90, а не чужие 30. Юнит на
    // заглушке проверяет зажим, но не то, что DTO пропустит значение через
    // HTTP: `@Max(30)` отдал бы 400 там, где панель рисует кнопку «90 дн».
    path: "/vending/refill-events?days=90",
    проверить: (о) => {
      if (!Array.isArray(о)) throw new Error("refill-events — не массив");
      for (const e of о) {
        for (const k of ["id", "serial", "name", "windowFrom", "windowTo", "units", "slots", "matchedRefillId"]) {
          if (!(k in e)) throw new Error(`в событии журнала нет ключа ${k}`);
        }
      }
    },
  },
```
В `tools/smoke-panel.mjs` рядом с листами отчётов: `{ path: "/domain/vendhub?tab=reports:refill_events", должно: "Журнал заливок" }` — с комментарием, что слово берётся из содержимого листа, а не из чипа навигации.
- [x] **Step 7:** `pnpm --filter core build && pnpm --filter core test && pnpm --filter cc test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `node tools/smoke-core.mjs` (шаг `days=90` зелёный), `node tools/smoke-panel.mjs`.
- [x] **Step 8:** `git commit -m "feat(cc,core): лист «Журнал заливок» и собственный потолок чтения журнала 90 суток (хвосты, R-H-5)" -- apps/core/src/vending/refill-events.service.ts apps/core/src/vending/refill-events.service.test.ts apps/core/src/vending/vending.controller.ts apps/core/src/vending/vending.controller.test.ts apps/cc/src/components/refill-events-view.tsx apps/cc/src/components/refill-events-view.test.tsx apps/cc/src/lib/domain-nav.ts "apps/cc/src/app/domain/[domain]/page.tsx" tools/smoke-core.mjs tools/smoke-panel.mjs`

---

### Task 5: Формы `Shrink*` и `VendingPlan*` переезжают в `@mydon/shared`

**Files:** Modify `packages/shared/src/vending-reports.ts` (восемь новых объявлений плюс импорты из `./vending-field`, `./vending-plan`, `./vending-calc`), `packages/shared/src/vending-reports-contracts.test.ts`; `apps/core/src/vending/shrinkage.service.ts` (объявления стр. 83–127), `apps/core/src/vending/vending.service.ts` (`PlanMachine` стр. 499, `PlanWarning` стр. 512, `PurchasePlan` стр. 531); `apps/bot/src/core-client.ts` (локальные объявления стр. 205–263 и 274–341, блок реэкспорта стр. 399–410), `apps/bot/src/core-client.test.ts` (набор «Формы аналитики приходят из @mydon/shared», стр. 87+); `apps/cc/src/lib/core.ts` (локальные объявления стр. 160–224 и 227–306, блок реэкспорта стр. 308–325), `apps/cc/src/lib/core-types.test.ts` (набор «Типы панели — реэкспорт из @mydon/shared», стр. 63+).

**Interfaces (consumes):** `ShrinkItem`/`ShrinkSummary` (`packages/shared/src/vending-field.ts:171`, `:184`), `SlotPlanRow` (`packages/shared/src/vending-plan.ts:116`), `PurchaseSummary` (`packages/shared/src/vending-calc.ts:239`) — они УЖЕ общие и остаются на своих местах: переезд ради соседства был бы диффом без выигрыша.

**Interfaces (produces):**
```ts
/** packages/shared/src/vending-reports.ts — восемь форм ПЕРЕНОСОМ, поле-в-поле */
export interface ShrinkRefillDay { date: string; detectedUnits: number; recordedUnits: number }
export interface ShrinkMachine { serial: string; name: string; summary: ShrinkSummary; refillDays: ShrinkRefillDay[] }
export type ShrinkWarningCode =
  | "snapshots_stale" | "no_sales_day" | "machine_dead"
  | "no_counted_days" | "sales_unknown_product" | "machine_error";
export interface ShrinkWarning { code: ShrinkWarningCode; message: string }
export interface ShrinkReport { from: string; to: string; threshold: number; machines: ShrinkMachine[]; warnings: ShrinkWarning[] }

export interface PlanMachine {
  serial: string; name: string; routeIndex: number;
  need: number; fromPurchase: number; fromStock: number; unfilled: number; slots: SlotPlanRow[];
}
export interface PlanWarning {
  code:
    | "stock_stale" | "stock_unknown_product" | "machine_skipped" | "no_price"
    | "unknown_product" | "sales_stale" | "sales_partial" | "route_unknown_serial";
  message: string;
}
export interface PurchasePlan {
  generatedAt: string;
  stock: { asOf: string | null; totalBefore: number; use: number; back: number; totalAfter: number; stale: boolean; unmatched: number };
  summary: PurchaseSummary;
  machines: PlanMachine[];
  routeConfigured: boolean;
  warnings: PlanWarning[];
}

/** apps/bot/src/core-client.ts и apps/cc/src/lib/core.ts — реэкспорт со СВОИМИ именами */
export type {
  ShrinkItem, ShrinkSummary, ShrinkRefillDay, ShrinkMachine, ShrinkWarningCode, ShrinkWarning, ShrinkReport,
  SlotPlanRow as VendingPlanSlot,
  PlanMachine as VendingPlanMachine,
  PlanWarning as VendingPlanWarning,
  PurchasePlan as VendingPlan,
} from "@mydon/shared";
```

Что обязана делать реализация:
- **Ноль изменений поведения.** Ни один вызывающий в боте и панели не правится: имена сохраняются через `as`. Панель дополнительно алиасит усушку под своими именами (`ShrinkItem as VendingShrinkageItem`, `ShrinkRefillDay as VendingShrinkageRefillDay`, `ShrinkMachine as VendingShrinkageMachine`, `ShrinkWarning as VendingShrinkageWarning`, `ShrinkReport as VendingShrinkageReport`).
- Одно расхождение фиксируется явно: союз `ShrinkWarningCode` берётся в порядке Core (`shrinkage.service.ts:106-112`), панельный порядок (`core.ts:274-285`) исчезает вместе с копией. Набор членов одинаков — поведение не меняется.
- Инлайненный `summary` панели (`core.ts:257-268`) становится `ShrinkSummary` — поля те же, вызывающие не правятся.
- Core реэкспортирует перенесённые формы из своих модулей (`export type { ShrinkReport } from "@mydon/shared"` в `shrinkage.service.ts`), чтобы внутренние импортёры Core (контроллер, недельная сводка, брифинг) импортировали оттуда же, откуда импортировали.
- Порядок правки — ПО ОДНОМУ ПАКЕТУ ЗА РАЗ: `pnpm -s typecheck` тогда показывает ровно одну причину, а не восемь.

- [x] **Step 1: Тесты RED.**
```ts
// packages/shared/src/vending-reports-contracts.test.ts — новый набор
describe("Формы усушки и плана закупа объявлены ОДИН раз (R-H-6)", () => {
  it("ShrinkReport: ровно те поля, что читают Core, бот и панель", () => {
    const отчёт: ShrinkReport = {
      from: "2026-08-11",
      to: "2026-08-24",
      threshold: 30_000,
      machines: [
        {
          serial: "2508160376",
          name: "Olma",
          summary: {
            items: [{ product: "Kinder Bueno", lossUnits: 9, lossValue: 99_000, surplusUnits: 0, daysCounted: 9, noPrice: false, alert: true }],
            lossValue: 99_000,
            daysCounted: 9,
            daysSkipped: 5,
            threshold: 30_000,
          },
          refillDays: [{ date: "2026-08-19", detectedUnits: 183, recordedUnits: 0 }],
        },
      ],
      warnings: [{ code: "no_counted_days", message: "все дни были заливкой" }],
    };
    assert.deepEqual(Object.keys(отчёт).sort(), ["from", "machines", "threshold", "to", "warnings"]);
    assert.deepEqual(Object.keys(отчёт.machines[0]!).sort(), ["name", "refillDays", "serial", "summary"]);
    assert.deepEqual(Object.keys(отчёт.machines[0]!.summary).sort(), ["daysCounted", "daysSkipped", "items", "lossValue", "threshold"]);
  });

  it("союз кодов усушки объявлен один раз — все шесть, и ни одного лишнего", () => {
    // Панель держала свою копию союза в ДРУГОМ порядке (`core.ts`), Core — в
    // своём. Структурная типизация порядок не ловит, а вот пропавший член —
    // ловит: лишний литерал ниже не компилируется.
    const все: ShrinkWarningCode[] = [
      "snapshots_stale", "no_sales_day", "machine_dead",
      "no_counted_days", "sales_unknown_product", "machine_error",
    ];
    assert.equal(new Set(все).size, 6);
    // @ts-expect-error — кода `machine_sleeping` в союзе нет и заводить его
    // можно только в shared, а не седьмой копией в панели.
    const лишний: ShrinkWarningCode = "machine_sleeping";
    assert.equal(лишний, "machine_sleeping");
  });

  it("PurchasePlan: ровно те поля, что читают Core, бот и панель", () => {
    const план: PurchasePlan = {
      generatedAt: "2026-08-25T09:00:00.000Z",
      stock: { asOf: "2026-08-22T09:40:00.000Z", totalBefore: 120, use: 40, back: 12, totalAfter: 92, stale: false, unmatched: 0 },
      summary: { items: [], excludedNoSales: [], excludedByRule: [], noPrice: [], totalBuy: 0, totalOrder: 0, costRounded: 0, overpay: 0, shortfallCost: 0, totalFromPurchase: 0, totalFromStock: 0, totalUnfilled: 0, totalToStock: 0 },
      machines: [],
      routeConfigured: true,
      warnings: [{ code: "sales_partial", message: "автомата нет в свежем батче продаж" }],
    };
    assert.deepEqual(Object.keys(план).sort(), ["generatedAt", "machines", "routeConfigured", "stock", "summary", "warnings"]);
    assert.deepEqual(Object.keys(план.stock).sort(), ["asOf", "back", "stale", "totalAfter", "totalBefore", "unmatched", "use"]);
  });
});
```
> Поля `summary` в фикстуре берутся из `PurchaseSummary` (`packages/shared/src/vending-calc.ts:239`) как есть; если набор там окажется другим, правится фикстура, а не тип — форму задаёт тот, кто считает числа.
```ts
// apps/cc/src/lib/core-types.test.ts — дописать
import type { PurchasePlan as SharedPlan, ShrinkReport as SharedShrink } from "@mydon/shared";
import type { VendingPlan, VendingShrinkageReport } from "./core";

describe("Усушка и план закупа — реэкспорт, а не копии (R-H-6)", () => {
  it("общая форма усушки принимается типом панели без переписывания полей", () => {
    // Панель звала усушку `VendingShrinkageReport`, Core — `ShrinkReport`, и
    // союз кодов панель переписала в другом порядке. Переименование поля в
    // Core компилятор не ловил: он видел две независимые структуры.
    const общая: SharedShrink = усушкаОбщая;
    const панельная: VendingShrinkageReport = общая;
    expect(панельная).toBe(общая);
  });

  it("общий план закупа принимается типом панели: PurchasePlan и VendingPlan — одно", () => {
    const общий: SharedPlan = планОбщий;
    const панельный: VendingPlan = общий;
    expect(панельный).toBe(общий);
  });
});
```
```ts
// apps/bot/src/core-client.test.ts — дописать в существующий набор
    const усушкаОбщая: SharedShrinkReport = { /* та же фикстура, что в contracts-тесте */ };
    const усушкаБота: ShrinkReport = усушкаОбщая;
    const планОбщий: SharedPurchasePlan = { /* та же фикстура */ };
    const планБота: VendingPlan = планОбщий;
    assert.equal(усушкаБота, усушкаОбщая);
    assert.equal(планБота, планОбщий);
```
- [x] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → RED (`ShrinkReport`/`PurchasePlan` в shared нет).
- [x] **Step 3: shared.** В `packages/shared/src/vending-reports.ts` — восемь объявлений из «Interfaces (produces)» С ПЕРЕНЕСЁННЫМИ ДОКБЛОКАМИ (докблоки — это единственное, что объясняет, почему `refillDays` живёт рядом с `summary` и почему `surplusUnits` в деньги не входит; переезд без них превратил бы формы в безымянные поля). Импорты в шапке файла: `import type { ShrinkItem, ShrinkSummary } from "./vending-field";`, `import type { SlotPlanRow } from "./vending-plan";`, `import type { PurchaseSummary } from "./vending-calc";` (файл уже импортирует из `./vending-calc`). Экспорт наружу уже обеспечен `export * from "./vending-reports"` (`index.ts:86`).
- [x] **Step 4: Core.** `shrinkage.service.ts`: пять объявлений (`:83-127`) → `import type { ShrinkMachine, ShrinkRefillDay, ShrinkReport, ShrinkWarning, ShrinkWarningCode } from "@mydon/shared";` + `export type { ShrinkMachine, ShrinkRefillDay, ShrinkReport, ShrinkWarning, ShrinkWarningCode };`. `vending.service.ts`: три объявления (`:499`, `:512`, `:531`) → тот же приём для `PlanMachine`, `PlanWarning`, `PurchasePlan`. Комментарий на месте реэкспорта: форму объявляет тот, кто считает числа; Core её импортирует и отдаёт своим модулям, чтобы внутренние импортёры не правились.
- [x] **Step 5: Бот.** `apps/bot/src/core-client.ts`: удалить локальные `VendingPlanSlot`/`VendingPlanMachine`/`VendingPlanWarning`/`VendingPlan` (`:205-263`) и `ShrinkItem`…`ShrinkReport` (`:274-341`); блок `export type { … } from "@mydon/shared"` (`:399-410`) пополнить одиннадцатью именами с `as`-алиасами по «Interfaces (produces)». Докблок блока уже говорит нужное («форму объявляет тот, кто считает числа») — дописать одну строку про усушку и план.
- [x] **Step 6: Панель.** `apps/cc/src/lib/core.ts`: удалить локальные `VendingPlan*` (`:160-224`) и `VendingShrinkage*` (`:227-306`); блок реэкспорта (`:308-325`) пополнить с алиасами, включая пять усушечных (`ShrinkItem as VendingShrinkageItem` и т. д.). Инлайненный `summary` исчезает вместе с копией — вызывающие не правятся.
- [x] **Step 7:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter bot build && pnpm -s typecheck && pnpm -s test` → GREEN. Отдельно убедиться, что дифф НЕ содержит правок вызывающих (`git diff --stat` показывает только пять файлов кода плюс три теста): любая правка листа или брифинга здесь означает, что алиас забыли.
- [x] **Step 8:** `git commit -m "refactor(shared,core,bot,cc): формы Shrink* и VendingPlan* объявлены один раз в @mydon/shared (хвосты, R-H-6)" -- packages/shared/src/vending-reports.ts packages/shared/src/vending-reports-contracts.test.ts apps/core/src/vending/shrinkage.service.ts apps/core/src/vending/vending.service.ts apps/bot/src/core-client.ts apps/bot/src/core-client.test.ts apps/cc/src/lib/core.ts apps/cc/src/lib/core-types.test.ts`

---

### Task 6: Впрыскиваемые часы у `detect` / `list` — повторный smoke перестаёт ронять детектор

**Files:** Modify `apps/core/src/vending/refill-events.service.ts` (`detect` стр. 111–114 и 217, `опубликоватьНесопоставленные` стр. 335–336, `list` стр. 391–393), `apps/core/src/vending/refill-events.service.test.ts` (фикстуры набора переводятся на фиксированные часы; новый сторож).

**Interfaces (produces):**
```ts
/** apps/core/src/vending/refill-events.service.ts */
/**
 * `now` — ПАРАМЕТР, а не `new Date()` внутри (R-H-7).
 *
 * Тот же довод, что у `VendingService.stockCounts` и `ShrinkageService.report`:
 * прогон, пересекающий полночь Ташкента, иначе считает окно от двух разных
 * дней. Плюс проверяемость: сегодня фикстуры детектора привязаны к стенным
 * часам, и повторный smoke на той же базе в течение часа роняет два шага —
 * нестабильный smoke приучают перезапускать, и он же однажды промолчит на
 * настоящей регрессии. Сигнатура аддитивна, цена правки — ноль.
 */
async detect(days = DETECT_DAYS_DEFAULT, now = new Date()): Promise<DetectResult>;
async list(days = LIST_DAYS_DEFAULT, now = new Date()): Promise<RefillEventRow[]>;
```

Что обязана делать реализация:
- `detect()`: `const сейчас = new Date()` (`:113`) удаляется, `от` считается от `now`, `now` уходит в `опубликоватьНесопоставленные(от, now, …)` (`:217`).
- `list()`: `new Date(Date.now() - …)` (`:393`) → `new Date(now.getTime() - окно * 86_400_000)`.
- Производные моменты остаются производными: `new Date(от.getTime() - MATCH_PAD_MS)` (`:238`, `:243`) и `const порог = new Date(сейчас.getTime() - MATCH_PAD_MS)` (`:336`) считаются от переданного момента и своих часов не берут.
- Суточные границы — только ташкентскими помощниками (`tashkentDay`, `tashkentDayStartOf`); второй копии смещения не заводить (R-FW-11).
- Контроллер НЕ правится: `this.refillEvents.detect(dto.days)` и `.list(dto.days)` остаются как есть — умолчание и есть «сейчас», как у `stockCounts` (`vending.controller.ts:592`).
- После правки в файле НЕТ ни одного `new Date()` / `Date.now()` вне значений параметров по умолчанию — это утверждает сторож по исходнику.

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/vending/refill-events.service.test.ts — перевести набор на фиксированные часы
/** Фиксированный момент прогона: раньше окна считались от стенных часов, и
 *  повторный smoke в течение часа ронял два шага. */
const СЕЙЧАС = new Date("2026-08-25T13:00:00+05:00");
const T1 = new Date("2026-08-25T04:00:00+05:00");

describe("Детектор считает от ПЕРЕДАННОГО момента (R-H-7)", () => {
  it("окно берётся от `now`, а не от часов процесса", async () => {
    const { svc, окна } = сервис({ snapshots: ЗАЛИВКА, entities: РЕЕСТР });
    await svc.detect(2, СЕЙЧАС);
    assert.equal(окна[0]!.getTime(), СЕЙЧАС.getTime() - 2 * 86_400_000);
  });

  it("повторный прогон с тем же `now` новых событий не даёт", async () => {
    // Идемпотентность проверяется ДЕТЕРМИНИРОВАННО, а не «пока не наступил
    // следующий час»: до правки второй прогон брал другое окно и мог дать
    // второе событие по той же заливке.
    const { svc, события } = сервис({ snapshots: ЗАЛИВКА, entities: РЕЕСТР });
    assert.equal((await svc.detect(2, СЕЙЧАС)).events, 1);
    assert.equal((await svc.detect(2, СЕЙЧАС)).events, 0);
    assert.equal(события.length, 1);
  });

  it("в ленту публикуются только окна старше MATCH_PAD_MS от переданного `now`", async () => {
    // Окно закрылось час назад — запись оператора ещё может появиться, и
    // строка «заливка без записи» была бы результатом гонки, а не фактом.
    const свежее = new Date(СЕЙЧАС.getTime() - 3_600_000);
    const { svc, лента } = сервис({ snapshots: заливкаК(свежее), entities: РЕЕСТР });
    await svc.detect(2, СЕЙЧАС);
    assert.deepEqual(лента.filter((f) => f.type === "vending.refill_detected"), []);
    // Тот же журнал, но момент сдвинут на четыре часа вперёд — окно старше
    // допуска, и факт «записи так и не появилось» уже утверждаем.
    const позже = new Date(СЕЙЧАС.getTime() + 4 * 3_600_000);
    await svc.detect(2, позже);
    assert.equal(лента.filter((f) => f.type === "vending.refill_detected").length, 1);
  });

  it("журнал читается от переданного момента: то же окно, что просили", async () => {
    const { svc, окна } = сервисЧтения({ events: ЖУРНАЛ });
    await svc.list(14, СЕЙЧАС);
    assert.equal(окна.at(-1)!.getTime(), СЕЙЧАС.getTime() - 14 * 86_400_000);
  });
});

// шапка файла: import { readFileSync } from "node:fs"; import path from "node:path";
describe("Сторож правила: часов внутри детектора нет (R-H-7)", () => {
  it("в refill-events.service.ts нет `new Date()`/`Date.now()` вне умолчаний параметров", () => {
    // Сторож по ИСХОДНИКУ: одно забытое `new Date()` в приватном помощнике
    // возвращает файл к стенным часам, и ни один поведенческий тест этого не
    // покажет — он просто снова станет флаки, а флаки-тест перезапускают.
    // Наборы Core гоняются ПО DIST (CommonJS): `import.meta.url` там нет, а
    // `__dirname` указывает в `apps/core/dist/vending` — исходник лежит на два
    // уровня выше, в `src/`.
    const код = readFileSync(path.resolve(__dirname, "../../src/vending/refill-events.service.ts"), "utf8");
    assert.equal(код.includes("Date.now()"), false, "Date.now() внутри сервиса запрещён");
    const часы = [...код.matchAll(/new Date\(\)/g)];
    // Разрешены ровно два вхождения — умолчания `now` у detect и list.
    assert.equal(часы.length, 2, "new Date() допустим только как умолчание параметра now");
    assert.match(код, /async detect\(days = DETECT_DAYS_DEFAULT, now = new Date\(\)\)/);
    assert.match(код, /async list\(days = LIST_DAYS_DEFAULT, now = new Date\(\)\)/);
  });
});
```
> `new Logger(RefillEventsService.name)` (`:95`) под регулярку `new Date\(\)` не попадает — сторож считает именно часы, а не конструкторы вообще.
- [x] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED (сторож видит `new Date()` в `detect` и `Date.now()` в `list`; тесты окна падают на стенных часах).
- [x] **Step 3: Правка сигнатур.** `detect(days = DETECT_DAYS_DEFAULT, now = new Date())`: удалить `const сейчас = new Date()`, `const от = new Date(now.getTime() - окно * 86_400_000)`, вызов `this.опубликоватьНесопоставленные(от, now, реестрМашин.nameBySerial)`. `list(days = LIST_DAYS_DEFAULT, now = new Date())`: `const от = new Date(now.getTime() - окно * 86_400_000)`. Докблоки обеих функций дополняются абзацем из «Interfaces (produces)» — ПОЧЕМУ параметр, теми же словами, что у `stockCounts`.
- [x] **Step 4:** `pnpm --filter core build && pnpm --filter core test` → GREEN. Дважды подряд на scratch-БД: `node tools/smoke-core.mjs` — три шага детектора (`:441`, `:458`, `:483`) зелёные оба раза, БЕЗ ожидания следующего часа. Эти три шага не правятся: они и есть проверка того, что впрыснутые часы ничего не сломали.
- [x] **Step 5:** `git commit -m "refactor(core): детектор заливок берёт момент параметром — повторный smoke перестал ронять шаги (хвосты, R-H-7)" -- apps/core/src/vending/refill-events.service.ts apps/core/src/vending/refill-events.service.test.ts`

---

### Task 7: Ретенция `vending_stock_count` — своим ключом, своим полом, по `dt` (**после мержа П8b**)

> **Предусловие.** П8b в `main`. Перед задачей: `git fetch && git rebase origin/main`, затем ПЕРЕЧИТАТЬ в дереве `apps/core/src/vending/retention.service.ts` (цели, `batchQuery`, бюджет, событие в `finally`) и `apps/core/src/system/config-spec.ts` (валидатор `atLeast`, блок `SNAPSHOT_RETENTION_DAYS`). Строки ниже — то, что видно в ветке `mydon-p8b` на момент написания плана; расхождение решается кодом в дереве, а не этим файлом.

**Files:** Modify `apps/core/src/system/config-spec.ts` (ключ рядом с `SNAPSHOT_RETENTION_DAYS`, стр. 313–323), `apps/core/src/system/config-spec.test.ts` (набор «Ключи катовера П8b», стр. 108–157); `apps/core/src/vending/retention.service.ts` (`RetentionTarget` стр. 38–44, `batchQuery` стр. 108–120, `sweep` стр. 133–160), `apps/core/src/vending/retention.service.test.ts` (стенд стр. 30–81, набор «Еженедельная ретенция», стр. 83+); `packages/db/src/schema.ts` (список индексов `vendingStockCount`, стр. 1593–1597); `docs/DATA_SOURCES.md` (абзац про `vending_stock_count`, стр. 961), `docs/PLAN_STOCK_ABSORPTION.md` (бэклог волны П8a, стр. 425–428). Create `packages/db/drizzle/0071_stock_count_retention_idx.sql` (+ снапшот drizzle через `db:generate`).

**Interfaces (consumes):** `RetentionService.sweep(now?)`, `RETENTION_BATCH = 5000`, `RETENTION_BUDGET_MS = 60_000`, `RETENTION_EVENT = "system.retention"`, крон `10 4 * * 0` с `timezone: TZ` — всё из П8b, без изменений механики; `readIntSetting`, `atLeast(min, hint)` (`config-spec.ts:81`), `tashkentDay` (`@mydon/shared`), `STOCK_COUNTS_DAYS_MAX = 730` (`vending.service.ts:144`).

**Interfaces (produces):**
```ts
/** apps/core/src/system/config-spec.ts — в CONFIG_SPECS сразу после SNAPSHOT_RETENTION_DAYS */
  {
    key: "STOCK_COUNT_RETENTION_DAYS",
    label: "Вендинг: хранить историю инвентаризаций склада, дней",
    kind: "number",
    fallback: "730",
    help:
      "Ниже 730 панель не примет: 730 — потолок окна у листа «История склада», " +
      "и всё, что уже нарезано, вернуть нечем. Увеличить можно.",
    // ПОЛ РАВЕН ДЕФОЛТУ: ключом можно только ПРОДЛИТЬ хранение, урезать — нельзя.
    validate: atLeast(730, "нужно не меньше 730 (окно чтения истории склада)"),
  },

/** apps/core/src/vending/retention.service.ts */
/** Порог, если `STOCK_COUNT_RETENTION_DAYS` не задан. Дублирует фолбэк `config-spec.ts`. */
export const STOCK_COUNT_RETENTION_DAYS_FALLBACK = 730;

interface RetentionTarget {
  table: PgTable;
  name: string;
  idCol: AnyPgColumn;
  ageCol: AnyPgColumn;
  olderThanDays: number;
  /**
   * Тип границы. `"date"` — колонка `date`, и граница уходит ГОЛЫМИ СУТКАМИ
   * `YYYY-MM-DD`: сравнение `date`-колонки с `timestamptz` Postgres приводит к
   * UTC-полуночи, то есть к 05:00 по Ташкенту — ровно та ошибка на пять часов,
   * которой стоил урок VendCash. Умолчание `"timestamp"`: поведение четырёх
   * существующих целей не меняется ни на байт.
   */
  cutoffAs?: "date" | "timestamp";
}
```

Что обязана делать реализация:
- **Пятая цель, а не пятый крон.** То же воскресенье 04:10 Ташкента, то же событие `system.retention` с `table: "vending_stock_count"`, те же пачки по 5000 под общим бюджетом 60 с, тот же `finally` с `capped`/`aborted`. Второй тип события про одну и ту же чистку заставил бы читателя гадать, какой из них полный (§7 спеки: новых событий и правил в срезе НЕТ).
- **Колонка возраста — `dt`, а не `counted_at`.** Читатель фильтрует именно `dt` (`vending.service.ts:1673-1678`), и резать по другой колонке значит давать гарантию «окно ретенции ≥ окна чтения» приблизительно, а не точно: строка с `dt` внутри окна чтения могла бы исчезнуть, и лист показал бы дырку без объяснения.
- **Пол 730 держится ДВАЖДЫ**: валидатором панели (`atLeast(730, …)`) и `Math.max(730, …)` в `sweep()` — база важнее env, но пол важнее обоих. Env валидатор панели не проходит вовсе, и без `Math.max` `STOCK_COUNT_RETENTION_DAYS=365` в `.env` срезал бы полтора года ручных инвентаризаций одним воскресеньем.
- **Ретенция на сегодняшних данных удалит 0 строк**: самая старая инвентаризация — `dt = 2025-08-17`, порог 730 суток, первые кандидаты появятся не раньше августа 2027. Это не повод считать шаг неработающим — это ожидаемый результат, записанный в чек-лист выкатки.
- Миграция 0071 — только индекс. Существующий `vending_stock_count_product_dt_idx (product_name, dt)` под условие `where dt < cutoff order by dt limit 5000` не годится: ведущая колонка не та.

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/system/config-spec.test.ts — новый набор
describe("Ключ ретенции истории склада (R-H-8)", () => {
  it("дефолт 730 и пол 730: ключом можно только ПРОДЛИТЬ хранение", () => {
    // 730 — ровно потолок `?days=` у /vending/stock-counts. Лист умеет
    // запросить два года, и всё, что он умеет запросить, обязано лежать в базе.
    assert.equal(specFor("STOCK_COUNT_RETENTION_DAYS")?.fallback, "730");
    assert.equal(validateConfig("STOCK_COUNT_RETENTION_DAYS", "730"), null);
    assert.equal(validateConfig("STOCK_COUNT_RETENTION_DAYS", "1095"), null);
    assert.equal(validateConfig("STOCK_COUNT_RETENTION_DAYS", "3650"), null);
    for (const мало of ["365", "729", "180", "0", "-1"]) {
      assert.match(
        validateConfig("STOCK_COUNT_RETENTION_DAYS", мало) ?? "",
        /не меньше 730/,
        `${мало}: настройка ниже окна чтения молча режет историю ПОД работающим листом`,
      );
    }
  });

  it("это ОТДЕЛЬНЫЙ ключ, а не второе имя SNAPSHOT_RETENTION_DAYS", () => {
    // Снимки (180) пересчитываются следующим сбором; инвентаризация склада —
    // ручной труд владельца, её не восстановить ничем.
    assert.notEqual(specFor("STOCK_COUNT_RETENTION_DAYS")?.fallback, specFor("SNAPSHOT_RETENTION_DAYS")?.fallback);
    assert.match(specFor("STOCK_COUNT_RETENTION_DAYS")?.help ?? "", /История склада|Увеличить можно/);
  });
});

// apps/core/src/vending/retention.service.test.ts — стенд: пятая таблица и настройка
  const ТАБЛИЦЫ = ["slot_snapshot", "product_sale", "machine_sale", "vending_sync_run", "vending_stock_count"];

describe("Ретенция истории склада (R-H-8)", () => {
  const вс = new Date("2026-09-06T04:10:00+05:00");

  it("чистит ПЯТЬ таблиц: к четырём добавилась vending_stock_count", async () => {
    const { svc, запросы } = стенд({
      строк: { slot_snapshot: 1, product_sale: 1, machine_sale: 1, vending_sync_run: 1, vending_stock_count: 1 },
    });
    const итог = await svc.sweep(вс);
    assert.deepEqual(итог.map((r) => r.table).sort(), [
      "machine_sale", "product_sale", "slot_snapshot", "vending_stock_count", "vending_sync_run",
    ]);
    // `event` и `raw_row` по-прежнему вне ретенции: журнал событий —
    // доказательная база (из него же считается серия паритета).
    assert.equal(запросы.filter((q) => /\bevent\b|\braw_row\b/.test(q)).length, 0);
  });

  it("граница истории склада по умолчанию — 730 суток, а не 180 снимков", async () => {
    const { svc } = стенд({ строк: { vending_stock_count: 1, slot_snapshot: 1 } });
    const итог = await svc.sweep(вс);
    assert.equal(итог.find((r) => r.table === "vending_stock_count")!.olderThanDays, 730);
    assert.equal(итог.find((r) => r.table === "slot_snapshot")!.olderThanDays, 180);
  });

  it("пол 730 держится и против env: панель отобьёт 365, окружение — нет, а Math.max — да", async () => {
    const { svc } = стенд({ строк: { vending_stock_count: 1 }, настройки: { STOCK_COUNT_RETENTION_DAYS: "365" } });
    assert.equal((await svc.sweep(вс))[0]!.olderThanDays, 730);
  });

  it("720 суток окно НЕ сужают, 1095 — расширяют: ключ умеет только продлить", async () => {
    const { svc: узкий } = стенд({ строк: { vending_stock_count: 1 }, настройки: { STOCK_COUNT_RETENTION_DAYS: "720" } });
    assert.equal((await узкий.sweep(вс))[0]!.olderThanDays, 730);
    const { svc: широкий } = стенд({ строк: { vending_stock_count: 1 }, настройки: { STOCK_COUNT_RETENTION_DAYS: "1095" } });
    assert.equal((await широкий.sweep(вс))[0]!.olderThanDays, 1095);
  });

  it("граница для vending_stock_count уходит ГОЛЫМИ СУТКАМИ, а не моментом", async () => {
    // `dt` — колонка типа `date`. Сравнение её с `timestamptz` Postgres
    // приводит к UTC-полуночи, то есть к 05:00 по Ташкенту: строки последних
    // пяти часов «того» дня срезались бы раньше срока (урок VendCash).
    const { svc, запросы } = стенд({ строк: { vending_stock_count: 1 } });
    await svc.sweep(вс);
    const q = запросы.find((x) => x.includes('"vending_stock_count"'))!;
    assert.match(q, /"2024-09-06"/, "граница обязана быть строкой YYYY-MM-DD");
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(q), false, "момента в параметрах быть не должно");
    // Четыре старые цели по-прежнему сравниваются моментом — их поведение не
    // менялось (`cutoffAs` по умолчанию "timestamp").
    const снимки = запросы.find((x) => x.includes('"slot_snapshot"'));
    assert.equal(снимки, undefined, "в этом прогоне снимков нет вовсе — цель не подмешалась");
  });

  it("удалять нечего — ни события, ни строки в результате: правило П8b новой целью не сломано", async () => {
    const { svc, события } = стенд({ строк: {} });
    assert.deepEqual(await svc.sweep(вс), []);
    assert.equal(события.length, 0);
  });
});
```
> Стенд уже умеет распознавать таблицу по тексту запроса и отдавать настройки — правится только список `ТАБЛИЦЫ` и фикстуры `строк`. `2024-09-06` = `2026-09-06` минус 730 суток по Ташкенту; при правке `вс` пересчитать.
- [x] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED (`specFor("STOCK_COUNT_RETENTION_DAYS")` = `undefined`; пятой цели нет).
- [x] **Step 3: Ключ настроек.** `config-spec.ts` — блок из «Interfaces (produces)» сразу после `SNAPSHOT_RETENTION_DAYS`. Комментарий над ним: пол здесь равен ДЕФОЛТУ и равен потолку `?days=` листа истории — это не «жёсткая настройка», а признание, что окно ретенции не бывает уже окна витрины; поставив пол 365, мы завели бы тумблер, которым владелец молча режет историю ПОД уже работающим листом (дословный урок R-FW-S8, где пол снапшотов подняли с 90 до 180).
- [x] **Step 4: Пятая цель.** `retention.service.ts`: импорт `vendingStockCount` из `@mydon/db` и `tashkentDay` из `@mydon/shared` (там уже берётся `TZ`); `STOCK_COUNT_RETENTION_DAYS_FALLBACK = 730`; `cutoffAs?: "date" | "timestamp"` в `RetentionTarget` с докблоком; `batchQuery` подставляет границу по типу:
```ts
  private batchQuery(t: RetentionTarget, cutoff: Date): SQL {
    // Голые сутки для `date`-колонок (R-H-8). `date < timestamptz` Postgres
    // приводит к UTC-полуночи = 05:00 Ташкента, и цель резала бы на пять часов
    // раньше срока — та самая ловушка, которой стоил урок VendCash.
    const граница = t.cutoffAs === "date" ? tashkentDay(cutoff) : cutoff;
    return sql`
      delete from ${t.table}
      where ${t.idCol} in (
        select ${t.idCol} from ${t.table}
        where ${t.ageCol} < ${граница}
        order by ${t.ageCol}
        limit ${sql.raw(String(RETENTION_BATCH))}
      )
    `;
  }
```
В `sweep(now)` — перед массивом целей:
```ts
    const stockCountDays = Math.max(
      // ПОЛ 730 = ДЕФОЛТ 730 (R-H-8). Ключ умеет только ПРОДЛИТЬ хранение: 730 —
      // потолок `?days=` у /vending/stock-counts, и окно ретенции уже него молча
      // режет данные ПОД уже работающим листом «История склада». Валидатор
      // панели такое отобьёт, env — нет, поэтому пол стоит и здесь.
      730,
      Math.trunc(
        await readIntSetting(this.db, "STOCK_COUNT_RETENTION_DAYS", STOCK_COUNT_RETENTION_DAYS_FALLBACK, this.logger),
      ),
    );
```
и пятым элементом `targets`:
```ts
      {
        table: vendingStockCount,
        name: "vending_stock_count",
        idCol: vendingStockCount.id,
        // `dt`, А НЕ `counted_at`: читатель фильтрует именно `dt`
        // (`vending.service.ts`), и резать по другой колонке значит давать
        // гарантию «окно ретенции ≥ окна чтения» приблизительно.
        ageCol: vendingStockCount.dt,
        olderThanDays: stockCountDays,
        cutoffAs: "date",
      },
```
Шапку сервиса дополнить: целей теперь пять, и у пятой ДРУГАЯ природа — не телеметрия, которая пересчитывается следующим сбором, а ручной труд владельца; отсюда и свой ключ, и пол, равный дефолту.
- [x] **Step 5: Индекс.** `packages/db/src/schema.ts`, в список индексов `vendingStockCount` (`:1593-1597`):
```ts
    // Под еженедельную ретенцию (R-H-8): составной
    // `vending_stock_count_product_dt_idx (product_name, dt)` для условия
    // `where dt < cutoff order by dt limit 5000` не годится — ведущая
    // колонка не та, и каждая пачка стоила бы полного скана с сортировкой.
    index("vending_stock_count_dt_idx").on(t.dt),
```
`packages/db/drizzle/0071_stock_count_retention_idx.sql`:
```sql
-- Индекс ПО `dt` под ретенцию истории склада (срез «Хвосты», R-H-8).
--
-- Зачем. `RetentionService` чистит пачками по 5000:
--   delete from vending_stock_count where id in (
--     select id from vending_stock_count where dt < cutoff order by dt limit 5000)
-- Существующий `vending_stock_count_product_dt_idx (product_name, dt)` под это
-- условие не годится: ведущая колонка — имя товара, то есть нужен seq scan
-- плюс сортировка НА КАЖДУЮ ПАЧКУ.
--
-- Почему НЕ `CREATE INDEX CONCURRENTLY`. Мигратор drizzle применяет файл в
-- транзакции, а CONCURRENTLY в транзакции запрещён — оператор упал бы и
-- ПОВЕСИЛ БЫ автодеплой молча и навсегда. 460 строк — блокировка доли секунды.
--
-- IF NOT EXISTS — защитный паттерн 0067/0069/0070: автодеплой применяет
-- миграции без отката, и каждый оператор обязан быть безопасен на повторе.

CREATE INDEX IF NOT EXISTS "vending_stock_count_dt_idx" ON "vending_stock_count" USING btree ("dt");
```
Снапшот drizzle обновить `pnpm --filter @mydon/db db:generate` — и проверить, что генератор не подтянул НИЧЕГО, кроме этого индекса.
- [x] **Step 6: Документация.** `docs/DATA_SOURCES.md`, к абзацу про `vending_stock_count` (`:961`) — дописать «сколько живёт история склада»: чистится еженедельно (воскресенье 04:10 Ташкента, событие `system.retention`), окно — `STOCK_COUNT_RETENTION_DAYS`, дефолт **730** и пол **730**; настройка умеет ТОЛЬКО ПРОДЛИТЬ хранение — урезать историю ниже окна чтения листа «История склада» нельзя ни из панели (валидатор), ни из env (`Math.max` в `sweep()`); на сегодняшних данных чистка удаляет 0 строк (самая старая `dt = 2025-08-17`). `docs/PLAN_STOCK_ABSORPTION.md`, бэклог волны П8a (`:425-428`): снять пункт «ретенция `vending_stock_count` (растёт без чистки)» — закрыт этим срезом; переформулировать пункт про уникальный индекс дедупа сторожа застоя — остаётся открытым осознанно (ценность ноль при одной реплике Core, R-FW-S7/R-H-1); пункт «`GET /vending/stock-counts` открыт без токена» ОСТАВИТЬ открытым — он уходит в П8 пп. 3–5 вместе с гашением `STOCK_DATABASE_URL` (R-H-1).
- [x] **Step 7:** `pnpm --filter @mydon/db build && pnpm --filter core build && pnpm --filter core test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `node packages/db/dist/migrate.js` дважды подряд — второй прогон no-op (`IF NOT EXISTS`); `pnpm --filter @mydon/db db:generate` → «No schema changes» после коммита снапшота.
- [x] **Step 8:** `git commit -m "feat(core,db): ретенция истории склада своим ключом STOCK_COUNT_RETENTION_DAYS и границей по dt (хвосты, R-H-8)" -- apps/core/src/system/config-spec.ts apps/core/src/system/config-spec.test.ts apps/core/src/vending/retention.service.ts apps/core/src/vending/retention.service.test.ts packages/db/src/schema.ts packages/db/drizzle docs/DATA_SOURCES.md docs/PLAN_STOCK_ABSORPTION.md`

---

### Task 8: Здоровье сбора в письме — за ОТЧЁТНУЮ неделю (**после мержа П8b**)

> **Предусловие.** П8b в `main`. Перед задачей: `git fetch && git rebase origin/main`, затем ПЕРЕЧИТАТЬ `apps/core/src/ourvend/sync-runs.ts` (`lastSuccessRunAt` — сегодня без окна), `packages/shared/src/parity-streak.ts` (поля дня — `день_ok`, `день_продаж_сверено`, `день_остатков_сверено`, `день_расхождений`; окно показа `PARITY_STREAK_WINDOW = 14`), `packages/shared/src/vending-reports.ts` (`OurvendHealth` уже с `snapshotStale`/`parityStreak`/`cutoverThreshold`, `WeeklyDigest.health`), `apps/core/src/vending/weekly-digest.service.ts` (`ЗДОРОВЬЕ_НЕИЗВЕСТНО`, `здоровьеСбора`, общий `Promise.all` в `сводка()`), `apps/bot/src/weekly-digest.ts:245` (`здоровье(h)`).

**Files:** Modify `packages/shared/src/vending-reports.ts` (`WeeklyHealth` рядом с `WeeklyDigest`, стр. 1126–1160), `packages/shared/src/vending-reports-contracts.test.ts`, `packages/shared/src/parity-streak.ts` (+`parity-streak.test.ts`); `apps/core/src/ourvend/sync-runs.ts` (`lastSuccessRunAt` стр. 47, новые `RunWindow`/`WEEK_RUNS_LIMIT`/`runsInWindow`); `apps/core/src/vending/sync-streak.ts` (+`sync-streak.test.ts`); `apps/core/src/vending/weekly-digest.service.ts` (`ЗДОРОВЬЕ_НЕИЗВЕСТНО` стр. 103, конструктор стр. 141–146, `сводка()` стр. 168–221, `здоровьеСбора` стр. 234) и `weekly-digest.service.test.ts` (стенд стр. 194–204); `apps/bot/src/core-client.ts` (блок реэкспорта), `apps/bot/src/weekly-digest.ts` (`здоровье()` стр. 245–262, вызов стр. 356) и `apps/bot/src/weekly-digest.test.ts` (фикстуры `ДАЙДЖЕСТ_34` стр. 18, `ПУСТАЯ_НЕДЕЛЯ` стр. 79); `tools/smoke-core.mjs` (шаг `/vending/weekly-digest`, стр. 196).

**Interfaces (consumes):** `parityStreak(events, threshold, today)` и `ParityDay` (`packages/shared/src/parity-streak.ts`), `OurvendParityService.streak(now?)` (`apps/core/src/ourvend/ourvend-parity.service.ts:583`), `failedStreak`/`SyncRunFacts` (`apps/core/src/vending/sync-streak.ts`), `IsoWeek`, `tashkentDayStart`, `ReportCache` — всё существующее.

**Interfaces (produces):**
```ts
/** packages/shared/src/parity-streak.ts */
/**
 * Дни серии, попавшие в ОДНУ НЕДЕЛЮ, — правило, а не фильтр по месту вызова.
 * Границы — голые ташкентские сутки: `from` (понедельник) включительно,
 * `to` (воскресенье) включительно; сравнение строк `YYYY-MM-DD` лексикографическое
 * и потому же календарное — второй арифметики дат здесь не заводим.
 */
export function parityDaysInWeek(days: readonly ParityDay[], from: string, to: string): ParityDay[];

/** packages/shared/src/vending-reports.ts */
/**
 * Здоровье сбора ЗА ОТЧЁТНУЮ НЕДЕЛЮ (R-H-9) — рядом с `health`, а не вместо.
 *
 * `OurvendHealth` отвечает на вопрос «как дела СЕЙЧАС»: `staleHours`,
 * `snapshotStale` и лаги про момент по построению, а `failedStreak` значит
 * «сколько подряд падает прямо сейчас». Подсунуть под эти имена недельные
 * числа — соврать под старой подписью; поэтому неделя едет своим полем.
 */
export interface WeeklyHealth {
  /** Та же ISO-неделя, что у письма (`IYYY-IW`) — подпись и числа обязаны совпадать. */
  week: string;
  /** Прогонов, НАЧАТЫХ в [понедельник, следующий понедельник). */
  runs: number;
  success: number;
  partial: number;
  failed: number;
  /** Самая длинная серия отказов ВНУТРИ недели. 0 — отказов не было. */
  worstFailedStreak: number;
  /** Последний успех НЕДЕЛИ (ISO). `null` — успехов в неделе не было ВОВСЕ (не «ноль часов»). */
  lastSuccessAt: string | null;
  /** Дни паритета недели, свежие сверху. Пустой — см. `warnings` письма. */
  parityDays: ParityDay[];
  parityGreen: number;
  parityRed: number;
}

export interface WeeklyDigest {
  /* … */
  health: OurvendHealth;    // СЕЙЧАС — не трогаем
  weekHealth: WeeklyHealth; // за отчётную неделю
  warnings: AnalyticsWarning[];
}

/** apps/core/src/ourvend/sync-runs.ts */
/** Полуинтервал `[from, to)` — окно недели. `lte` по концу воскресенья втянул бы полночь понедельника в ОБЕ недели. */
export interface RunWindow { from: Date; to: Date }
/** Прогонов больше, чем в неделе бывает, не читаем: 8 прогонов/сут × 7 + запас. */
export const WEEK_RUNS_LIMIT = 200;
/** Окно НЕОБЯЗАТЕЛЬНОЕ: вызывающие без него (OurvendHealthService, SyncStaleService) не правятся. */
export async function lastSuccessRunAt(db: Db, window?: RunWindow): Promise<Date | null>;
export async function runsInWindow(db: Db, window: RunWindow, limit?: number): Promise<SyncRunFacts[]>;

/** apps/core/src/vending/sync-streak.ts */
/**
 * САМАЯ ДЛИННАЯ серия отказов внутри набора — НЕ то же, что `failedStreak`.
 * `failedStreak` считает от свежего края и отвечает «падает ли сейчас»; здесь
 * вопрос другой — «была ли на неделе дыра и какой длины». `running`
 * пропускается, `partial`/`success` серию рвут — те же два решения, что у соседа.
 */
export function worstFailedStreak(runs: readonly SyncRunFacts[]): number;

/** apps/core/src/vending/weekly-digest.service.ts */
/** Пара к `ЗДОРОВЬЕ_НЕИЗВЕСТНО`: «не посчитали» ≠ «всё хорошо». */
const НЕДЕЛЯ_НЕИЗВЕСТНА: (week: string) => WeeklyHealth;
private здоровьеНедели(
  неделя: IsoWeek, начало: Date, конец: Date, now: Date,
): Promise<{ health: WeeklyHealth; warning: AnalyticsWarning | null }>;
```

Что обязана делать реализация:
- **Аддитивно.** `health` остаётся тем, чем было. `weekHealth` считается по окну `[понедельник недели, понедельник следующей)` — теми же `начало`/`конец`, которые `сводка()` уже вычислила (`weekly-digest.service.ts:174-175`).
- `runsInWindow`: `where startedAt >= window.from and startedAt < window.to`, `order by startedAt desc`, `limit`. Полуинтервал обязателен: `lte` по концу воскресенья втянул бы полночь понедельника в обе недели, и один прогон посчитался бы дважды.
- `lastSuccessRunAt(db, window?)`: без окна ведёт себя ровно как раньше (`OurvendHealthService`, `SyncStaleService` НЕ правятся); с окном добавляет те же две границы. Успех датируется ЗАВЕРШЕНИЕМ (`finishedAt ?? startedAt`) — правило не трогаем.
- `worstFailedStreak`: сортирует вход сам (тот же приём, что `failedStreak`), `running` пропускает, `partial`/`success` рвут серию, возвращает МАКСИМУМ длин, а не последнюю.
- Дни паритета: `(await this.parity.streak(now)).days` → `parityDaysInWeek(дни, неделя.from, неделя.to)`. Второго разбора payload не заводим — поля дня уже разбирает `parity-streak.ts`.
- **Граница окна показа.** `parityStreak.days` обрезан `PARITY_STREAK_WINDOW = 14`. Понедельничное письмо всегда попадает внутрь, а `?week=` глубже двух недель — нет: тогда `parityDays` пуст И в `warnings` уезжает `{ code: "health_unavailable", message: "Дни паритета за эту неделю вне окна счёта серии (14 дней) — смотри /ourvend/parity/streak" }`. Молчаливый пустой список читался бы как «сверки не было».
- Свой `catch`: отказ спутника не роняет письмо — деньги недели от него не зависят (тот же приём, что у `здоровьеСбора`). При отказе — `НЕДЕЛЯ_НЕИЗВЕСТНА(неделя.key)` (нули, `lastSuccessAt: null`, пустые `parityDays`) плюс `health_unavailable` с причиной.
- Кеш — СУЩЕСТВУЮЩИЙ ключ `weekly-digest|<неделя>|<ташкентские сутки>`; второго кеша нет, оба вызова идут в том же `Promise.all`.
- Бот: `здоровье(h: OurvendHealth)` → `здоровье(d: WeeklyDigest)`; печатает СНАЧАЛА числа недели, потом прежние строки «сейчас», подписанные словом «сейчас». `строкаЗастоя` и `строкаСнапшота` НЕ МЕНЯЮТСЯ ВОВСЕ — те же общие форматтеры `analytics-brief.ts`, что и в «сверке». Пустая неделя (`runs === 0`) печатает «За неделю прогонов не было — сбор не запускался», а не «отказов 0».

- [x] **Step 1: Тесты RED.**
```ts
// packages/shared/src/parity-streak.test.ts — дописать
import { PARITY_STREAK_WINDOW, parityDaysInWeek, parityStreak, type ParityEventRow } from "./parity-streak";

describe("Дни серии, попавшие в неделю (R-H-9)", () => {
  const день = (date: string): ParityDay => ({ date, ok: true, salesChecked: 14, stockChecked: 68, note: null });

  it("понедельник входит, воскресенье ПРЕДЫДУЩЕЙ недели — нет", () => {
    const дни = ["2026-08-24", "2026-08-23", "2026-08-17"].map(день);
    // Неделя 2026-34: пн 17.08 — вс 23.08.
    assert.deepEqual(parityDaysInWeek(дни, "2026-08-17", "2026-08-23").map((d) => d.date), ["2026-08-23", "2026-08-17"]);
  });

  it("воскресенье СВОЕЙ недели входит: граница закрыта справа голыми сутками", () => {
    assert.equal(parityDaysInWeek([день("2026-08-23")], "2026-08-17", "2026-08-23").length, 1);
  });

  it("неделя вне окна показа даёт ПУСТО — и это повод для предупреждения, а не тишины", () => {
    // `days` обрезан 14 сутками: `?week=` глубже двух недель дней просто не
    // имеет, и молчаливый пустой список читался бы как «сверки не было».
    const дни = Array.from({ length: PARITY_STREAK_WINDOW }, (_, i) => день(`2026-08-${String(25 - i).padStart(2, "0")}`));
    assert.deepEqual(parityDaysInWeek(дни, "2026-07-06", "2026-07-12"), []);
  });
});

// apps/core/src/vending/sync-streak.test.ts — дописать
import { failedStreak, worstFailedStreak, type SyncRunFacts } from "./sync-streak";

describe("Худшая серия отказов ВНУТРИ набора (R-H-9)", () => {
  it("берёт самую длинную серию, а не последнюю", () => {
    // «Падает ли сейчас» и «была ли на неделе дыра» — разные вопросы: у одного
    // и того же набора `failedStreak` даёт 1, а худшая серия недели — 3.
    const прогоны = [
      ОТКАЗ("2026-08-23T04:00:00Z"),
      УСПЕХ("2026-08-22T04:00:00Z"),
      ОТКАЗ("2026-08-21T22:00:00Z"),
      ОТКАЗ("2026-08-21T16:00:00Z"),
      ОТКАЗ("2026-08-21T10:00:00Z"),
      УСПЕХ("2026-08-20T04:00:00Z"),
    ];
    assert.equal(worstFailedStreak(прогоны), 3);
    assert.equal(failedStreak(прогоны).streak, 1, "сосед по-прежнему отвечает на свой вопрос");
  });

  it("running серию не рвёт, partial рвёт — те же два решения, что у failedStreak", () => {
    assert.equal(
      worstFailedStreak([ОТКАЗ("2026-08-21T22:00:00Z"), прогон("running", "2026-08-21T16:00:00Z"), ОТКАЗ("2026-08-21T10:00:00Z")]),
      2,
    );
    assert.equal(
      worstFailedStreak([ОТКАЗ("2026-08-21T22:00:00Z"), прогон("partial", "2026-08-21T16:00:00Z"), ОТКАЗ("2026-08-21T10:00:00Z")]),
      1,
    );
  });

  it("отказов не было — ноль, и это не «не считали»", () => {
    assert.equal(worstFailedStreak([УСПЕХ("2026-08-21T22:00:00Z")]), 0);
    assert.equal(worstFailedStreak([]), 0);
  });
});

// apps/core/src/vending/weekly-digest.service.test.ts — новый набор
describe("Здоровье сбора в письме — за ОТЧЁТНУЮ неделю (R-H-9)", () => {
  it("прогоны считаются по окну [понедельник, следующий понедельник)", async () => {
    // Полуинтервал: прогон в полночь понедельника СЛЕДУЮЩЕЙ недели в неделю
    // НЕ входит — иначе он посчитался бы в обеих.
    const d = await сервис({
      runs: [
        прогонСтрокой("success", "2026-08-17T00:00:00+05:00"),
        прогонСтрокой("failed", "2026-08-23T23:00:00+05:00"),
        прогонСтрокой("success", "2026-08-24T00:00:00+05:00"),
      ],
    }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.weekHealth.runs, d.weekHealth.success, d.weekHealth.failed], [2, 1, 1]);
    assert.equal(d.weekHealth.week, "2026-34");
  });

  it("авария ТЕКУЩЕЙ недели не попадает в письмо о ПРОШЛОЙ — регресс на дефект O7", async () => {
    // Письмо про 2026-34 уходит в понедельник 35-й. До правки блок здоровья
    // был подписан неделей, а числа брал моментом отправки, и владелец искал
    // аварию в логах не того дня.
    const d = await сервис({
      runs: [
        прогонСтрокой("success", "2026-08-20T04:00:00+05:00"),
        прогонСтрокой("failed", "2026-08-25T04:00:00+05:00"),
        прогонСтрокой("failed", "2026-08-25T07:00:00+05:00"),
      ],
      health: { ...ЗДОРОВЬЕ, failedStreak: 2 },
    }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.weekHealth.failed, d.weekHealth.worstFailedStreak], [0, 0]);
    assert.equal(d.health.failedStreak, 2, "«сейчас» осталось «сейчас» — два разных набора чисел в одном ответе");
  });

  it("последний успех НЕДЕЛИ, а не вообще: null — успехов в неделе не было ВОВСЕ", async () => {
    const d = await сервис({ runs: [прогонСтрокой("failed", "2026-08-20T04:00:00+05:00")] }).digest("2026-34", СЕЙЧАС);
    assert.equal(d.weekHealth.lastSuccessAt, null);
    assert.equal(d.weekHealth.runs, 1, "прогон был — просто неуспешный; это не «сбор не запускался»");
  });

  it("дни паритета режутся неделей и считаются зелёными/красными", async () => {
    const d = await сервис({ parityDays: [ДЕНЬ_ЗЕЛ("2026-08-22"), ДЕНЬ_КРАС("2026-08-21"), ДЕНЬ_ЗЕЛ("2026-08-25")] })
      .digest("2026-34", СЕЙЧАС);
    assert.deepEqual(d.weekHealth.parityDays.map((x) => x.date), ["2026-08-22", "2026-08-21"]);
    assert.deepEqual([d.weekHealth.parityGreen, d.weekHealth.parityRed], [1, 1]);
  });

  it("неделя вне окна счёта серии: parityDays пуст И в warnings есть health_unavailable", async () => {
    const d = await сервис({ parityDays: [ДЕНЬ_ЗЕЛ("2026-08-25")] }).digest("2026-28", СЕЙЧАС);
    assert.deepEqual(d.weekHealth.parityDays, []);
    assert.ok(
      d.warnings.some((w) => w.code === "health_unavailable" && /вне окна счёта серии/.test(w.message)),
      "молчаливый пустой список читается как «сверки не было»",
    );
  });

  it("падение недельного здоровья не роняет письмо: деньги недели на месте, причина в warnings", async () => {
    const d = await сервис({ неделяПадает: true }).digest("2026-34", СЕЙЧАС);
    assert.ok(d.totals.revenue > 0, "деньги недели от секции здоровья не зависят");
    assert.deepEqual([d.weekHealth.runs, d.weekHealth.lastSuccessAt], [0, null]);
    assert.ok(d.warnings.some((w) => w.code === "health_unavailable"));
  });
});

// apps/bot/src/weekly-digest.test.ts — дописать
describe("Блок здоровья: сначала неделя, потом «сейчас» (R-H-9)", () => {
  it("печатает недельные числа и отдельно строки момента", () => {
    const текст = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).join("\n");
    assert.match(текст, /За неделю: прогонов 56 · успешных 54 · частичных 1 · отказов 1 · худшая серия 1/);
    assert.match(текст, /Паритет недели: 5 зелёных \/ 2 красных/);
    assert.match(текст, /Сейчас: /, "состояние момента обязано быть ПОДПИСАНО словом «сейчас»");
  });

  it("неделя без прогонов — «сбор не запускался», а не «отказов 0»", () => {
    const текст = formatWeeklyDigest(ПУСТАЯ_НЕДЕЛЯ, []).join("\n");
    assert.match(текст, /За неделю прогонов не было — сбор не запускался/);
    assert.equal(/отказов 0/.test(текст), false, "нули читаются как посчитанный результат");
  });

  it("строка застоя и строка снапшота не изменились: два отчёта об одних числах говорят одно", () => {
    const h = { ...ДАЙДЖЕСТ_34.health, staleHours: 9, staleThresholdH: 6 };
    const текст = formatWeeklyDigest({ ...ДАЙДЖЕСТ_34, health: h }, []).join("\n");
    assert.ok(текст.includes(строкаЗастоя(h)!), "письмо обязано печатать ТОТ ЖЕ форматтер, что «сверка»");
  });
});
```
> Фикстуры `ДАЙДЖЕСТ_34` и `ПУСТАЯ_НЕДЕЛЯ` (`weekly-digest.test.ts:18`, `:79`) получают `weekHealth`: у первой — `{ week: "2026-34", runs: 56, success: 54, partial: 1, failed: 1, worstFailedStreak: 1, lastSuccessAt: "2026-08-23T03:07:00Z", parityDays: [...5 зелёных, 2 красных], parityGreen: 5, parityRed: 2 }`, у второй — нули, `lastSuccessAt: null`, пустые `parityDays`.
- [x] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test && pnpm --filter bot test` → RED (`parityDaysInWeek` и `worstFailedStreak` не существуют; `weekHealth` нет в типе).
- [x] **Step 3: shared.** `parity-streak.ts`: `parityDaysInWeek` по интерфейсу выше (`days.filter((d) => d.date >= from && d.date <= to)`) с докблоком — почему сравнение строк, а не арифметика дат: `YYYY-MM-DD` лексикографически совпадает с календарным порядком, и вторая арифметика дат в файле, где уже живёт `предыдущийДень`, была бы вторым правилом. `vending-reports.ts`: `WeeklyHealth` и `weekHealth` в `WeeklyDigest` по «Interfaces (produces)»; импорт `import type { ParityDay } from "./parity-streak";` (цикла нет — `parity-streak.ts` из `vending-reports.ts` ничего не тянет).
- [x] **Step 4: Окно прогонов.** `sync-runs.ts`: `RunWindow`, `WEEK_RUNS_LIMIT = 200`, необязательный `window` у `lastSuccessRunAt` и новая `runsInWindow`. Шапка модуля дополняется: вопросов теперь не пять, а шесть, и шестой — «что было в ЭТОЙ неделе»; своя копия запроса у письма разошлась бы с отчётом ровно на том уточнении, что успех датируется завершением прогона. Комментарий у `RunWindow`: полуинтервал `[from, to)`, потому что `lte` по концу воскресенья втянул бы полночь понедельника в обе недели.
- [x] **Step 5: Худшая серия.** `sync-streak.ts`: `worstFailedStreak` с докблоком из «Interfaces (produces)» — рядом с `failedStreak`, тем же приёмом «сортируем вход сами».
- [x] **Step 6: Сводка.** `weekly-digest.service.ts`: четвёртый аргумент конструктора `private readonly parity: OurvendParityService` (провайдер уже есть в `VendingModule`, правки модуля не нужно); `НЕДЕЛЯ_НЕИЗВЕСТНА(week)` рядом с `ЗДОРОВЬЕ_НЕИЗВЕСТНО` с тем же комментарием «не посчитали ≠ всё хорошо»; `здоровьеНедели(неделя, начало, конец, now)` под своим `catch`; оба вызова в существующем `Promise.all` (`const [текущая, предыдущая, мёртвый, цены, здоровье, недельное, работа] = await Promise.all([…])`); в ответе — `weekHealth: недельное.health`, а `warnings` собирает предупреждения ОБЕИХ секций: `[здоровье.warning, недельное.warning].filter((w): w is AnalyticsWarning => w !== null)`. Кеш — тот же ключ.
- [x] **Step 7: Бот.** `core-client.ts`: `WeeklyHealth` в блок реэкспорта из `@mydon/shared`. `weekly-digest.ts`: `здоровье(d: WeeklyDigest)`:
```ts
function здоровье(d: WeeklyDigest): string[] {
  const h = d.health;
  const w = d.weekHealth;
  const прогоны = прогоныСтрока(h.runs);
  const застой = строкаЗастоя(h);
  const снапшот = строкаСнапшота(h);
  return [
    "",
    "🩺 Здоровье сбора OurVend",
    // ЧИСЛА НЕДЕЛИ ПЕРВЫМИ: письмо подписано неделей, и первым в блоке обязано
    // стоять то, о чём подпись. Пустая неделя — не «отказов 0»: нули читаются
    // как посчитанный результат, а сбор чаще всего просто не запускался.
    w.runs === 0
      ? "За неделю прогонов не было — сбор не запускался"
      : `За неделю: прогонов ${RU(w.runs)} · успешных ${RU(w.success)} · частичных ${RU(w.partial)} · ` +
        `отказов ${RU(w.failed)} · худшая серия ${RU(w.worstFailedStreak)}`,
    ...(w.parityDays.length === 0
      ? []
      : [`Паритет недели: ${RU(w.parityGreen)} зелёных / ${RU(w.parityRed)} красных`]),
    `Последний успех недели: ${момент(w.lastSuccessAt)}`,
    // Дальше — СОСТОЯНИЕ МОМЕНТА, подписанное словом «сейчас». Строки застоя и
    // снапшота не меняются вовсе: это те же общие форматтеры, что печатает
    // «сверка», и вторая формулировка одного сигнала разошлась бы там, где
    // владелец меньше всего этого ждёт — в письме, которое приходит само.
    ...(застой ? [`Сейчас: ${застой}`] : []),
    ...(снапшот ? [`Сейчас: ${снапшот}`] : []),
    `Сейчас: ${состояниеСбора(h)} · последний успех ${момент(h.lastSuccessAt)}`,
    ...(прогоны ? [прогоны] : []),
    свежестьСтрока(h),
    паритетСтрока(h.parity),
    строкаСерии(h),
  ];
}
```
Вызов на `:356` — `lines.push(...здоровье(d));`. Блок вырастает на две строки — это входит в бюджет частей (`WEEKLY_MAX_PARTS`, `capped`), и `формат` их уже режет.
- [x] **Step 8: Смоук.** В `tools/smoke-core.mjs`, шаг `/vending/weekly-digest` (`:196`) дополнить:
```js
      const w = о?.weekHealth;
      if (!w) throw new Error("в сводке нет weekHealth — письмо снова говорило бы про момент отправки");
      if (w.week !== о.week) throw new Error(`weekHealth.week=${w.week}, а письмо про ${о.week}`);
      for (const k of ["runs", "success", "partial", "failed", "worstFailedStreak", "parityGreen", "parityRed"]) {
        if (typeof w[k] !== "number") throw new Error(`weekHealth.${k} — не число`);
      }
      if (!Array.isArray(w.parityDays)) throw new Error("weekHealth.parityDays — не массив");
      // `null` — «успехов в неделе не было ВОВСЕ», и это не ноль часов.
      if (w.lastSuccessAt !== null && typeof w.lastSuccessAt !== "string") throw new Error("weekHealth.lastSuccessAt — не ISO и не null");
      if (typeof о?.health?.failedStreak !== "number") throw new Error("health «сейчас» пропал из сводки");
```
- [x] **Step 9:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test && pnpm --filter bot build && pnpm --filter bot test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `node tools/smoke-core.mjs`.
- [x] **Step 10: Аддендум спеки.** В конец `docs/superpowers/specs/2026-08-26-hvosty-snek-design.md` — раздел «Аддендум после реализации» с ПЯТЬЮ отклонениями из шапки этого плана (`StockCountsReport.since`; форма сторожа снек-форматтеров; `parityDaysInWeek` в shared; четвёртый аргумент конструктора `WeeklyDigestService`; поправленная ссылка на «место донора» в `note`) — каждое одним абзацем: что в спеке, что в коде, почему.
- [x] **Step 11:** `git commit -m "feat(core,bot,shared): здоровье сбора в письме считается за отчётную неделю, а не на момент отправки (хвосты, R-H-9)" -- packages/shared/src/vending-reports.ts packages/shared/src/vending-reports-contracts.test.ts packages/shared/src/parity-streak.ts packages/shared/src/parity-streak.test.ts apps/core/src/ourvend/sync-runs.ts apps/core/src/vending/sync-streak.ts apps/core/src/vending/sync-streak.test.ts apps/core/src/vending/weekly-digest.service.ts apps/core/src/vending/weekly-digest.service.test.ts apps/bot/src/core-client.ts apps/bot/src/weekly-digest.ts apps/bot/src/weekly-digest.test.ts tools/smoke-core.mjs docs/superpowers/specs/2026-08-26-hvosty-snek-design.md docs/superpowers/plans/2026-08-26-sloy-hvosty-snek.md`

---

## Выкатка (спека §9)

> **Из задач плана прод НЕ пишется ни разу.** Единственная запись среза — шаг 4 ниже, прогон бэкфилла `--apply`; его делает владелец после мержа и деплоя, руками, по `docs/DEPLOY.md`. Донор (`mydon-stock`) не пишется ни здесь, ни там.

**Предусловие:** П8b смёржен в `main`, задачи 7 и 8 написаны ПОВЕРХ его кода (перечитаны в дереве, а не по цитатам плана).

1. **Ветка и PR.** `feat/hvosty-snek` от свежего `main`. После `git checkout main` ПЕРВОЙ командой — `git checkout -b`: фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты. PR → CI зелёный (lint · typecheck · build · test · миграции на живом Postgres · шаг `backfill-product-ids.js` без флагов · smoke-import · smoke-core · smoke-panel) → adversarial-ревью → squash-мерж.
2. **Полный прогон перед PR:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`; smoke на scratch-БД целиком: `createdb mydon_hvosty` → `node packages/db/dist/migrate.js` → `seed.js` → `seed-vending.js` → `backfill-product-ids.js` → `SMOKE_SCRATCH=1 node tools/smoke-import.mjs` → `node tools/smoke-core.mjs` → `node tools/smoke-panel.mjs` → `dropdb mydon_hvosty`. Отдельно: `pnpm --filter @mydon/db db:generate` → «No schema changes» (снапшот 0071 обязан быть уже в коммите).
3. **Деплой и сверка того, что выкачено ИМЕННО это.** `GET /health` → `commit` совпадает с коммитом мержа: каталог обновляется за секунды, образ собирается минуты. Миграция 0071 применяется автодеплоем; повторный прогон мигратора — no-op (`IF NOT EXISTS`).
4. **ЕДИНСТВЕННАЯ ЗАПИСЬ В ПРОД (R-H-4) — шаг владельца.** Сначала примерка, потом запись, тем же паттерном разового скрипта, что в `docs/DEPLOY.md`:
   ```bash
   docker exec -i mydon-core node packages/db/dist/backfill-product-ids.js --dry-run </dev/null
   docker exec -i mydon-core node packages/db/dist/backfill-product-ids.js --apply   </dev/null
   ```
   Ожидание: `vending_stock` и `machine_slot` — **0** новых привязок (уже прогонялись); `vending_refill` и `vending_stock_count` — привязки по тем именам, которым владелец успел завести карточки; **11 имён без карточки остаются `NULL`** и печатаются списком. **Ноль привязок — законный результат**, если карточек ещё нет: это не повод считать шаг проваленным. `</dev/null` обязателен: без него остаток скрипта уходит в контейнер и шаги после молча не выполняются (`DEPLOY.md:120`).
5. **Проверка витрин — только чтение:**
   - `GET /vending/stock-counts?days=730` → **460** строк, у каждой есть ключ `note`, в ответе есть `since` голыми сутками;
   - панель «Отчёты → **История склада**» → 460 импортированных строк, сгруппированы по датам и пометкам; у импортированных подпись «место», у своих — «кто считал»;
   - панель «Отчёты → **Журнал заливок**», окно 90 дн. → события детектора; `GET /vending/refill-events?days=90` отдаёт 90-суточное окно, `days=91` → **400**;
   - панель «Отчёты → Усушка», «План закупа», «Журнал продаж», «Приход» и «Полевая работа → Снек» → сумма копируется и находится `Ctrl+F` по странице (нет U+00A0);
   - `GET /vending/weekly-digest` → есть и `health` (момент), и `weekHealth` (неделя), `weekHealth.week` совпадает с `week` письма;
   - `GET /system/config` → тумблер `STOCK_COUNT_RETENTION_DAYS` виден, `value: "730"`, `source: "default"`; попытка сохранить `365` из панели — отказ валидатора с текстом «нужно не меньше 730».
6. **Отложенная проверка ретенции — ближайший понедельник.** События `system.retention` за воскресенье 04:10: записи `vending_stock_count` быть **НЕ должно**. Удалять на сегодняшних данных нечего: самая старая строка `dt = 2025-08-17` при пороге 730, первые кандидаты появятся не раньше августа 2027. Запись раньше срока = граница считается не по `dt` либо порог тронули в обход валидатора (опустить его ниже 730 панель не даёт, `Math.max` в `sweep()` — тоже).
7. **Отложенная проверка письма — следующий понедельник 08:05.** Блок здоровья говорит «За неделю…» с числами недели и отдельно «Сейчас…». Если на неделе была авария, а сейчас всё хорошо, в письме обязаны быть ОБЕ строки — это и есть приёмка дефекта O7.
8. **Память и план.** `docs/PLAN_STOCK_ABSORPTION.md` правится ВНУТРИ T7 (это правка репозитория, а не прод): снят пункт бэклога про ретенцию `vending_stock_count`, переформулирован пункт про уникальный индекс дедупа сторожа (остаётся открытым осознанно, R-FW-S7), пункт про read-token оставлен открытым для П8 пп. 3–5. Отдельного шага выкатки здесь нет — к моменту мержа он уже в коммите.

## Самопроверка плана

**Покрытие рулингов спеки:**

| Рулинг | Где закрыт | Чем проверен |
|---|---|---|
| R-H-1 охват — ровно восемь задач, O9/O10/O11 вне | Global Constraints; T4 (троттл роута не заводим), T7 Step 6 (бэклог переформулирован, read-token оставлен) | ревью: восемь задач в порядке описи, ни одного файла агентов/`docker-compose`/`.env.example` в дифф-списках; `PLAN_STOCK_ABSORPTION.md` сохраняет пункты O10/O11 открытыми |
| R-H-2 история склада на существующем роуте, `note` по источнику | T1 (`note`+`since` в Core, лист, навигация, доки) | T1 «в строке едет `note`», «`since` — первые сутки окна»; панель: «сутки свежими сверху», «сортируются ЯВНО», «пометка импортированной подписана «место», своей — «кто считал»», «пустая история — третье состояние», «`stock_missing` покрыт, `history_capped` нет»; смоук `/vending/stock-counts?days=90` (ключ `note`, формат `since`), smoke-panel «Пересчёты склада» |
| R-H-3 числа снек-листов без U+00A0, `money()` не трогаем | T2 (докблок `money()`, пять листов, два теста) | `format.test.ts` «count/amount не содержат U+00A0», «money() U+00A0 СОХРАНЯЕТ», «amount = money без NBSP»; `snack-format.test.tsx` по исходнику на пять файлов; тесты байта в `shrinkage-view.test.tsx` и `purchase-plan-view.test.tsx` |
| R-H-4 бэкфилл на заливки и инвентаризации, флаги | T3 (`BACKFILL_TARGETS`, `dryRun`, отказ на совмещении, `DEPLOY.md`) | T3 «цели — ровно четыре», «имя заливки и строки истории резолвятся тем же правилом», «`--dry-run` не зовёт update», «имя без карточки остаётся NULL», «предикат `product_id IS NULL` у всех четырёх»; CI-шаг без флагов остаётся записью; выкатка §4 |
| R-H-5 лист журнала + свой потолок чтения 90 | T4 (`LIST_DAYS_MAX`, DTO, лист, навигация) | T4 «`?days=90` читается целиком», «`?days=91` зажимается до 90, а не до 30», DTO «90 законно / 91 отказ / 30 не особая граница»; панель «только снимки / снимки + запись», «карточки автомата нет», «пустой журнал — не привозили»; смоук `/vending/refill-events?days=90`, smoke-panel «Журнал заливок» |
| R-H-6 формы `Shrink*`/`VendingPlan*` в shared, ноль изменений поведения | T5 (восемь форм в `vending-reports.ts`, реэкспорты с `as`) | контракты «`ShrinkReport`: ровно те поля», «союз кодов объявлен один раз» (+`@ts-expect-error` на лишний литерал), «`PurchasePlan`: ровно те поля»; компиляторные сверки `core-types.test.ts` и `core-client.test.ts`; T5 Step 7 — `git diff --stat` не показывает правок вызывающих |
| R-H-7 впрыскиваемые часы `detect`/`list` | T6 (сигнатуры, протяжка `now`, сторож) | T6 «окно от переданного `now`», «повтор с тем же `now` — 0 новых событий», «публикация только окон старше `MATCH_PAD_MS`», «журнал читается от `now`»; сторож по исходнику «ровно два `new Date()`, оба — умолчания»; двойной прогон `smoke-core.mjs` подряд |
| R-H-8 ретенция своим ключом, пол 730, граница по `dt` | T7 (ключ, пятая цель, `cutoffAs`, индекс 0071, доки) | `config-spec.test.ts` «дефолт 730 и пол 730», «отдельный ключ, а не второе имя»; `retention.service.test.ts` «пять таблиц», «граница по умолчанию 730 против 180 снимков», «пол против env», «720 не сужает, 1095 расширяет», «граница голыми сутками», «удалено 0 — ни события»; выкатка §6 (записи в понедельник быть не должно) |
| R-H-9 здоровье письма за отчётную неделю | T8 (`WeeklyHealth`, `runsInWindow`, `worstFailedStreak`, `parityDaysInWeek`, бот) | shared «понедельник входит, воскресенье предыдущей — нет», «неделя вне окна показа даёт пусто»; `sync-streak.test.ts` «худшая, а не последняя», «running не рвёт, partial рвёт»; сводка «окно [пн, пн)», «авария ТЕКУЩЕЙ недели не попадает в письмо о прошлой», «последний успех НЕДЕЛИ», «дни режутся неделей», «вне окна — пусто И `health_unavailable`», «падение не роняет письмо»; бот «сначала неделя, потом «сейчас»», «пустая неделя — «сбор не запускался»», «строка застоя не изменилась»; смоук `/vending/weekly-digest` |
| §6 данные и миграции | T7 Step 5 | одна миграция 0071 (только индекс); схема больше не меняется — `note`, `vending_refill.product_id`, `vending_stock_count.product_id` уже существуют; `db:generate` → «No schema changes» (выкатка §2) |
| §7 события и правила — новых НЕТ | T7 (`system.retention` переиспользуется), T8 (меняется текст письма, не сигналы) | `retention.service.test.ts` «событие с таблицей, числом и границей» (тип прежний); в диффе нет правок `apps/core/src/rules/rules.ts` и `RULE_EVENT_TYPES` |
| §4 общие ограничения (время, настройки, троттлы, ноль ≠ хорошо) | Global Constraints; T1·T4·T6·T7·T8 | «третье состояние» проверено в четырёх местах (история склада, журнал заливок, пустая неделя, `health_unavailable`); `tashkentDay`/`tashkentDayStart` — единственный источник суток (T6 сторож, T7 `cutoffAs`, T8 `parityDaysInWeek`); ключ заведён через `CONFIG_SPECS` с русским `help` |

**Сканирование на заглушки.** В плане нет `TBD`, нет «add validation», нет «аналогично Task N» и нет «см. выше» вместо кода: каждый тест и каждый фрагмент реализации выписан целиком там, где он нужен, даже когда повторяет соседа (пять одинаковых по форме правок снек-листов в T2 перечислены по файлам и строкам; четыре цели бэкфилла — данными, а не «и так далее»; пять сигнатур `здоровье()` в боте — полным телом функции). Три места, где план сознательно НЕ выписывает код, названы явно и не являются заглушками: (а) фикстура `PurchaseSummary` в контрактном тесте T5 — её поля берутся из `packages/shared/src/vending-calc.ts:239` как есть, потому что форму задаёт тот, кто считает числа; (б) имя экспортируемой таблицы и фикстуры в существующем `purchase-plan-view.test.tsx` — файл уже есть и уже рендерит план, новый тест только дописывает утверждение; (в) точные строки П8b в T7/T8 — предусловие каждой из этих задач прямо велит перечитать их в дереве после rebase.

**Согласованность типов между задачами.** `StockCountRow`/`StockCountsReport` объявлены ровно один раз — `packages/shared/src/vending-reports.ts` (T1); Core их импортирует, панель реэкспортирует (`lib/core.ts`), своей копии не заводит. `VendingRefillEvent` (панель, `lib/core.ts:341`) и `RefillEventRow` (Core, `refill-events.service.ts:61`) остаются ДВУМЯ именами одной формы намеренно: их переезд в shared — не одна из восьми задач описи (R-H-1), и трогать его в срезе, который и так двигает восемь форм, значило бы расширить дифф без вопроса владельца. `ShrinkRefillDay`/`ShrinkMachine`/`ShrinkWarningCode`/`ShrinkWarning`/`ShrinkReport` и `PlanMachine`/`PlanWarning`/`PurchasePlan` после T5 живут ровно в одном файле; `ShrinkItem`/`ShrinkSummary` остаются в `vending-field.ts`, `SlotPlanRow` — в `vending-plan.ts`, `PurchaseSummary` — в `vending-calc.ts`, и `vending-reports.ts` их ИМПОРТИРУЕТ (переезд ради соседства был бы диффом без выигрыша). Панельные имена `VendingPlan*`/`VendingShrinkage*` и ботовые `VendingPlan*` после T5 — это `as`-алиасы, а не типы: заведись на их месте объявление, компиляторные сверки `core-types.test.ts`/`core-client.test.ts` перестанут собираться. `WeeklyHealth` (T8) объявлен в shared рядом с `WeeklyDigest` и реэкспортируется ботом — панель `WeeklyDigest` не читает вовсе, потребитель ровно один. `ParityDay` (П8b, `parity-streak.ts`) в T8 не копируется и не переобъявляется: `WeeklyHealth.parityDays` ссылается на него, а `vending-reports.ts` импортирует тип из `./parity-streak` — цикла нет, `parity-streak.ts` тянет только `./tashkent-time`. `RunWindow` и `WEEK_RUNS_LIMIT` живут в `sync-runs.ts` рядом с остальными вопросами о журнале прогонов — по тому же доводу, что записан в шапке модуля: своя копия запроса у витрины разошлась бы с числом, по которому будят владельца. `SyncRunFacts` объявлен один раз (`sync-streak.ts`) и импортируется в `sync-runs.ts`; обратной зависимости нет. `BackfillTarget`/`BackfillResult` — внутренние формы скрипта, HTTP не отдаются и в shared не едут. `RetentionTarget` после T7 прирастает НЕОБЯЗАТЕЛЬНЫМ `cutoffAs`, то есть четыре существующие цели не меняются ни на байт — это и утверждает тест «граница голыми сутками» своей второй половиной.

**Известные риски исполнения.** (1) T5 трогает четыре пакета одним смыслом — правку вести ПО ОДНОМУ пакету за раз (shared → core → bot → cc), иначе `pnpm -s typecheck` покажет восемь причин вместо одной, и первая же из них уведёт не туда. (2) T5 и П8b правят ОДИН файл (`packages/shared/src/vending-reports.ts`) — текстовый конфликт при rebase вероятен, и разрешается он в пользу обеих сторон: П8b добавляет поля `OurvendHealth`, T5 — восемь новых интерфейсов ниже. (3) `apps/cc/src/lib/core-types.test.ts` содержит `expect(Object.keys(здоровье).sort()).toEqual([...])` — после П8b список полей `OurvendHealth` длиннее; если этот тест краснеет в T5, чинит его П8b-версия файла, а не наша правка. (4) Сторож в T6 считает вхождения `new Date()` — при любой будущей правке файла число «два» придётся осознанно пересматривать; это цена того, что поведенческий тест утечку часов в приватный помощник не видит. (5) T7 и T8 писать ТОЛЬКО после мержа П8b: `parityStreak` в реальном коде судит день по полям `день_*` (а не по недельной витрине, как описано в §2 спеки по диффу), `lastSuccessRunAt` окна не принимает, а `RetentionTarget` — это внутренний интерфейс без экспорта. (6) Общий worktree с Codex: перед правкой дерева сверять `mtime` чужих файлов и коммитить только своими путями (`git commit -- …`); `git add -A` утащит чужое.
