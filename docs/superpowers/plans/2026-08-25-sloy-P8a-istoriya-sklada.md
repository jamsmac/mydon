# П8a «История склада + сторож сбора» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** История склада перестаёт жить в чужой БД. 107 заливов и 460 инвентаризаций склада из `mydon-stock` переезжают в MYDON один раз и навсегда; зеркало закупок сверяется по `ext_id` и объявляется финальным; с этого среза каждый пересчёт склада сам пишет строку истории. Параллельно закрывается дыра наблюдения: «сбор не запускался N часов» становится событием, а не тишиной.

**Architecture:** Чистый маппинг донорских строк — в `@mydon/shared` (`stock-history.ts`): декод HTML-энтити, канон имени, канон серийника, ключи идемпотентности, сверка закупок. Разовый перенос — скрипт `packages/db/src/import-stock-history.ts` → `dist/import-stock-history.js` с `--dry-run`/`--apply`: читает донора сырым SQL через `postgres` (как `supply.service.ts`), пишет свою БД через `createDb`. Накопление истории дальше — в Core: `ingestStock` кладёт строку `vending_stock_count` на каждую применённую позицию пересчёта, `GET /vending/stock-counts` её отдаёт. Сторож — отдельный `SyncStaleService` (крон `*/30`), считающий давность последнего успеха тем же выражением, что и отчёт о здоровье; тревога идёт событием `ourvend.sync_stale` через `rules.ts`.

**Tech Stack:** TypeScript strict, NestJS + class-validator (DTO на каждом входе), Drizzle/Postgres (миграция 0069), postgres.js для донора, Next.js (панель — только чтение), Telegram-бот, `node:test` по dist / vitest (cc), `tools/smoke-core.mjs` + новый `tools/smoke-import.mjs` против живого Postgres.

**Spec:** `docs/superpowers/specs/2026-08-25-p8a-stock-history-design.md` (рулинги R-P8a-1…9)

## Global Constraints

Копия рулингов спеки, связывающих КАЖДУЮ задачу. Нарушение здесь — не стилевая правка, а порча единственного экземпляра истории: донор после П8 гасится, второго прогона не будет.

- **R-P8a-1 Ничего не переимпортировать.** Закупки/продажи/остатки автоматов не трогаем. Разовый `reconcile`: сверка `purchase(source='stock')` с донором по `ext_id` — отчёт «в mydon / в доноре / расхождения по qty·price·dt»; **дописать отсутствующие** (по ключу), **не удалять и не править** существующие (удалённые в доноре 39 id — известны, не воспроизводим). После сверки зеркало закупок объявляется финальным.
- **R-P8a-2 Заливы.** 107 строк по автоматам с серийником → `vending_refill`: `client_key = 'stock:refill:<id>'` (UNIQUE — идемпотентность), `machine_serial` = канон, `product_name` = канон через `vending_alias`/`normalizeProductName` (не резолвится → сырое имя + строка в отчёте), `qty`, `performed_at = dt 12:00 Asia/Tashkent`, `source = 'stock-import'`, `person_id = NULL`. Склад при импорте **не списывать**. 348 «общих» заливов — не импортировать; архив (R-P8a-5).
- **R-P8a-3 История инвентаризаций склада.** Новая таблица `vending_stock_count` (миграция 0069): `id`, `dt date`, `product_name` (канон), `product_id` (nullable FK), `qty numeric`, `source` (`'stock-import' | 'own'`), `ext_id` (nullable), `counted_at timestamptz`, `person_id` (nullable), `note`; UNIQUE `(source, ext_id)` для импорта и `(source, counted_at, product_name)` для своих. Импорт 460 складских `stock_counts`. **С этого среза `ingestStock` пишет строку истории на каждую позицию пересчёта.** Чтение: `GET /vending/stock-counts?product=&days=`.
- **R-P8a-4 `OURVEND_EPOCH` — документ, не код.** Строки до 2026-01-01 импортируются как есть с их датами; в код рубеж не вводится. Абзац в `docs/DATA_SOURCES.md`.
- **R-P8a-5 Архив донора.** `pg_dump` донора в `/opt/backups/stock-archive/<дата>.sql.gz` (шаг выкатки, ФС хоста). В БД mydon — одно событие `stock.history.imported {refills, stockCounts, purchasesAdded, unresolved[]}`.
- **R-P8a-6 Сторож «нет успешного прогона».** Крон каждые 30 мин (`*/30 * * * *`, Asia/Tashkent): `lastSuccessAt` старше `SYNC_STALE_HOURS` (ключ настроек, 6) → событие `ourvend.sync_stale {hoursSinceSuccess, lastSuccessAt, lastRunStatus}` с дедупом раз в ташкентские сутки; правило `urgency:"immediate"`. `OurvendHealth` получает `staleHours`. Порог читается `readIntSetting`, база важнее env.
- **R-P8a-7 Имена товаров.** Только точное сопоставление (алиасы + нормализация). 14 имён без `ourvend_name` импортируются с сырым именем и `product_id = NULL`, список — в отчёт и в событие; HTML-энтити (`&amp;`, `&#39;`) декодируются перед нормализацией. «Недостача (Рустам)» — служебная строка, в `vending_stock_count` не импортируется.
- **R-P8a-8 Идемпотентность и порядок.** Один скрипт `packages/db/dist/import-stock-history.js` с `--dry-run` и `--apply`; читает `STOCK_DATABASE_URL` (read-only), пишет `DATABASE_URL`; повторный `--apply` → 0 новых. Порядок на проде: `--dry-run` → просмотр → `--apply` → архив pg_dump → (позже, П8) гасить `STOCK_DATABASE_URL`.
- **R-P8a-9 Не в этом срезе.** Гашение `STOCK_DATABASE_URL`, вывод панели :8080 и бота склада, заморозка БД — П8; лист истории склада в панели — бэклог; инкассации — Срез К.
- **Время.** Все суточные границы и `performed_at` — по Ташкенту, через `packages/shared/src/tashkent-time.ts` (`tashkentInstant`, `tashkentDay`, `tashkentDayStartOf`). Второй константы смещения не заводить (урок R-FW-11); `created_at::date` донора вместо `dt` — прямой путь к сдвигу VendCash на 5 часов.
- **TS strict, без `any`.** Русский в UI/тестах/доках, английский в коде и именах событий/полей.
- **Тесты по dist:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build` перед прогоном core/bot/db; `pnpm --filter cc test` — vitest. Существующие наборы остаются зелёными.
- **Смоук.** Каждый новый GET и каждая новая запись — в `tools/smoke-core.mjs` (юнит-заглушка БД SQL не исполняет). Скрипт импорта — в новом `tools/smoke-import.mjs`: он сам создаёт в scratch-БД схему `stock_donor` с минимальными донорскими таблицами и строками, прогоняет скрипт дважды и требует «второй прогон — 0 новых».
- **ServiceTokenGuard.** Новых POST в срезе нет; `POST /vending/stock` уже закрыт общим guard'ом (`app.module.ts:83`). Новый GET открыт — это отчёт, и получает личный `@Throttle`, как `/vending/shrinkage`.
- **Мутация = транзакция + `event`.** Новое событие без правила в `rules.ts` до владельца не доходит — правило обязательно там, где нужна доставка (`ourvend.sync_stale`). `stock.history.imported` — отметка в журнале, правила не требует.
- **Коммиты в общем worktree.** Ветка `feat/p8a-stock-history` (от `main@42a2f32` + коммит спеки). Коммитим ТОЛЬКО свои пути: `git commit -m "…" -- <путь> <путь>`; `git add -A`/`git commit -a` в общем дереве утащат чужие несохранённые правки. Conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push только в свою ветку: после `git checkout main` первой командой `git checkout -b` — фолбэк `|| git push` молча пушит main в прод.
- **Прод из задач плана не трогаем.** Единственные записи на проде — в разделе «Выкатка», руками владельца.

**Три отклонения от буквы спеки, зафиксированные кодом** (в T6 уходят в аддендум спеки):

1. **`vending_refill.source` УЖЕ ЕСТЬ** — `schema.ts:1651`, `text("source").default("bot").notNull()`, комментарий «Откуда факт: bot | panel». Спека §3 допускала оба исхода («если колонки нет»). Колонки в 0069 не заводим — правим только JSDoc, добавляя `stock-import`.
2. **Оба UNIQUE — ЧАСТИЧНЫЕ.** Сплошной `(source, counted_at, product_name)` отверг бы законные донорские дубли: у `stock_counts` 5 групп дублей по (dt, место, товар, qty), и две строки с одинаковым `counted_at` и товаром — реальность донора, а не ошибка (см. `inventory-donor.md` §2, §4.4). Ключ импорта — `(source, ext_id) WHERE ext_id IS NOT NULL`, ключ своих — `(source, counted_at, product_name) WHERE source = 'own'`. Так у импорта идемпотентность по `ext_id`, у своих — по моменту пересчёта, и они не мешают друг другу.
3. **`staleHours: number | null`, а не просто число.** `null` — «успешных прогонов не было вовсе», и это не «0 ч». Тот же урок, что у `slotsLagMin` (R-P5b-8): ноль читается как «только что», а пустой журнал означает обратное. Рядом едет `staleThresholdH: number` — порог из настроек: без него бот и панель завели бы ЧЕТВЁРТУЮ копию шестёрки (`LAG_ALERT_H` в боте и `HEALTH_LAG_HOURS` в панели — про свежесть СНИМКОВ, а не про застой сбора; путать их нельзя).

## Карта файлов

| Файл | Роль |
|---|---|
| `packages/db/src/schema.ts`, `drizzle/0069_stock_count.sql`, `drizzle/meta/{_journal,0069_snapshot}.json`, `src/schema.test.ts` | таблица `vending_stock_count`, страж-тест |
| `apps/core/src/system/config-spec.ts` (+test) | ключ `SYNC_STALE_HOURS` |
| `packages/shared/src/stock-history.ts` (+test), `index.ts` | `decodeHtml`, `mapRefill`, `mapStockCount`, `reconcilePurchases` |
| `packages/shared/src/vending-reports.ts` (+`vending-reports-contracts.test.ts`) | `staleHours()`, `OurvendHealth.staleHours`/`staleThresholdH`, код предупреждения `history_capped` |
| `packages/db/src/import-stock-history.ts` (+test), `package.json` | разовый перенос истории |
| `tools/smoke-import.mjs`, `.github/workflows/ci.yml` | дымовой прогон скрипта с фикстурным донором |
| `apps/core/src/vending/vending.service.ts` (+test), `vending.controller.ts`, `tools/smoke-core.mjs` | запись истории в `ingestStock`, `GET /vending/stock-counts` |
| `apps/core/src/ourvend/sync-stale.service.ts` (+test), `ourvend-health.service.ts` (+test), `vending/vending.module.ts` | сторож `ourvend.sync_stale`, `staleHours` в отчёте |
| `apps/core/src/rules/rules.ts` (+`rules.test.ts`) | правило `ourvend.sync_stale` |
| `apps/bot/src/analytics-brief.ts` (+test) | строка застоя в «сверке» |
| `apps/cc/src/components/ourvend-health-view.tsx` (+test) | бейдж застоя в «Здоровье сбора» |
| `docs/PLAN_STOCK_ABSORPTION.md`, `docs/DATA_SOURCES.md`, `docs/DEPLOY.md`, спека | документы |

---

### Task 1: Данные — таблица истории (0069) и ключ настроек

**Files:** Modify `packages/db/src/schema.ts` (после `vendingStock`, ~стр. 1537, до блока видов автоматов; и JSDoc `vendingRefill.source` ~стр. 1650), `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema.test.ts` (в тест «вендинг: слот хранит ВМЕСТИМОСТЬ…», ~стр. 74); Create `packages/db/drizzle/0069_stock_count.sql`, `packages/db/drizzle/meta/0069_snapshot.json`; Modify `apps/core/src/system/config-spec.ts` (новый блок после «Вендинг: аналитика (П5b)», ~стр. 216) и `config-spec.test.ts` (после набора «Ключи аналитики П5b», ~стр. 93).

**Interfaces (produces):**
```ts
/** packages/db/src/schema.ts */
export const vendingStockCount: PgTableWithColumns<{
  id: string; dt: string; productName: string; productId: string | null;
  qty: string; source: string; extId: string | null;
  countedAt: Date; personId: string | null; note: string | null; createdAt: Date;
}>;
// индексы: vending_stock_count_src_key (partial, ext_id is not null),
//          vending_stock_count_own_key (partial, source = 'own'),
//          vending_stock_count_product_dt_idx (product_name, dt)
```

- [ ] **Step 1:** `pnpm --filter @mydon/db db:generate` → «No schema changes» (базовая линия чиста; если нет — не начинать, разбираться с дрифтом).
- [ ] **Step 2: Тесты RED.** В `schema.test.ts`, в тест «вендинг: слот хранит ВМЕСТИМОСТЬ…», дописать:
```ts
    const count = Object.keys(schema.vendingStockCount as unknown as Record<string, unknown>);
    // История склада — предмет П8a: `vending_stock` перезаписной, и до этой
    // таблицы «сколько было в июне» не отвечало ничто.
    assert.ok(count.includes("countedAt") && count.includes("dt"), "момент пересчёта и его сутки");
    assert.ok(count.includes("source") && count.includes("extId"), "источник строки и id донора — ключ идемпотентности импорта");
    assert.ok(count.includes("personId"), "кто считал: строка без человека законна, но поле обязано быть");
```
В `config-spec.test.ts` — новый набор:
```ts
describe("Ключ сторожа сбора П8a (R-P8a-6)", () => {
  it("SYNC_STALE_HOURS: дефолт 6, ноль и отрицательное отвергаются", () => {
    assert.equal(specFor("SYNC_STALE_HOURS")?.fallback, "6");
    // Ноль здесь не «показывай всё», а «тревога каждые полчаса навсегда»:
    // окно в часах нулём не выключается (тот же довод, что у posNumber).
    assert.ok(validateConfig("SYNC_STALE_HOURS", "0"));
    assert.ok(validateConfig("SYNC_STALE_HOURS", "-1"));
    assert.ok(validateConfig("SYNC_STALE_HOURS", "шесть"));
    assert.equal(validateConfig("SYNC_STALE_HOURS", "12"), null);
  });
});
```
- [ ] **Step 3:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → RED («в схеме нет `vendingStockCount`»); `pnpm --filter core test` → RED (`specFor(...)` возвращает `undefined`).
- [ ] **Step 4: Схема.** `vendingStockCount` в `schema.ts` с шапкой, объясняющей ДВА решения: (а) зачем таблица, если есть `vending_stock` — тот перезаписной, «одна строка на товар», и вопрос «сколько было в июне» не имел ответа ни в одной таблице (`inventory-prod.md` §3: `vending_stock` 20 строк, два момента 25.08, событий `vending.stock.recounted` — 2); (б) почему оба UNIQUE частичные (см. отклонение №2 в Global Constraints). Колонки — по R-P8a-3; `qty` — `numeric("qty", { precision: 12, scale: 2 })`, потому что донор хранит дробные остатки, а `integer` их тихо срезал бы.
```ts
  (t) => [
    uniqueIndex("vending_stock_count_src_key").on(t.source, t.extId).where(sql`${t.extId} is not null`),
    uniqueIndex("vending_stock_count_own_key").on(t.source, t.countedAt, t.productName).where(sql`${t.source} = 'own'`),
    index("vending_stock_count_product_dt_idx").on(t.productName, t.dt),
  ],
```
Там же — правка JSDoc `vendingRefill.source`: «Откуда факт: bot | panel | stock-import (разовый перенос истории mydon-stock, П8a)». Колонку НЕ добавлять, она есть.
- [ ] **Step 5: Миграция.** `db:generate` → переименовать файл в `0069_stock_count.sql`, tag в `_journal.json` (`idx: 69`, `when` = предыдущий + 1). SQL привести к защитному виду 0067 (`CREATE TABLE IF NOT EXISTS`, FK через `DO $$ … EXCEPTION WHEN duplicate_object`, `CREATE UNIQUE INDEX IF NOT EXISTS … WHERE …`). Шапка-комментарий: зачем таблица, почему индексы частичные, что бэкфилла нет (историю заливает скрипт T3, а не миграция — резолв имени это КОД, повторять его в SQL значит завести вторую реализацию правила).
- [ ] **Step 6: Настройка.** В `CONFIG_SPECS` блок `// ── Вендинг: сторож сбора (П8a, R-P8a-6) ──` с ключом `SYNC_STALE_HOURS` (`kind: "number"`, `fallback: "6"`, `help: "Сбор ходит раз в 3 часа: 6 ч = два пропущенных прогона подряд."`, `validate: posNumber`).
- [ ] **Step 7:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test && pnpm --filter core build && pnpm --filter core test` → GREEN. `db:generate` ещё раз → «No schema changes» (снапшот честен).
- [ ] **Step 8:** `git commit -m "feat(db,core): таблица истории инвентаризаций vending_stock_count (0069) и порог сторожа сбора (П8a)" -- packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/drizzle/0069_stock_count.sql packages/db/drizzle/meta apps/core/src/system/config-spec.ts apps/core/src/system/config-spec.test.ts`

---

### Task 2: Чистый маппинг донора (`packages/shared/src/stock-history.ts`)

**Files:** Create `packages/shared/src/stock-history.ts`, `packages/shared/src/stock-history.test.ts`; Modify `packages/shared/src/index.ts` (после `export * from "./vending-reports";`, ~стр. 88).

**Interfaces (produces):**
```ts
/** Строки донора как их отдаёт SQL: числа приходят строками postgres.js. */
export interface DonorRefillRow { id: number | string; dt: string; machine_serial: string | null; product: string; qty: string | number }
export interface DonorStockCountRow { id: number | string; dt: string; product: string; qty: string | number; counted_at: string | Date | null }
export interface DonorPurchaseRow { id: number | string; dt: string; product: string; qty: string | number; unit_price: string | number | null }

/** Канон имени: точное сопоставление через алиасы и прайс. `null` — канона НЕТ. */
export type CanonIndex = (raw: string) => string | null;

/** Формы вставки для скрипта. Объявлены здесь, а не выведены из drizzle: `@mydon/shared` о `@mydon/db` не знает (зависимость односторонняя). */
export interface VendingRefillInsert {
  machineSerial: string; coilId: null; productName: string; qty: number;
  performedAt: string; clientKey: string; source: "stock-import"; personId: null; note: string | null;
}
export interface VendingStockCountInsert {
  dt: string; productName: string; qty: number; source: "stock-import";
  extId: string; countedAt: string; personId: null; note: string | null;
}

/** Строка НЕ легла в таблицу — и почему именно, словом. */
export interface Unresolved { ok: false; reason: "no_serial" | "service_row" | "bad_qty" | "no_date"; extId: string; product: string }
/** Строка легла. `rawName` — имя, которому канона нет: едет сырым, `productId` останется NULL (R-P8a-7). */
export interface Mapped<T> { ok: true; row: T; rawName: string | null }

export function decodeHtml(raw: string): string;
/** Донорская пометка слияния карточек: `Pepsi 0,5 [слит→23]` → `Pepsi 0,5`. */
export function stripMergedMarker(raw: string): string;
/** `decodeHtml` → `stripMergedMarker` → канон. Возвращает [имя, найденЛиКанон]. */
export function canonicalProductName(raw: string, canon: CanonIndex): [string, boolean];
/** Служебные строки донора: не товар, а разница в сумме. Список, а не догадка по подстроке. */
export const SERVICE_PRODUCT_NAMES: readonly string[];

export function mapRefill(row: DonorRefillRow, canon: CanonIndex): Mapped<VendingRefillInsert> | Unresolved;
export function mapStockCount(row: DonorStockCountRow, canon: CanonIndex): Mapped<VendingStockCountInsert> | Unresolved;

export interface PurchaseFacts { extId: string; dt: string; product: string; qty: number; unitPrice: number | null }
export interface PurchaseDiff { extId: string; field: "dt" | "product" | "qty" | "unitPrice"; mine: string | number | null; donor: string | number | null }
export interface PurchaseReconcile {
  /** Есть у донора, нет у нас — ДОПИСАТЬ (R-P8a-1). */
  missing: PurchaseFacts[];
  /** Есть у обоих, числа разошлись — только отчёт, править нельзя. */
  differing: PurchaseDiff[];
  /** Есть у нас, нет у донора: 39 удалённых id. Не удалять. */
  onlyMine: string[];
}
export function reconcilePurchases(mine: readonly PurchaseFacts[], donor: readonly DonorPurchaseRow[]): PurchaseReconcile;
```

Семантика, которую обязаны воспроизвести реализация и тесты:
- `decodeHtml` — ОДИН проход, `&amp;` заменяется ПОСЛЕДНИМ. Второй проход превратил бы легитимно закодированное `&amp;amp;` в `&`, а порядок «amp первым» дал бы из `&amp;#39;` апостроф там, где его не было. Набор: `&#NN;`/`&#xNN;`, `&quot;`, `&apos;`, `&lt;`, `&gt;`, `&nbsp;`, затем `&amp;`.
- `canonicalProductName`: декод → снятие `[слит→N]` → `canon(...)`. Снятие пометки — НЕ нечёткое сопоставление: `[слит→23]` не часть имени товара, а служебная приписка панели склада (13 карточек донора). Канона нет → возвращается очищенное сырое имя и `false`.
- `mapRefill`: серийник — `normalizeMachineSerial` (`C2508160376` → `2508160376`); пустой/NULL серийник → `Unresolved{reason:"no_serial"}` (это 348 «общих» аппаратов); `qty` не число или ≤ 0 → `bad_qty`; `performedAt = tashkentInstant(`${dt}T12:00:00`)!.toISOString()`; `clientKey = `stock:refill:${id}``; `note = "импорт истории mydon-stock"`.
- `mapStockCount`: служебное имя (после декода и нормализации совпало с `SERVICE_PRODUCT_NAMES`) → `Unresolved{reason:"service_row"}`; `countedAt` донора, если он есть, иначе полдень `dt` — донор писал `counted_at` не всегда, а `NOT NULL` в нашей таблице требует момент, и полночь UTC увела бы строку на предыдущие сутки; `extId = String(id)`.
- Дедупа по естественному ключу НЕТ ни в одной функции: два залива одного товара в один день на один автомат — законная реальность донора (7 групп), и разные `id` дают разные `client_key`. Механическая склейка съела бы намеренные пары `seed_refills_1415.py`.
- `reconcilePurchases` сравнивает по `String(id)`; `unitPrice` сравнивается с допуском 0.005 (numeric(15,2) против float донора), `qty` — с допуском 0.005; `dt` — по первым 10 символам.

- [ ] **Step 1: Тесты** (`stock-history.test.ts`, node:test; фикстуры — дословно из `inventory-donor.md` §2, §4):
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalProductName, decodeHtml, mapRefill, mapStockCount, reconcilePurchases,
  stripMergedMarker, type DonorPurchaseRow, type PurchaseFacts,
} from "./stock-history";

/** Прайс mydon: канон знает только то, что реально есть в справочнике. */
const ПРАЙС = new Map([
  ["pepsi 0,5", "Pepsi 0,5"],
  ["m&ms", "M&Ms"],
  ["o'zbegim", "O'zbegim"],
  ["tuc sour cream", "TUC Sour cream"],
]);
const canon = (raw: string): string | null => ПРАЙС.get(raw.trim().toLowerCase()) ?? null;

describe("HTML-мусор панели склада (R-P8a-7)", () => {
  it("энтити декодируются до нормализации", () => {
    assert.equal(decodeHtml("M&amp;Ms"), "M&Ms");
    assert.equal(decodeHtml("O&#39;zbegim"), "O'zbegim");
  });
  it("один проход: двойное кодирование не разворачивается до конца", () => {
    // `&amp;amp;` — это закодированное `&amp;`, а не `&`. Второй проход соврал бы.
    assert.equal(decodeHtml("M&amp;amp;Ms"), "M&amp;Ms");
  });
  it("после декода имя ложится на карточку прайса", () => {
    assert.deepEqual(canonicalProductName("M&amp;Ms", canon), ["M&Ms", true]);
    assert.deepEqual(canonicalProductName("O&#39;zbegim", canon), ["O'zbegim", true]);
  });
});

describe("Донорская пометка слияния карточек", () => {
  it("[слит→N] снимается, товар ложится на канон", () => {
    assert.equal(stripMergedMarker("Pepsi 0,5 [слит→23]"), "Pepsi 0,5");
    assert.deepEqual(canonicalProductName("Pepsi 0,5 [слит→23]", canon), ["Pepsi 0,5", true]);
  });
  it("канона нет — сырое имя и признак «не разрешено», а не подстановка похожего", () => {
    // «Moxito Mango CAN 0.45» — одно из 14 имён без ourvend_name. Нечёткое
    // сопоставление склеило бы 330ml с 450ml, поэтому его здесь нет вовсе.
    assert.deepEqual(canonicalProductName("Moxito Mango CAN 0.45", canon), ["Moxito Mango CAN 0.45", false]);
  });
});

describe("Заливы: 107 по живым автоматам, 348 «общих» — мимо (R-P8a-2)", () => {
  const строка = (over: Partial<Parameters<typeof mapRefill>[0]> = {}) =>
    mapRefill({ id: 412, dt: "2026-04-22", machine_serial: "C2508160376", product: "TUC Sour cream", qty: "6", ...over }, canon);

  it("серийник приведён к канону, момент — полдень Ташкента", () => {
    const r = строка();
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.row.machineSerial, "2508160376");
    assert.equal(r.row.performedAt, "2026-04-22T07:00:00.000Z"); // 12:00 +05
    assert.deepEqual([r.row.clientKey, r.row.source, r.row.personId, r.row.qty], ["stock:refill:412", "stock-import", null, 6]);
    assert.equal(r.rawName, null);
  });
  it("виртуальный «общий» аппарат без серийника не импортируется", () => {
    const r = строка({ machine_serial: null });
    assert.deepEqual(r, { ok: false, reason: "no_serial", extId: "412", product: "TUC Sour cream" });
  });
  it("дубль по естественному ключу остаётся дублем: ключ идёт от id", () => {
    // 7 групп дублей у донора — законные повторные заливки, а не ошибка ввода.
    const a = строка({ id: 500 }), b = строка({ id: 501 });
    assert.ok(a.ok && b.ok && a.row.clientKey !== b.row.clientKey);
  });
  it("имя без канона едет сырым и называется в отчёте", () => {
    const r = строка({ product: "Moxito Mango CAN 0.45" });
    assert.ok(r.ok && r.row.productName === "Moxito Mango CAN 0.45" && r.rawName === "Moxito Mango CAN 0.45");
  });
});

describe("Инвентаризации склада: 460 строк (R-P8a-3, R-P8a-7)", () => {
  it("dt, qty и counted_at донора едут как есть, ключ — ext_id", () => {
    const r = mapStockCount({ id: 77, dt: "2025-08-17", product: "Pepsi 0,5 [слит→23]", qty: "24.00", counted_at: "2025-08-17T09:00:00+05:00" }, canon);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual([r.row.dt, r.row.qty, r.row.extId, r.row.productName], ["2025-08-17", 24, "77", "Pepsi 0,5"]);
    assert.equal(r.row.countedAt, "2025-08-17T04:00:00.000Z");
  });
  it("counted_at пустой → полдень тех же ташкентских суток, а не полночь UTC", () => {
    const r = mapStockCount({ id: 78, dt: "2025-08-17", product: "TUC Sour cream", qty: 3, counted_at: null }, canon);
    assert.ok(r.ok && r.row.countedAt === "2025-08-17T07:00:00.000Z");
  });
  it("«Недостача (Рустам)» — служебная строка, в историю не идёт", () => {
    const r = mapStockCount({ id: 79, dt: "2026-07-14", product: "Недостача (Рустам)", qty: 1, counted_at: null }, canon);
    assert.deepEqual(r, { ok: false, reason: "service_row", extId: "79", product: "Недостача (Рустам)" });
  });
});

describe("Сверка закупок по ext_id: дописать, но не править (R-P8a-1)", () => {
  const мои: PurchaseFacts[] = [
    { extId: "1", dt: "2025-08-18", product: "Pepsi 0,5", qty: 24, unitPrice: 0 },
    { extId: "2", dt: "2026-07-13", product: "TUC Sour cream", qty: 10, unitPrice: 2600 },
    { extId: "9", dt: "2026-07-13", product: "Удалённый у донора", qty: 1, unitPrice: 100 },
  ];
  const донор: DonorPurchaseRow[] = [
    { id: 1, dt: "2025-08-18", product: "Pepsi 0,5", qty: "24", unit_price: "0" },
    { id: 2, dt: "2026-07-13", product: "TUC Sour cream", qty: "12", unit_price: "2600" },
    { id: 3, dt: "2026-07-13", product: "M&amp;Ms", qty: "6", unit_price: "8000" },
  ];
  const r = reconcilePurchases(мои, донор);

  it("недостающая строка донора попадает в missing с декодированным именем", () => {
    assert.deepEqual(r.missing, [{ extId: "3", dt: "2026-07-13", product: "M&Ms", qty: 6, unitPrice: 8000 }]);
  });
  it("расхождение названо, но правкой не становится", () => {
    assert.deepEqual(r.differing, [{ extId: "2", field: "qty", mine: 10, donor: 12 }]);
  });
  it("наши строки без донорского близнеца — 39 удалённых id, их не удаляем", () => {
    assert.deepEqual(r.onlyMine, ["9"]);
  });
  it("копеечная разница numeric против float расхождением не считается", () => {
    const r2 = reconcilePurchases([{ extId: "1", dt: "2025-08-18", product: "Pepsi 0,5", qty: 24, unitPrice: 2600 }],
      [{ id: 1, dt: "2025-08-18", product: "Pepsi 0,5", qty: "24.000", unit_price: "2600.001" }]);
    assert.deepEqual([r2.missing, r2.differing, r2.onlyMine], [[], [], []]);
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build` → RED: «Cannot find module './stock-history'».
- [ ] **Step 3: Реализация** `stock-history.ts`. Опоры: `normalizeMachineSerial` из `./machine-serial`, `tashkentInstant` из `./tashkent-time`, `normalizeProductName` из `./vending-calc` (для сравнения со служебным списком). Шапка модуля объясняет ТРИ решения, которые нельзя «упростить»: почему сопоставление только точное (нечёткое склеит 330ml с 450ml — `inventory-donor.md` §4.3), почему дедупа по естественному ключу нет (намеренные пары `archive/seed_*.py`, §4.4), и почему полдень, а не полночь (у донора `dt` — `DATE`, и любой момент суток честнее полуночи, которая при чтении как UTC уезжает на предыдущий день — ловушка VendCash). Экспорт в `index.ts`.
- [ ] **Step 4:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → GREEN (все 14 проверок).
- [ ] **Step 5:** `git commit -m "feat(shared): маппинг истории склада mydon-stock — заливы, инвентаризации, сверка закупок (П8a)" -- packages/shared/src/stock-history.ts packages/shared/src/stock-history.test.ts packages/shared/src/index.ts`

---

### Task 3: Скрипт разового переноса (`packages/db/src/import-stock-history.ts`)

**Files:** Create `packages/db/src/import-stock-history.ts`, `packages/db/src/import-stock-history.test.ts`, `tools/smoke-import.mjs`; Modify `packages/db/package.json` (скрипт рядом с `db:backfill:product-ids`), `.github/workflows/ci.yml` (шаг Smoke, после `backfill-product-ids.js`, ~стр. 82).

**Interfaces (produces):**
```ts
/** Чтение донора отделено от записи: тесту нужны массивы, а не Postgres. */
export interface DonorReader {
  refills(): Promise<DonorRefillRow[]>;
  stockCounts(): Promise<DonorStockCountRow[]>;
  purchases(): Promise<DonorPurchaseRow[]>;
}
export interface ImportSection { found: number; written: number; skipped: number }
export interface StockHistoryReport {
  apply: boolean;
  refills: ImportSection & { noSerial: number };
  stockCounts: ImportSection & { serviceRows: number };
  purchases: { mine: number; donor: number; added: number; differing: PurchaseDiff[]; onlyMine: number };
  /** Имена без карточки прайса — уезжают в отчёт и в событие (R-P8a-7). */
  unresolved: string[];
}
export async function importStockHistory(db: Database, donor: DonorReader, opts: { apply: boolean }): Promise<StockHistoryReport>;
/** Донор через postgres.js. `schema` — только для дымового прогона с фикстурой. */
export function sqlDonor(url: string, schema?: string): { reader: DonorReader; close(): Promise<void> };
export function formatReport(r: StockHistoryReport): string;
```

Что обязана делать реализация:
- Флаги: `--apply` — запись; `--dry-run` или БЕЗ флагов — отчёт без записи (безопасный дефолт, режим печатается первой строкой); оба флага сразу — `exit 1` с объяснением.
- Канон имени берётся из `vending_product` + `vending_alias` тем же правилом, что у Core, — переиспользовать `resolveProductIds` уже нельзя (там карта id, а нужен канон), поэтому строится один раз в скрипте и передаётся в `canonicalProductName` как `CanonIndex`; `productId` подставляется по тому же канону.
- `machineId` заливок — по `machineSerialKeys(entity.externalRef)` (обе формы написания), не найден → `null`.
- Вставки: `vending_refill` — `onConflictDoNothing({ target: vendingRefill.clientKey })`; `vending_stock_count` — `onConflictDoNothing({ target: [vendingStockCount.source, vendingStockCount.extId], targetWhere: sql`${vendingStockCount.extId} is not null` })`; `purchase` (только `missing`) — `onConflictDoNothing({ target: [purchase.source, purchase.extId] })`. `written` считается по длине `returning()`, а не по длине входа: иначе повторный прогон отчитался бы «записано 107», записав ноль.
- Пачками по 500 (как `supply.service.ts`).
- При `apply` — одна запись `event { source: "stock-import", type: "stock.history.imported", payload: { refills, stockCounts, purchasesAdded, unresolved } }`. При `--dry-run` событий НЕТ.
- `process.exit(0)` после отчёта (postgres.js держит соединение; без явного выхода ручной шаг выкатки висит).
- 348 «общих» заливов и 143 машинные инвентаризации в БД не попадают вовсе — они живут в архивном дампе (R-P8a-5). Отдельного события `stock.refill.aggregate` НЕ пишем: спека знает ровно одну отметку, `stock.history.imported`.

- [ ] **Step 1: Тесты** (`import-stock-history.test.ts`; заглушка `db` — та же техника, что в `apps/core/src/vending/*.test.ts`: цепочка методов с накоплением вставленного):
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importStockHistory, type DonorReader } from "./import-stock-history";
import type { Database } from "./index";

/** Минимальная заглушка drizzle: select отдаёт заготовку по имени таблицы, insert копит строки. */
function стенд(donorRows: Partial<Record<"refills" | "stockCounts" | "purchases", unknown[]>>, уже: { clientKeys: string[]; extIds: string[] }) {
  const вставлено: Record<string, unknown[]> = { vending_refill: [], vending_stock_count: [], purchase: [], event: [] };
  const имя = (t: unknown): string => (t as { [k: symbol]: string })[Symbol.for("drizzle:Name")] ?? "";
  const заготовки: Record<string, unknown[]> = {
    vending_product: [{ id: "p-tuc", name: "TUC Sour cream" }],
    vending_alias: [],
    entity: [{ id: "e-olma", externalRef: "c2508160376" }],
    purchase: [{ extId: "1", dt: "2025-08-18", product: "Pepsi 0,5", qty: "24", unitPrice: "0" }],
  };
  const db = {
    select: () => ({ from: (t: unknown) => Object.assign(Promise.resolve(заготовки[имя(t)] ?? []), { where: () => Promise.resolve(заготовки[имя(t)] ?? []) }) }),
    insert: (t: unknown) => ({
      values: (rows: unknown[]) => {
        const принять = (): Promise<unknown[]> => {
          // Повтор ловится ровно так же, как в Postgres: по уникальному ключу.
          const новые = rows.filter((r) => {
            const x = r as { clientKey?: string; extId?: string };
            return !(x.clientKey && уже.clientKeys.includes(x.clientKey)) && !(x.extId && уже.extIds.includes(x.extId));
          });
          вставлено[имя(t)]!.push(...новые);
          return Promise.resolve(новые);
        };
        const цепь = { onConflictDoNothing: () => ({ returning: принять }), returning: принять, then: (f: (v: unknown) => unknown) => принять().then(f) };
        return цепь;
      },
    }),
  } as unknown as Database;
  const donor: DonorReader = {
    refills: async () => (donorRows.refills ?? []) as never,
    stockCounts: async () => (donorRows.stockCounts ?? []) as never,
    purchases: async () => (donorRows.purchases ?? []) as never,
  };
  return { db, donor, вставлено };
}

const ЗАЛИВ = { id: 412, dt: "2026-04-22", machine_serial: "C2508160376", product: "TUC Sour cream", qty: "6" };
const ОБЩИЙ = { id: 413, dt: "2026-04-22", machine_serial: null, product: "TUC Sour cream", qty: "9" };
const ПЕРЕСЧЁТ = { id: 77, dt: "2026-07-14", product: "TUC Sour cream", qty: "24", counted_at: null };
const СЛУЖЕБНАЯ = { id: 78, dt: "2026-07-14", product: "Недостача (Рустам)", qty: "1", counted_at: null };

describe("Импорт истории склада (R-P8a-8)", () => {
  it("--dry-run считает всё и не пишет ничего", async () => {
    const { db, donor, вставлено } = стенд({ refills: [ЗАЛИВ, ОБЩИЙ], stockCounts: [ПЕРЕСЧЁТ, СЛУЖЕБНАЯ], purchases: [] }, { clientKeys: [], extIds: [] });
    const r = await importStockHistory(db, donor, { apply: false });
    assert.deepEqual([r.refills.found, r.refills.written, r.refills.noSerial], [2, 0, 1]);
    assert.deepEqual([r.stockCounts.found, r.stockCounts.written, r.stockCounts.serviceRows], [2, 0, 1]);
    assert.deepEqual(Object.values(вставлено).map((v) => v.length), [0, 0, 0, 0]);
  });

  it("--apply пишет только импортируемое и оставляет одну отметку в журнале", async () => {
    const { db, donor, вставлено } = стенд({ refills: [ЗАЛИВ, ОБЩИЙ], stockCounts: [ПЕРЕСЧЁТ, СЛУЖЕБНАЯ], purchases: [] }, { clientKeys: [], extIds: [] });
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.refills.written, r.stockCounts.written], [1, 1]);
    assert.equal(вставлено.vending_refill!.length, 1);
    assert.equal((вставлено.event![0] as { type: string }).type, "stock.history.imported");
  });

  it("повторный --apply: 0 новых, событие не врёт числом входа", async () => {
    const { db, donor } = стенд({ refills: [ЗАЛИВ], stockCounts: [ПЕРЕСЧЁТ] }, { clientKeys: ["stock:refill:412"], extIds: ["77"] });
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.refills.found, r.refills.written, r.stockCounts.written], [1, 0, 0]);
  });

  it("закупки: недостающая дописывается, расхождение только называется", async () => {
    const { db, donor, вставлено } = стенд({ purchases: [
      { id: 1, dt: "2025-08-18", product: "Pepsi 0,5", qty: "24", unit_price: "0" },
      { id: 3, dt: "2026-07-13", product: "M&amp;Ms", qty: "6", unit_price: "8000" },
    ] }, { clientKeys: [], extIds: ["1"] });
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.purchases.mine, r.purchases.donor, r.purchases.added], [1, 2, 1]);
    assert.equal((вставлено.purchase![0] as { product: string }).product, "M&Ms");
  });

  it("нерешённые имена названы поимённо — это список владельцу, а не ошибка выкатки", async () => {
    const { db, donor } = стенд({ refills: [{ ...ЗАЛИВ, product: "Moxito Mango CAN 0.45" }] }, { clientKeys: [], extIds: [] });
    const r = await importStockHistory(db, donor, { apply: false });
    assert.deepEqual(r.unresolved, ["Moxito Mango CAN 0.45"]);
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → RED («Cannot find module ./import-stock-history»).
- [ ] **Step 3: Реализация.** Шапка модуля — по образцу `backfill-product-ids.ts`: зачем скрипт, а не миграция (резолв имени — код, а не SQL-выражение), что он идемпотентен, и что донор читается ТОЛЬКО на чтение. `sqlDonor` подключается `postgres(url, { prepare: false, max: 1, connect_timeout: 10 })` — точно как `supply.service.ts:194`; таблицы квалифицируются схемой (`from ${sql(schema)}.refills`), схема берётся из `STOCK_SCHEMA` (по умолчанию `public`) — переменная нужна РОВНО дымовому прогону, где фикстурный донор лежит в той же базе; на проде донор — отдельная БД, и переменная не задаётся (URL-параметр `?options=-c search_path=…` не используем: его разбор postgres.js мы не проверяли, а угадывать в разовом скрипте нечего). Запросы:
```sql
select r.id, r.dt::text, m.serial as machine_serial, p.name as product, r.qty
  from refills r join machines m on m.id = r.machine_id join products p on p.id = r.product_id
select s.id, s.dt::text, p.name as product, s.qty, s.counted_at
  from stock_counts s join products p on p.id = s.product_id where s.machine_id is null
select pu.id, pu.dt::text, p.name as product, pu.qty, pu.unit_price
  from purchases pu join products p on p.id = pu.product_id
```
`formatReport` печатает таблицу «источник → найдено / записано / пропущено / не разрешено» и отдельным блоком расхождения закупок и список нерешённых имён.
- [ ] **Step 4: Смоук.** `tools/smoke-import.mjs`: подключается к `DATABASE_URL`, `CREATE SCHEMA IF NOT EXISTS stock_donor` + пять минимальных таблиц (`products`, `machines`, `refills`, `stock_counts`, `purchases`) и 8 строк — по одной на каждое правило: залив по живому серийнику `C2508160376`, залив на «общий» аппарат без серийника, пересчёт склада, служебная строка «Недостача (Рустам)», пересчёт по автомату (`machine_id not null` — должен быть отфильтрован SQL-запросом), закупка-близнец существующей и закупка с `M&amp;Ms`. Дальше — `STOCK_SCHEMA=stock_donor STOCK_DATABASE_URL=$DATABASE_URL node packages/db/dist/import-stock-history.js --apply` **дважды**; второй прогон обязан дать `written 0` по обеим таблицам (парсим отчёт), иначе `exit 1`. В конце — `DROP SCHEMA stock_donor CASCADE`. В `ci.yml` шаг добавляется строкой `node tools/smoke-import.mjs` сразу после `backfill-product-ids.js` (до `smoke-core.mjs`: тот гасит `STOCK_DATABASE_URL` намеренно и о доноре знать не должен).
- [ ] **Step 5:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → GREEN; локально — `createdb mydon_p8a && DATABASE_URL=… node packages/db/dist/migrate.js && node packages/db/dist/seed-vending.js && node tools/smoke-import.mjs`.
- [ ] **Step 6:** `git commit -m "feat(db): скрипт разового переноса истории склада из mydon-stock (П8a)" -- packages/db/src/import-stock-history.ts packages/db/src/import-stock-history.test.ts packages/db/package.json tools/smoke-import.mjs .github/workflows/ci.yml`

---

### Task 4: Core — история копится сама, чтение и сторож сбора

**Files:** Modify `apps/core/src/vending/vending.service.ts` (`IngestStockPayload` ~стр. 222, `ingestStock` ~стр. 1405, новый `stockCounts()` рядом с `stockLevels()` ~стр. 1508) и `vending.service.test.ts`; `apps/core/src/vending/vending.controller.ts` (DTO рядом с `ShrinkageDto` ~стр. 337, роут после `@Get("stock")` ~стр. 544, `IngestStockDto` ~стр. 113); Create `apps/core/src/ourvend/sync-stale.service.ts` (+`sync-stale.service.test.ts`); Modify `apps/core/src/ourvend/ourvend-health.service.ts` (+test), `apps/core/src/vending/vending.module.ts` (провайдер), `apps/core/src/rules/rules.ts` (+`rules.test.ts`), `packages/shared/src/vending-reports.ts` (+`vending-reports-contracts.test.ts`), `tools/smoke-core.mjs`.

**Interfaces (produces; типы — в `@mydon/shared`):**
```ts
/** packages/shared/src/vending-reports.ts */
export type AnalyticsWarningCode = /* … существующие … */ | "history_capped";
export interface OurvendHealth {
  /* … существующие поля … */
  /** Часов с последнего успеха. `null` — успехов НЕ БЫЛО ВОВСЕ, и это не 0 ч. */
  staleHours: number | null;
  /** Порог из настроек (`SYNC_STALE_HOURS`): бот и панель сравнивают с ним, а не со своей копией. */
  staleThresholdH: number;
}
/** Один расчёт давности на трёх читателей: отчёт, сторож, витрины. */
export function staleHours(lastSuccessAt: string | null, now: Date): number | null;
export interface StockCountRow { dt: string; product: string; qty: number; source: string; countedAt: string }
export interface StockCountsReport { days: number; product: string | null; rows: StockCountRow[]; warnings: AnalyticsWarning[] }

/** apps/core/src/vending/vending.service.ts */
export interface IngestStockPayload { countedAt?: string; personId?: string; items: IngestStockItemInput[] }
// VendingService:
async stockCounts(days?: number, product?: string): Promise<StockCountsReport>;

/** apps/core/src/ourvend/sync-stale.service.ts */
export const SYNC_STALE_HOURS_FALLBACK = 6;
export class SyncStaleService implements OnModuleInit, OnApplicationShutdown {
  /** `now` — параметр: иначе «7 часов назад» нечем проверить тестом. */
  async check(now?: Date): Promise<{ staleHours: number | null; threshold: number; emitted: boolean }>;
}
```

Что обязана делать реализация:
- `ingestStock`: в ТОЙ ЖЕ транзакции, рядом с апсертом `vendingStock`, накапливать строки `vendingStockCount` — но ТОЛЬКО для позиций, которые реально применились. Позиция, отброшенная защитой «входящий пересчёт старше сохранённого» (`continue` в цикле), в историю не попадает: иначе журнал показывал бы пересчёт, который остаток не изменил. `source: "own"`, `dt: tashkentDay(countedAt)`, `qty: String(quantity)`, `extId: null`, `personId: payload.personId ?? null`, `note: actor`. Вставка — `onConflictDoNothing({ target: [source, countedAt, productName], targetWhere: sql`${vendingStockCount.source} = 'own'` })`: повторный POST того же снимка не плодит вторую строку.
- `stockCounts(days = 90, product?)`: окно `dt >= tashkentDay(now) − days`, фильтр по имени — через канон (`priceIndex().canonOf`), сортировка `dt desc, productName`; потолок 2000 строк, при обрезке — предупреждение `history_capped`. Ноль строк по заданному товару — предупреждение `stock_missing` («истории по этому имени нет»), а не пустой ответ молчанием.
- `SyncStaleService`: крон `new Cron("*/30 * * * *", { timezone: TZ }, …)` в `onModuleInit`, `stop()` в `onApplicationShutdown` — образец `ShrinkageService:216-229`. Внутри `check`: последний `vendingSyncRun` со `status='success'` (тот же запрос, что в `ourvend-health.service.ts:114-121`), `staleHours(...)` из shared, порог `readIntSetting(this.db, "SYNC_STALE_HOURS", SYNC_STALE_HOURS_FALLBACK, this.logger)`. Условие тревоги: `staleHours === null || staleHours >= threshold` — «успехов не было вовсе» тревожнее, чем «успех был давно», и молчать об этом нельзя. Дедуп — дословно приёмом `сериюОтказовВСобытие` (`vending.service.ts:2870-2876`): `event` по `type` + `gte(occurredAt, tashkentDayStartOf(now))`. Payload: `{ hoursSinceSuccess, lastSuccessAt, lastRunStatus }`.
- `OurvendHealthService`: `staleHours` и `staleThresholdH` в ответе; порог — ещё один пункт в существующий `Promise.all`.
- Правило в `rules.ts` — рядом с `ourvend.sync_failed_streak` (~стр. 422), `urgency: "immediate"`.

- [ ] **Step 1: Тесты RED.**
```ts
// packages/shared/src/vending-reports.test.ts — дописать
describe("Давность успешного сбора (R-P8a-6)", () => {
  const t = new Date("2026-08-25T13:00:00+05:00");
  it("часы считаются до десятой, назад во времени не уходят", () => {
    assert.equal(staleHours("2026-08-25T06:00:00+05:00", t), 7);
    assert.equal(staleHours("2026-08-25T14:00:00+05:00", t), 0); // часы агента впереди базы
  });
  it("успехов не было — null, а не ноль часов", () => {
    assert.equal(staleHours(null, t), null);
  });
});

// apps/core/src/vending/vending.service.test.ts — рядом с набором про ingestStock
it("пересчёт склада пишет строку истории на каждую применённую позицию (R-P8a-3)", async () => {
  const { svc, м } = стендСклада();
  await svc.ingestStock({ countedAt: "2026-08-25T09:34:00+05:00", items: [{ product: "Montella pet 0.33", quantity: 7 }] }, "owner");
  const [строка] = м.inserted.vending_stock_count;
  assert.deepEqual([строка.source, строка.dt, строка.qty, строка.extId, строка.note], ["own", "2026-08-25", "7", null, "owner"]);
});
it("опоздавший пересчёт не оставляет следа в истории: он не изменил и остаток", async () => {
  const { svc, м } = стендСклада({ countedAt: new Date("2026-08-25T10:00:00+05:00") });
  await svc.ingestStock({ countedAt: "2026-08-25T09:00:00+05:00", items: [{ product: "Montella pet 0.33", quantity: 1 }] });
  assert.equal(м.inserted.vending_stock_count.length, 0);
});

// apps/core/src/ourvend/sync-stale.service.test.ts
describe("Сторож «нет успешного прогона» (R-P8a-6)", () => {
  const сейчас = new Date("2026-08-25T13:00:00+05:00");
  it("5 часов при пороге 6 — тишина", async () => {
    const { svc, события } = стенд({ lastSuccessAt: "2026-08-25T08:00:00+05:00" });
    assert.equal((await svc.check(сейчас)).emitted, false);
    assert.equal(события.length, 0);
  });
  it("7 часов — событие с давностью, моментом и статусом последнего прогона", async () => {
    const { svc, события } = стенд({ lastSuccessAt: "2026-08-25T06:00:00+05:00", lastRunStatus: "failed" });
    assert.equal((await svc.check(сейчас)).emitted, true);
    assert.deepEqual(события[0].type, "ourvend.sync_stale");
    assert.deepEqual(события[0].payload, { hoursSinceSuccess: 7, lastSuccessAt: "2026-08-25T01:00:00.000Z", lastRunStatus: "failed" });
  });
  it("успехов не было вовсе — тревога, а не «ноль часов, всё хорошо»", async () => {
    const { svc, события } = стенд({ lastSuccessAt: null });
    assert.equal((await svc.check(сейчас)).emitted, true);
    assert.equal(события[0].payload.hoursSinceSuccess, null);
  });
  it("повтор в те же ташкентские сутки — молчание, следующие сутки — снова событие", async () => {
    const { svc, события } = стенд({ lastSuccessAt: "2026-08-25T06:00:00+05:00", уже: [{ type: "ourvend.sync_stale", occurredAt: new Date("2026-08-25T09:00:00+05:00") }] });
    assert.equal((await svc.check(сейчас)).emitted, false);
    assert.equal((await svc.check(new Date("2026-08-26T13:00:00+05:00"))).emitted, true);
    assert.equal(события.length, 1);
  });
  it("порог берётся из настройки, а не из константы", async () => {
    const { svc } = стенд({ lastSuccessAt: "2026-08-25T08:00:00+05:00", настройки: { SYNC_STALE_HOURS: "4" } });
    assert.equal((await svc.check(сейчас)).emitted, true);
  });
});

// apps/core/src/rules/rules.test.ts — рядом с набором про sync_failed_streak
it("застой сбора будит немедленно и называет число часов", () => {
  const [n] = applyRules(ctx("ourvend.sync_stale", { hoursSinceSuccess: 7, lastSuccessAt: "2026-08-25T01:00:00.000Z", lastRunStatus: "failed" }));
  assert.equal(n!.urgency, "immediate");
  assert.match(n!.text, /Сбор OurVend.*7 ч/);
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → RED.
- [ ] **Step 3: Реализация.** `staleHours` и два поля `OurvendHealth` — в `vending-reports.ts` (там же, где живёт остальная форма отчёта; третьей копии расчёта быть не должно). `SyncStaleService` — новый файл в `apps/core/src/ourvend/`, провайдер регистрируется в `VendingModule` рядом с `OurvendHealthService`, по той же причине, что описана в шапке модуля (иначе `OurvendModule` и `VendingModule` начали бы импортировать друг друга). Шапка сервиса объясняет, чем он отличается от `ourvend.sync_failed_streak`: streak — «сбор идёт, но подряд падает»; stale — «сбор не бежит вовсе» (контейнер агентов лёг, крон не встал), и `finishSyncRun` в этом случае не зовётся НИКОГДА, то есть streak-детектор физически не сработает. Сервис НЕ зовёт `OurvendHealthService.health()`: там внутри весь сырой SQL паритета, и гонять его каждые 30 минут ради одной даты — плата ни за что, плюс падение паритета погасило бы сторожа.
- [ ] **Step 4: DTO и роут.** `StockCountsDto` рядом с `ShrinkageDto`: `days?: number` (`@Transform` гасит пустую строку — как в `OurvendHealthDto`, `@IsInt() @Min(1) @Max(365)`), `product?: string` (`@IsString() @MaxLength(512)`). Роут — `@Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } }) @Get("stock-counts")`, `days ?? 90`. `IngestStockDto` получает `@IsOptional() @IsUUID() personId?: string` (панель и бот сегодня его не шлют — тогда NULL; проводка бота — не этот срез).
- [ ] **Step 5: Смоук.** В `ЧТЕНИЕ` (`tools/smoke-core.mjs`, рядом с `/vending/refill-events`): объект с проверкой для `/vending/stock-counts?days=90` (`rows` и `warnings` — массивы) и `/ourvend/health?runs=20` уже есть — дописать в его `проверить`, что `staleThresholdH` — число, а `staleHours` — число или `null` (ключ обязан присутствовать: пропущенный ключ витрина прочтёт как «поле не приехало»). В `ЗАПИСЬ`, в шаг «склад: повторный пересчёт — ссылка на карточку уцелела», в `после` дописать: `GET /vending/stock-counts?product=<P4_ТОВАР>` возвращает ровно ДВЕ строки (два пересчёта подряд), обе `source: "own"` — это проверка того самого частичного уникального индекса против настоящего Postgres.
- [ ] **Step 6:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → GREEN.
- [ ] **Step 7:** `git commit -m "feat(core): история пересчётов склада, GET /vending/stock-counts и сторож застоя сбора OurVend (П8a)" -- packages/shared/src/vending-reports.ts packages/shared/src/vending-reports.test.ts apps/core/src/vending apps/core/src/ourvend apps/core/src/rules tools/smoke-core.mjs`

---

### Task 5: Бот и панель — застой сбора виден там же, где здоровье

**Files:** Modify `apps/bot/src/analytics-brief.ts` (`состояниеСбора`/`formatOurvendHealth` ~стр. 685–790) и `apps/bot/src/analytics-brief.test.ts`; `apps/cc/src/components/ourvend-health-view.tsx` (~стр. 82–145) и `ourvend-health-view.test.tsx`; `packages/shared/src/vending-reports-contracts.test.ts` (фикстура `ЗДОРОВЬЕ` ~стр. 17).

**Interfaces (consumes `@mydon/shared`, produces):**
```ts
/** apps/bot/src/analytics-brief.ts */
/** «⛔ сбор стоит N ч» — или `null`, когда сбор в норме (R-P8a-6). */
export function строкаЗастоя(h: OurvendHealth): string | null;
/** apps/cc/src/components/ourvend-health-view.tsx */
export function OurvendHealthCard({ health }: { health: OurvendHealth }): JSX.Element;
```
Реэкспорта добавлять НЕ нужно: `apps/bot/src/core-client.ts:8` и `apps/cc/src/lib/core.ts:319` уже реэкспортируют `OurvendHealth` из `@mydon/shared` — новые поля доезжают компилятором, а не правкой зеркала. HELP бота не меняется: «сверка» уже в списке (`handler.ts:132`), новая строка появляется внутри её ответа.

- [ ] **Step 1: Тесты.**
```ts
// packages/shared/src/vending-reports-contracts.test.ts — фикстура ЗДОРОВЬЕ
  staleHours: 7,
  staleThresholdH: 6,
// и проверка рядом с прочими:
it("здоровье несёт давность успеха и порог — витрины не заводят своей шестёрки", () => {
  assert.equal(typeof ЗДОРОВЬЕ.staleThresholdH, "number");
  const пусто: OurvendHealth = { ...ЗДОРОВЬЕ, lastSuccessAt: null, staleHours: null };
  assert.equal(пусто.staleHours, null); // «успехов не было» — не «0 ч»
});

// apps/bot/src/analytics-brief.test.ts
describe("«сверка»: застой сбора (R-P8a-6)", () => {
  const h = (over: Partial<OurvendHealth>): OurvendHealth => ({ ...ЗДОРОВЬЕ_ФИКСТУРА, ...over });
  it("за порогом — строка ⛔ с числом часов", () => {
    assert.match(строкаЗастоя(h({ staleHours: 9, staleThresholdH: 6 }))!, /⛔ сбор стоит 9 ч/);
  });
  it("ровно на пороге — уже тревога (≥, а не >)", () => {
    assert.ok(строкаЗастоя(h({ staleHours: 6, staleThresholdH: 6 })));
  });
  it("в норме — строки нет вовсе, а не «застоя нет»", () => {
    assert.equal(строкаЗастоя(h({ staleHours: 1.2, staleThresholdH: 6 })), null);
  });
  it("успехов не было — тревога, и сказано именно это", () => {
    assert.match(строкаЗастоя(h({ staleHours: null, lastSuccessAt: null }))!, /успешных прогонов не было/);
  });
  it("строка стоит в ответе «сверки» сразу после состояния сбора", () => {
    const [первое] = formatOurvendHealth(h({ staleHours: 9 }));
    assert.match(первое, /⛔ сбор стоит 9 ч/);
  });
});

// apps/cc/src/components/ourvend-health-view.test.tsx
it("застой поднимает общую тревогу секции и пишется отдельной строкой", () => {
  render(<OurvendHealthCard health={{ ...ЗДОРОВЬЕ, staleHours: 9, staleThresholdH: 6, failedStreak: 0 }} />);
  expect(screen.getByText("тревога")).toBeInTheDocument();
  expect(screen.getByText(/сбор стоит 9 ч/)).toBeInTheDocument();
});
it("сбор свежий — бейджа застоя нет", () => {
  render(<OurvendHealthCard health={{ ...ЗДОРОВЬЕ, staleHours: 1.2, staleThresholdH: 6 }} />);
  expect(screen.queryByText(/сбор стоит/)).toBeNull();
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter bot build && pnpm --filter bot test && pnpm --filter cc test` → RED.
- [ ] **Step 3: Реализация.** В боте `строкаЗастоя` живёт рядом с `состояниеСбора` и вставляется в `formatOurvendHealth` первой строкой массива `lines` (перед состоянием и последним успехом): владелец, открывший «сверку», должен увидеть «сбор стоит» до всего остального, а не третьей строкой под таблицей прогонов. Порог берётся из `h.staleThresholdH`, не из `LAG_ALERT_H` — и комментарий рядом объясняет, что `LAG_ALERT_H` про свежесть СНИМКОВ, а не про застой сбора, и совпадение чисел (6 и 6) случайно. В панели: `застой = health.staleHours === null || health.staleHours >= health.staleThresholdH` добавляется в условие `тревога` (только когда журнал не пуст — пустой журнал остаётся нейтральным «не оценить») и отдельной строкой `<div className="row">` с красной пилюлей над строкой «Прогоны сбора».
- [ ] **Step 4:** `pnpm --filter bot test && pnpm --filter cc test && pnpm --filter cc build` → GREEN.
- [ ] **Step 5:** `git commit -m "feat(bot,cc): «сбор стоит N ч» в сверке и в секции здоровья сбора (П8a)" -- apps/bot/src/analytics-brief.ts apps/bot/src/analytics-brief.test.ts apps/cc/src/components/ourvend-health-view.tsx apps/cc/src/components/ourvend-health-view.test.tsx packages/shared/src/vending-reports-contracts.test.ts`

---

### Task 6: Документы, аддендум спеки и полный прогон

**Files:** Modify `docs/PLAN_STOCK_ABSORPTION.md` (§П8, п. 1, ~стр. 370–379), `docs/DATA_SOURCES.md` (после абзаца «OurVend: дневной поток…», ~стр. 898), `docs/DEPLOY.md` (раздел «Миграции», ~стр. 89–94), `docs/superpowers/specs/2026-08-25-p8a-stock-history-design.md` (аддендум в конец).

- [ ] **Step 1:** `PLAN_STOCK_ABSORPTION.md` §П8 п. 1 переписать с фактическими числами донора и статусом: «**закрыто срезом П8a (2026-08-2x)**: `purchases` 342 — зеркало 1:1, сверено по `ext_id` и заморожено; `refills` 455 → импортированы 107 по живым автоматам (Olma 88, American Hospital 19), 348 на виртуальных «общих» аппаратах остались в архивном дампе; `stock_counts` 603 → импортированы 460 складских в `vending_stock_count` (0069), 143 машинные не импортированы (конфликт ключа с `machine_stock` за 17.07); ручные `sales` 1 (тест, amount 0) и `ourvend_sales` 1042 / `ourvend_machine_stock` 2788 — уже зеркалятся, не трогали». Отдельной строкой — «памятные 331/348/361/531 устарели: у донора 342/455/603/0, инкассаций в доноре нет вовсе». `OURVEND_EPOCH` — пометить как документ, а не переменную (R-P8a-4).
- [ ] **Step 2:** `docs/DATA_SOURCES.md` — новый подраздел «История склада вендинга»: откуда взялись строки до 2026-01-01 (ручная история напитков 2025, 158 закупок с `unit_price = 0` — это «цены НЕТ», а не «бесплатно»; отчёт по себестоимости 2025 соврёт, если считать нулём), что `vending_stock` остаётся перезаписным «сейчас», а история живёт в `vending_stock_count`, и что 14 имён истории не имеют карточки в каталоге OurVend и лежат сырыми с `product_id = NULL`.
- [ ] **Step 3:** `docs/DEPLOY.md`, раздел «Миграции» — блок про разовый перенос:
```bash
docker exec -i mydon-core node packages/db/dist/import-stock-history.js --dry-run </dev/null
docker exec -i mydon-core node packages/db/dist/import-stock-history.js --apply   </dev/null
docker exec mydon-stock-db-1 pg_dump -U mydon mydon | gzip > /opt/backups/stock-archive/$(date +%F).sql.gz
```
с подписью: скрипт идемпотентен, автодеплой его НЕ запускает, порядок обязателен (сначала отчёт, потом запись, потом архив), а `</dev/null` стоит потому, что без него шаг висит на открытом stdin.
- [ ] **Step 4:** Аддендум к спеке — три отклонения из Global Constraints (колонка `vending_refill.source` уже была; оба UNIQUE частичные из-за законных дублей донора; `staleHours: number | null` + `staleThresholdH`) плюс два уточнения способа запуска: команда запуска — `docker exec -i mydon-core` (конвенция `DEPLOY.md:89`), а не `docker compose run --rm`; отдельного события `stock.refill.aggregate` (рекомендация `inventory-donor.md` §5) не заводим — спека знает одну отметку `stock.history.imported`, а 348 «общих» заливов живут в архивном дампе.
- [ ] **Step 5: Полный прогон:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`; смоук на scratch-БД: `createdb mydon_p8a` → `node packages/db/dist/migrate.js` → `seed.js` → `seed-vending.js` → `backfill-product-ids.js` → `node tools/smoke-import.mjs` → `node tools/smoke-core.mjs` → `node tools/smoke-panel.mjs` → `dropdb mydon_p8a`.
- [ ] **Step 6:** `git commit -m "docs(p8a): история склада в плане поглощения, источниках и рунбуке выкатки" -- docs/PLAN_STOCK_ABSORPTION.md docs/DATA_SOURCES.md docs/DEPLOY.md docs/superpowers/specs/2026-08-25-p8a-stock-history-design.md docs/superpowers/plans/2026-08-25-sloy-P8a-istoriya-sklada.md`

---

## Выкатка (спека §6)

> **Единственные записи на проде — шаги 3 и 4.** Всё остальное — чтение. Донор (`mydon-stock`) в этом срезе НЕ ПИШЕТСЯ ни разу: `STOCK_DATABASE_URL` открывается только на чтение, и гашение его — П8, не здесь.

1. **PR** `feat/p8a-stock-history` → CI (lint · typecheck · build · test · migrations на живом Postgres · smoke-import · smoke-core · smoke-panel) → squash-мерж в `main`.
2. **Автодеплой** применяет **0069**. Сверить, что выкачено именно оно: `GET /health` → `commit` совпадает с коммитом мержа (каталог обновляется за секунды, образ собирается минуты). Автодеплой скрипт импорта НЕ запускает.
3. **`--dry-run` (чтение).** `docker exec -i mydon-core node packages/db/dist/import-stock-history.js --dry-run </dev/null`. Ожидаем в отчёте:
   - заливы: найдено **455**, к записи **107**, пропущено по отсутствию серийника **348**;
   - инвентаризации склада: найдено **461**, к записи **460**, служебных **1** («Недостача (Рустам)»);
   - закупки: у нас **342**, у донора **342**, дописать **+0**, `onlyMine` **0**, расхождений **0**;
   - не разрешено имён — **≤ 14** (список из `inventory-donor.md` §2: Flash/Laimon/Moxito/Lit Energy CAN, Fresh Tag Lemonade, Lipton Lemon Tea, Red Bull CAN 0,355, Royal Pomegranate).
   Числа не сошлись — **не применять**: расхождение значит, что донор изменился после инвентаризации 25.08, и решать это данными, а не флагом.
4. **`--apply` (ЗАПИСЬ по плану).** Та же команда с `--apply`. Затем **архив (ЗАПИСЬ на ФС хоста)**: `mkdir -p /opt/backups/stock-archive && docker exec mydon-stock-db-1 pg_dump -U mydon mydon | gzip > /opt/backups/stock-archive/$(date +%F).sql.gz`; проверить размер файла (`ls -lh`) — пустой gz значит, что дамп упал, а пайп это скрыл.
5. **Проверка (чтение):**
   - `GET /vending/refills?limit=200` → **107** записей `source='stock-import'`; `GET /vending/refill-events?days=60` — событий детектора по-прежнему **7**, и все без `matched_refill_id`: матчинга задним числом нет, окна детектора (с 13.08) старше импортированных заливов (по 17.07). Это не ошибка импорта.
   - `GET /vending/stock-counts?days=400` → **460** строк `source='stock-import'`, самая ранняя `dt = 2025-08-17`.
   - `GET /vending/stock-counts?days=1` → пусто до ближайшего пересчёта; после первого пересчёта владельца — **20** строк `source='own'` (столько позиций в `vending_stock`).
   - `GET /ourvend/health` → `staleHours` < 6 и `staleThresholdH` = 6; в боте «сверка» строки «⛔ сбор стоит» нет.
   - `purchase` по-прежнему **342** (`GET /supply/summary` не изменился) — R-P8a-1 соблюдён.
6. **Наблюдение:** порог правится в панели «Система» (`SYNC_STALE_HOURS`) и применяется без рестарта. Первое `ourvend.sync_stale` за сутки уходит владельцу немедленно; повтор в те же ташкентские сутки — молчит. Числа донора для памяти: **342 / 455 / 603 / 0**; §П8 п. 1 — закрыт.

## Самопроверка плана

**Покрытие рулингов спеки:**

| Рулинг | Где закрыт | Чем проверен |
|---|---|---|
| R-P8a-1 ничего не переимпортировать, сверка по `ext_id` | T2 `reconcilePurchases`, T3 (дописывается только `missing`) | T2 «недостающая строка», «расхождение названо, но правкой не становится», «наши строки без близнеца»; T3 «закупки: недостающая дописывается»; выкатка шаг 5 (`purchase` = 342) |
| R-P8a-2 заливы: 107, `client_key`, канон серийника, полдень | T2 `mapRefill`, T3 вставка с `onConflictDoNothing(clientKey)` | T2 «серийник приведён к канону, момент — полдень», «общий аппарат не импортируется», «дубль остаётся дублем»; выкатка шаг 3 (455/107/348) |
| R-P8a-3 таблица истории + `ingestStock` пишет сам | T1 (0069, страж-тест), T4 (`ingestStock`, `stockCounts`) | T1 «момент пересчёта и его сутки»; T4 «пересчёт пишет строку истории», «опоздавший пересчёт не оставляет следа»; смоук «две строки own» |
| R-P8a-4 `OURVEND_EPOCH` — документ, не код | T6 (`DATA_SOURCES.md`, `PLAN_STOCK_ABSORPTION.md`) | ревью: `grep -r EPOCH apps packages` не даёт ни одного вхождения после среза |
| R-P8a-5 архив донора, одна отметка в `event` | T3 (событие `stock.history.imported`), выкатка шаг 4 (`pg_dump`) | T3 «--apply оставляет одну отметку»; аддендум спеки (почему нет `stock.refill.aggregate`) |
| R-P8a-6 сторож «нет успешного прогона» | T1 (`SYNC_STALE_HOURS`), T4 (`SyncStaleService`, `staleHours`, правило), T5 (бот, панель) | T1 «дефолт 6, ноль отвергается»; T4 «5 ч → тишина», «7 ч → событие», «успехов не было», «повтор в сутки», «порог из настройки», правило `immediate`; T5 «⛔ сбор стоит 9 ч», «ровно на пороге», «бейджа нет» |
| R-P8a-7 точное сопоставление имён + декод HTML | T2 `decodeHtml`/`canonicalProductName`/`SERVICE_PRODUCT_NAMES` | T2 «энтити декодируются», «один проход», «[слит→N] снимается», «канона нет — сырое имя», «Недостача (Рустам) — служебная»; T3 «нерешённые имена названы поимённо» |
| R-P8a-8 идемпотентность `--dry-run`/`--apply` | T3 (флаги, `onConflictDoNothing`, `written` по `returning()`), smoke-import | T3 «--dry-run не пишет ничего», «повторный --apply: 0 новых»; `tools/smoke-import.mjs` (второй прогон против настоящего Postgres) |
| R-P8a-9 чего в срезе нет | Global Constraints, T6 | ревью: `STOCK_DATABASE_URL` в коде не гасится, панельного листа истории нет, `collection` не трогается |

**Согласованность имён типов между задачами:** `DonorRefillRow`/`DonorStockCountRow`/`DonorPurchaseRow`, `CanonIndex`, `Mapped<T>`/`Unresolved`, `VendingRefillInsert`/`VendingStockCountInsert`, `PurchaseFacts`/`PurchaseDiff`/`PurchaseReconcile` объявлены ровно один раз — в `packages/shared/src/stock-history.ts` (T2), и в T3 только импортируются. `DonorReader`/`ImportSection`/`StockHistoryReport` — форма разового скрипта, а не отчёта, и живут в `packages/db/src/import-stock-history.ts` (T3). `StockCountRow`/`StockCountsReport`, `staleHours()` и новые поля `OurvendHealth` — в `packages/shared/src/vending-reports.ts` (T4), рядом с остальными формами HTTP-ответов; бот и панель их только реэкспортируют (`core-client.ts:8`, `lib/core.ts:319`), своих копий не заводят. Имя `StockLevelRow` уже занято ДВАЖДЫ и по-разному (`vending.service.ts` — строка склада; `supply.service.ts` — строка донора `ourvend_machine_stock`); новый тип назван `StockCountRow`, а не третьим `StockLevelRow`.

**Известные риски исполнения:** (1) `apps/core/src/vending/vending.service.ts` — файл на 3000 строк, T4 правит его в трёх местах; якоря брать по именам методов, а не по номерам строк. (2) Общий worktree с Codex: перед правкой дерева сверять `mtime` чужих файлов и коммитить только своими путями (`git commit -- …`). (3) Донор мог измениться после инвентаризации 25.08 — расхождение чисел в `--dry-run` останавливает выкатку, а не «поправляется флагом». (4) `pnpm -s build` обязателен ПЕРЕД `test` в db/core/bot: наборы гоняются по `dist`, и правка в `packages/shared` без пересборки даст зелёный тест на старом коде.
