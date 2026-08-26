# Гигиена снек-контура — план реализации (4 задачи, одна параллельная волна)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Четыре долга, которые предыдущие срезы записали в бэклог сами, закрываются кодом. Правило «сырое имя товара → карточка прайса» перестаёт жить в трёх реализациях и получает ОДНУ дверь `resolveCatalogName` с явным «спором»; вставка задач обслуживания перестаёт падать `42P10` на КАЖДОЙ попытке (в проде не поставлено ни одной задачи ТО за всё время, сегодня падало бы 19 раз); сторож свежести учётного снапшота начинает работать в ДЕЙСТВУЮЩЕМ режиме `stock`, где он был выключен ранним `return`; дата последнего красного дня паритета приезжает полем `/ourvend/health` вместо второго HTTP-раунда, который на отказе молча съедал строку.

**Architecture:** Ничего нового не заводится там, где есть готовое. Правило каталога уже реализовано ОДИН раз (`productIndex.explain` в `@mydon/shared`) — задача 1 не пишет второе, а делает его единственной дверью и переводит на неё живой Core; импорт истории донора при этом не меняется НИ НА СТРОКУ, потому что `canon`/`id` индекса переписаны через ту же дверь. Дедуп задач ТО держится СУЩЕСТВУЮЩИМ частичным индексом `task_source_key` — чинится спецификация конфликта, а не схема: миграций в срезе НЕТ. Сторож снапшота теряет ровно один `return`; порог, вердикт, дедуп и разбивка `which` не трогаются. Здоровье сбора уже СЧИТАЕТ `lastRed`/`since` внутри своего `Promise.all` и выбрасывает их — задача 4 стоит ноль новых запросов и расширяет JSON аддитивно, а роут `/ourvend/parity/streak` остаётся жив ради `days[]`.

**Tech Stack:** TypeScript strict, NestJS 11 + class-validator, Drizzle 0.45.2 / Postgres (**миграций ноль**), `croner` с `timezone: TZ`, `node:test` + `node:assert/strict` по dist (core/bot/shared/db/agents) + vitest с Testing Library (cc), `tools/smoke-core.mjs` против живого Postgres, Telegram-бот, Next.js App Router (панель — только чтение).

**Spec:** `docs/superpowers/specs/2026-08-26-gigiena-snek-design.md` (рулинги R-G-1…R-G-6)
**Опись:** `.superpowers/sdd/2026-08-26-sloy-gigiena/inventory.md` — каталог `.superpowers/` не версионируется; опись лежит в этом же worktree (`~/Developer/mydon-gigiena/.superpowers/sdd/2026-08-26-sloy-gigiena/`).

> **Волна параллельная, файлы РАЗДЕЛЕНЫ (R-G-5).** Четыре задачи независимы и делаются одновременно. Ни один файл не принадлежит двум задачам — списки `Files` ниже ПОЛНЫЕ, матрица пересечений в самопроверке. Если задача упирается в чужой файл, это не повод его тронуть: это повод остановиться и сказать об этом.

## Global Constraints

Копия §4 спеки плюс то, что связывает несколько задач сразу. Нарушение здесь — не стилевая правка: срез трогает ГОРЯЧИЙ путь ингеста снека (резолв имени зовут шестнадцать мест, включая запись `vending_stock` из бота) и вставку, которая после фикса начнёт наконец писать в `task`.

- **R-G-1 Одна дверь к правилу каталога.** `resolveCatalogName(index, raw)` в `packages/shared/src/stock-history.ts`; приоритет «ТОЧНОЕ имя карточки > алиас», сравнение по `normalizeProductName`, спор возвращается явно, пустое имя → `miss`. Имя НЕ `resolveProductName` — оно занято донорским мостом (`stock-history.ts:286`). Обёртка `VendingService.resolveProduct` ОБЯЗАНА сохранить `miss → raw`: верни она `null` или пустую строку — шестнадцать вызывающих начнут писать имена, которых нет.
- **R-G-2 Конфликт вставки — по `source` С ПРЕДИКАТОМ.** `onConflictDoNothing({ target: task.source, where: TASK_SOURCE_DAY_PREDICATE })`, где предикат — ОДНО значение, экспортированное из `packages/db/src/schema.ts` и используемое самим индексом. Не `client_key`: его смысл — ретрай клиента, на нём держится `create()`, а частичный индекс по `source` всё равно ответил бы `23505` на дубле. Ответ роута НЕ меняется: идемпотентный 200 с пустым телом уже спроектирован.
- **R-G-3 Сторож — в обоих режимах, поле витрины — own-only.** `checkSnapshot` теряет ранний `return`; `OurvendHealth.snapshotStale` остаётся `источник === "own" && …`. Различие записывается докстрингом ПО ОБЕ СТОРОНЫ: сторож про АГЕНТА (приносит ли `ourvend:accounting` снимок), поле про УЧЁТ (остановился ли он от этого).
- **R-G-4 Два поля, не второй запрос.** `parityLastRed`/`parityStreakSince` с префиксом `parity*` (голое `since` в плоском здоровье читается как «здоровье с такого-то момента»). `GET /ourvend/parity/streak` НЕ удаляем — он несёт `days[]`.
- **R-G-5 Раздел файлов волны.** См. «Карта файлов». Два ключа смоука для T4 — интеграционный коммит волны, а не T4.
- **R-G-6 Охват — четыре задачи.** Вне: потолок задач за прогон (П7), правило по `maintenance.monitor_failed`, кофейный резолвер (`norm-fact.service.ts:402`), резолвер продаж (`sales.service.ts:518-666`), удаление роута серии.
- **Время.** Только `packages/shared/src/tashkent-time.ts`; голые сутки — `YYYY-MM-DD`; кроны — `{ timezone: TZ }`. `now` — параметр, а не `Date.now()` внутри; кеши, ключуемые временем, `now` пробрасывают.
- **ПОКАЗ ≠ РЕШЕНИЕ.** С порогом сравниваются сырые часы (`rawStaleHours`, `snapshotStaleVerdict`), владельцу уходит округление до 0.1 ч.
- **Настройки** — только через `config-spec.ts`; в срезе новых нет, ни одного нового `process.env` в Core.
- **`@Throttle`** — только именованные `burst`/`sustained`; новых роутов нет, троттлы существующих не трогаем.
- **Мутации — под `ServiceTokenGuard`**, чтения внутри сети открыты; смоук шлёт `x-service-token`.
- **TS strict, без `any`.** Русский в UI, тестах и документации; идентификаторы английские, экспортируемые имена общего слоя — латиницей.
- **Ноль ≠ «всё хорошо»:** пустая выборка объясняется словами, а не зелёной галкой.
- **Комментарий объясняет ПОЧЕМУ** и называет отвергнутую альтернативу; факт, добытый прод-замером, помечается прямо в коде.
- **`@mydon/shared` не знает ни о `@mydon/db`, ни о Nest.**
- **Документация правится ВНУТРИ своей задачи** (`docs/DATA_SOURCES.md` — T1, `docs/FIELD_OPS_SPEC.md` — T2, `docs/DEPLOY.md` + `docs/PLAN_STOCK_ABSORPTION.md` — T3), а не отдельным коммитом в конце.
- **Записей в прод из задач плана — НИ ОДНОЙ.** ≈19 задач ТО появятся САМИ, первым прогоном агента (06:00 Ташкент) после деплоя — это ожидаемый результат фикса, и владельца о нём предупреждают ЗАРАНЕЕ (выкатка §7). Примерку бэкфилла (`--dry-run`, только чтение) делает владелец руками.
- **Тесты по dist:** `pnpm --filter @mydon/shared build` ПЕРЕД `pnpm --filter core test` / `bot test` / `@mydon/db test`; `pnpm --filter cc test` — vitest. Существующие наборы остаются зелёными.
- **Миграций НЕТ.** Единственная правка схемы (T2) DDL не меняет; `pnpm --filter @mydon/db db:generate` обязан сказать «No schema changes». Предложил файл — предикат разошёлся с `0040`, это ошибка правки.
- **Коммиты.** Ветка `fix/gigiena-snek` (от `main` b3b595d + коммит спеки). Коммитим ТОЛЬКО свои пути: `git commit -m "…" -- <путь> <путь>`; `git add -A` / `git commit -a` утащат чужое (Codex работает на тех же репозиториях — перед правкой дерева сверять `mtime`). Conventional Commits + трейлеры `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` и `Claude-Session: …`. Push только в свою ветку: после `git checkout main` ПЕРВОЙ командой `git checkout -b` — фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты.

## Уточнения к описи (проверено в дереве, план идёт по ним)

Пять мест, где опись расходится с рабочим деревом. Смысл рулингов не меняется — меняются адреса и числа, по которым реализующий будет искать код.

1. **Вызовов `resolveProduct` в `vending.service.ts` — 15, а не 14.** Опись пропустила `:1412` (схлопывание позиций по канону внутри `ingestStock`). Плюс `analytics.service.ts:480` и путь через `resolveProductRef` из `refill.service.ts:65` — итого семнадцать точек, и все они закрываются ОДНОЙ заменой типа параметра (см. T1 Step 4).
2. **Печать строки про красный день в боте — `analytics-brief.ts:932`, а не `:939`.** По `:939` лежит строка списка отказов. Сигнатура (`:909`) и `строкаКрасногоДня` (`:833`) — как в описи.
3. **`sync-stale.service.test.ts:299` (`СЕРИЯ_ПУСТО`) — это фикстура `ParityStreak`, а не `OurvendHealth`.** У неё `lastRed`/`since` УЖЕ есть, править её не надо: T4 её не касается, и файл целиком остаётся за T3. Литералов `OurvendHealth`, которым нужны два новых поля, — **девять файлов** (список в T4 Step 5): `ourvend-health.service.test.ts` строит здоровье СЕРВИСОМ и литерала не содержит, а `bot.test.ts:680` держит свободный `as unknown as`-каст без этих полей — ему новые ключи не нужны, меняется только его тест про второй роут.
4. **`docs/AGENTS.md` в репозитории НЕТ.** Монитор графиков документирован в `docs/FIELD_OPS_SPEC.md` §6.7 (`:2441`) и упомянут в `docs/DEPLOY.md:553`. Доку правит T2 в `FIELD_OPS_SPEC.md`; `DEPLOY.md` занят T3 (там строка про сторож снапшота).
5. **Строка примерки бэкфилла — `обновилось БЫ N`** (`backfill-product-ids.ts:325`), с прописной «БЫ». Чек-лист выкатки цитирует её дословно, иначе владелец будет искать в выводе строку, которой нет.

## Карта файлов

| Файл | Задача | Роль |
|---|---|---|
| `packages/shared/src/stock-history.ts` | **T1** | `CatalogResolution` + `resolveCatalogName`; `canon`/`id` индекса переписаны через них |
| `packages/shared/src/catalog-resolve.test.ts` (новый) | **T1** | правило каталога, включая два прод-ключа пересечения и три прод-имени истории |
| `packages/db/src/backfill-product-ids.ts` | **T1** | `resolveProductIds` зовёт общую дверь; блок «ИЗВЕСТНОЕ РАСХОЖДЕНИЕ» снят |
| `apps/core/src/vending/vending.service.ts` | **T1** | `loadProductIndex().catalog` вместо `aliasByKey`; `resolveProduct`, `productIdResolver`, `resolveProductRef`, `resolveSlots`, `retailFacts` |
| `apps/core/src/vending/vending.service.test.ts` | **T1** | четыре теста правила на боевом стенде |
| `apps/core/src/vending/analytics.service.ts` | **T1** | `canonOf` из `index.catalog` |
| `apps/core/src/vending/refill.service.ts` (+`refill.service.test.ts`) | **T1** | отказ на спорном имени |
| `docs/DATA_SOURCES.md` | **T1** | абзац «одно правило резолва» |
| `packages/db/src/schema.ts` (+`schema.test.ts`) | **T2** | `TASK_SOURCE_DAY_PREDICATE` — одно значение на индекс и вставку |
| `apps/core/src/tasks/tasks.service.ts` | **T2** | `onConflictDoNothing({ target, where })` |
| `apps/core/src/tasks/tasks.controller.ts` | **T2** | `@Matches` на `dayKey` |
| `apps/core/src/tasks/tasks.test.ts` | **T2** | предикат ушёл в стенд и рендерится литералом |
| `apps/core/src/tasks/tasks.controller.test.ts` (новый) | **T2** | DTO: только голые сутки |
| `apps/agents/src/maintenance-monitor.ts` (+тест) | **T2** | событие `maintenance.monitor_failed` |
| `tools/smoke-core.mjs` | **T2** | сценарий `POST /tasks/ensure-for-day` ×3 против живого Postgres |
| `docs/FIELD_OPS_SPEC.md` | **T2** | §6.7 — чем держится дедуп |
| `apps/core/src/ourvend/sync-stale.service.ts` (+тест) | **T3** | сторож в обоих режимах + якорь различия |
| `docs/DEPLOY.md`, `docs/PLAN_STOCK_ABSORPTION.md` | **T3** | снять «только в режиме `own`» |
| `packages/shared/src/vending-reports.ts` | **T4** | `parityLastRed`/`parityStreakSince` + докстринг различия у `snapshotStale` |
| `packages/shared/src/vending-reports-contracts.test.ts` | **T4** | ключ-гвард набора полей |
| `apps/core/src/ourvend/ourvend-health.service.ts` (+тест) | **T4** | два поля в `return` |
| `apps/core/src/vending/weekly-digest.service.ts` (+тест) | **T4** | фикстура `ЗДОРОВЬЕ_НЕИЗВЕСТНО` |
| `apps/bot/src/handler.ts`, `analytics-brief.ts`, `core-client.ts` (+их тесты), `weekly-digest.test.ts`, `weekly-delivery.test.ts`, `bot.test.ts` | **T4** | один запрос вместо двух |
| `apps/cc/src/lib/core.ts`, `core-types.test.ts`, `components/ourvend-health-view.tsx` (+тест) | **T4** | то же в панели |

**Матрица пересечений — пусто.** Ни один путь не встречается дважды; проверка — в самопроверке плана в конце. Три файла, которые «просятся» в две задачи, разведены рулингом R-G-5: `ourvend-health.service.ts` → T4 (T3 пишет свою половину докстринга у сторожа и якорь — в СВОЁМ тесте), `tools/smoke-core.mjs` → T2, `packages/db/*` → `schema.ts` у T2, `backfill-product-ids.ts` у T1.

---

### Task 1: Единый резолвер каталога — одно правило, одна дверь, явный спор (M, R-G-1)

**Files:** Modify `packages/shared/src/stock-history.ts` (типы `CanonAnswer`/`ProductIndex` стр. 310–330, тело `productIndex` 353–411); `packages/db/src/backfill-product-ids.ts` (шапка 46–61, `resolveProductIds` 130–155, импорт 81); `apps/core/src/vending/vending.service.ts` (`loadProductIndex` 1210–1261, `productIdResolver` 1269–1279, `resolveProductRef` 1295–1305, `resolveProduct` 1316–1318, `canonResolver` 1331–1333, `priceIndex` 1351–1360, `resolveSlots` 1373–1375, `retailFacts` 2699–2705, плюс ТРИНАДЦАТЬ мест, где карта алиасов достаётся из индекса — 961, 1166, 1297, 1331, 1351, 1396, 1774, 2128, 2335, 2616, 2705, 2758, 2844, — и ЧЕТЫРЕ сигнатуры, принимающие её параметром: `latestSold7` 1091, `loadProductIndex` 1211, `productIdResolver` 1275, `retailFacts` 2701; всего в файле 40 упоминаний `aliasByKey`, и по всем проведёт компилятор); `apps/core/src/vending/vending.service.test.ts` (стенды `readDb` 229–261, `writeDb` 176–270); `apps/core/src/vending/analytics.service.ts` (`справочник` 477–490); `apps/core/src/vending/refill.service.ts` (`create` 62–68); `apps/core/src/vending/refill.service.test.ts` (стаб 69); `docs/DATA_SOURCES.md` (абзац про резолв имён, 1075–1085). Create `packages/shared/src/catalog-resolve.test.ts`.

**Interfaces (consumes):** `normalizeProductName` (`packages/shared/src/vending-calc.ts:49`), `productIndex(products, aliases)` и `CanonAnswer`/`CanonSource` (`packages/shared/src/stock-history.ts:353`, `:314`, `:308`), `бэкфиллWhere` (`packages/db/src/backfill-product-ids.ts:212`), `Logger` Nest (`vending.service.ts:613`), `BadRequestException` (там же, импорт `:1`).

**Interfaces (produces):**
```ts
/** packages/shared/src/stock-history.ts — рядом с productIndex */

/**
 * Ответ каталога: с ИСТОЧНИКОМ решения и с явным СПОРОМ (R-G-1).
 *
 * `raw` едет и в `conflict`, и в `miss` намеренно: обе ветки печатаются
 * владельцу («это и имя карточки, и алиас другой», «карточки нет»), а второй
 * раз исходное имя ему никто не передаёт — `resolveProductIds` уже собирает
 * из него список на разбор.
 */
export type CatalogResolution =
  | { kind: "hit"; canon: string; id: string; source: CanonSource }
  | { kind: "conflict"; raw: string; byName: string; byAlias: string }
  | { kind: "miss"; raw: string };

/**
 * ЕДИНСТВЕННАЯ дверь к правилу «сырое имя → карточка прайса» (R-G-1).
 *
 * ПРАВИЛО: точное ИМЯ карточки главнее алиаса; сравнение по
 * `normalizeProductName` (ё→е, схлопывание пробелов, запятая между цифрами →
 * точка); алиас на СВОЮ ЖЕ карточку спором не считается; спор («ключ — имя
 * одной карточки и одновременно алиас другой») возвращается ЯВНО, потому что
 * `canon: null` там значил бы «карточки нет», а это другое утверждение.
 *
 * ПОЧЕМУ ДВЕРЬ, А НЕ ПРОСТО `index.explain`. Правило было реализовано трижды:
 * живой резолвер Core спрашивал АЛИАС первым (`vending.service.ts`), импорт
 * истории — имя первым, бэкфилл на споре отказывался. Расхождение было
 * записано в шапке `backfill-product-ids.ts` как долг; этот срез его закрывает,
 * и дверь нужна, чтобы у следующего вызывающего не осталось повода написать
 * свою: `explain` отдаёт ответ без исходного имени и без правила про пустую
 * строку, и каждый дописывал бы их сам.
 *
 * Пустое/пробельное имя — `miss`, а не `hit` с пустым каноном: `resolveProductIds`
 * такие строки пропускает, и «привязать пустоту» никогда не значило «нашли».
 */
export function resolveCatalogName(index: Pick<ProductIndex, "explain">, raw: string): CatalogResolution;
```
```ts
/** apps/core/src/vending/vending.service.ts */
async loadProductIndex(): Promise<{
  /** Индекс каталога — ТОТ ЖЕ, что у бэкфилла и импорта. Заменил `aliasByKey`: карта алиасов одна отвечать на вопрос «какая это карточка» не может. */
  catalog: ProductIndex;
  priceByName: Map<string, number>;
  packByName: Map<string, number>;
  rulesByName: Map<string, ProductRule>;
  productRows: ProductIndexRow[];
}>;

/** Канон имени для шестнадцати вызывающих: `hit → canon`, `conflict → byName` (+warn), `miss → raw`. */
resolveProduct(name: string, catalog: ProductIndex): string;

/** `hit → id`, спор и промах → `null`: строка с NULL чинится повторным прогоном, ошибочная привязка — нет. */
private productIdResolver(index: { catalog: ProductIndex }): (raw: string) => string | null;

/** Спорное имя — `BadRequestException`; промах — прежнее «сырое имя, `productId: null`». */
async resolveProductRef(raw: string): Promise<{ name: string; productId: string | null }>;

async retailFacts(days?: number, catalog?: ProductIndex, now?: Date): Promise<Map<string, RetailFact>>;
```

Что обязана делать реализация:
- `resolveCatalogName` НЕ содержит второй копии приоритета: она зовёт `index.explain` и добавляет то, чего у него нет, — исходное имя и правило про пустую строку. Приоритет по-прежнему живёт в одном месте, внутри `productIndex` (`stock-history.ts:390-406`), и правится там.
- `productIndex.canon` и `.id` переписываются ЧЕРЕЗ `resolveCatalogName` — так импорт истории донора (`import-stock-history.ts:215,232,248,257`) переиспользует правило, не меняясь ни на строку. **Поведение `id` на споре сохраняется прежним** (ссылка на карточку по ИМЕНИ, ту же, что вернул `canon`): иначе импорт записал бы `product_name` одной карточки и `product_id = NULL`, то есть строку, противоречащую самой себе.
- `loadProductIndex()` отдаёт `catalog` **вместо** `aliasByKey`, а не рядом с ним. Именно замена: пока поле есть, компилятор не покажет ни одного места, где канон считается мимо карточек, — а таких мест тринадцать плюс четыре сигнатуры.
- `resolveProduct` на споре пишет `logger.warn` с обоими именами. На проде споров 0; появление первого обязано быть видно, а не молча решено в пользу карточки.
- `resolveProductRef` перестаёт делать SELECT по имени: `id` приезжает из индекса. Это минус один запрос на КАЖДУЮ заливку из бота.
- Ни один вызывающий не меняет своего поведения на `miss`: `resolveProduct` возвращает `raw` ровно как раньше (`aliases.get(...) ?? name`).

- [ ] **Step 1: Тесты RED — правило каталога.**
```ts
// packages/shared/src/catalog-resolve.test.ts — новый файл
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productIndex, resolveCatalogName, type AliasRow, type ProductRow } from "./stock-history";

/**
 * Правило каталога живёт в `stock-history.ts` рядом с индексом (выносить его в
 * свой модуль значило бы завести пару «значение туда, типы обратно» ради
 * двадцати строк фасада), но тесты у него СВОИ: `stock-history.test.ts` — про
 * донорский импорт, а это правило теперь исполняет и живой Core на горячем
 * пути ингеста снека.
 */
const карточка = (id: string, name: string): ProductRow => ({ id, name });
const алиас = (productId: string, alias: string): AliasRow => ({ productId, alias });

describe("Резолв каталога: имя карточки главнее алиаса (R-G-1)", () => {
  it("точное имя карточки бьёт алиас, указывающий на ЧУЖОЙ товар", () => {
    // Раньше живой резолвер спрашивал алиас первым, и строка с именем
    // карточки B молча уезжала на карточку A. Имя — то, что владелец видит в
    // прайсе; алиас — вспомогательное написание, перекрывать им прямое
    // попадание нельзя.
    const индекс = productIndex(
      [карточка("p1", "Fanta CAN 0,25"), карточка("p2", "Sprite CAN 0,25")],
      [алиас("p2", "Fanta CAN 0,25")],
    );
    assert.deepEqual(resolveCatalogName(индекс, "Fanta CAN 0,25"), {
      kind: "conflict",
      raw: "Fanta CAN 0,25",
      byName: "Fanta CAN 0,25",
      byAlias: "Sprite CAN 0,25",
    });
  });

  it("алиас на СВОЮ же карточку спором не считается — обе дороги ведут в одно место", () => {
    const индекс = productIndex([карточка("p1", "Coca-Cola Classic 0,5")], [алиас("p1", "Coca-cola classic 0,5")]);
    const о = resolveCatalogName(индекс, "coca-cola  CLASSIC 0,5");
    assert.deepEqual(о, { kind: "hit", canon: "Coca-Cola Classic 0,5", id: "p1", source: "name" });
  });

  it("алиаса хватает, когда имени карточки нет: источник назван «alias»", () => {
    const индекс = productIndex([карточка("p1", "Montella Вода минеральная 330ml")], [алиас("p1", "18+")]);
    assert.deepEqual(resolveCatalogName(индекс, "18+"), {
      kind: "hit",
      canon: "Montella Вода минеральная 330ml",
      id: "p1",
      source: "alias",
    });
  });

  it("промах несёт СЫРОЕ имя — из него владельцу собирают список на разбор", () => {
    const индекс = productIndex([карточка("p1", "Snickers")], []);
    assert.deepEqual(resolveCatalogName(индекс, "Пирожок с чем-то"), { kind: "miss", raw: "Пирожок с чем-то" });
  });

  it("пустое и пробельное имя — промах, а не карточка с пустым каноном", () => {
    const индекс = productIndex([карточка("p1", "Snickers")], []);
    assert.equal(resolveCatalogName(индекс, "").kind, "miss");
    assert.equal(resolveCatalogName(индекс, "   ").kind, "miss");
  });

  it("алиас на удалённый товар в индекс не попадает — привязывать к чему попало нельзя", () => {
    const индекс = productIndex([карточка("p1", "Snickers")], [алиас("p-нет", "Сникерс")]);
    assert.equal(resolveCatalogName(индекс, "Сникерс").kind, "miss");
  });

  it("нормализация одна на всех: запятая, «ё», лишние пробелы, регистр", () => {
    const индекс = productIndex([карточка("p1", "Fanta CAN 0,25"), карточка("p2", "Тёплый чай 0,5")], []);
    for (const raw of ["Fanta CAN 0.25", "fanta  can 0,25", " Fanta CAN 0,25 "]) {
      assert.equal(resolveCatalogName(индекс, raw).kind, "hit", raw);
    }
    const чай = resolveCatalogName(индекс, "Теплый  чай 0.5");
    assert.equal(чай.kind === "hit" ? чай.canon : null, "Тёплый чай 0,5");
  });
});

describe("Резолв каталога: прод-данные 26.08.2026", () => {
  /**
   * ОБА ключа-пересечения прода: нормализованный ключ алиаса равен ключу имени
   * карточки. Замер 26.08: таких ключей ровно два, и оба указывают на СВОЮ же
   * карточку — настоящих споров ноль. Порядок строк перебирается ЯВНО: индекс
   * собирается «последний побеждает», и ответ обязан не зависеть от того, как
   * Postgres отдал строки.
   */
  const случаи: { имя: string; карточка: string; алиас: string }[] = [
    { имя: "Coca-cola classic 0,5", карточка: "Coca-Cola Classic 0,5", алиас: "Coca-cola classic 0,5" },
    { имя: "Red bull can 0.25", карточка: "Red Bull CAN 0,25", алиас: "Red bull can 0.25" },
  ];

  for (const с of случаи) {
    for (const порядок of ["карточка первой", "алиас первым"] as const) {
      it(`«${с.имя}»: ${порядок} — та же карточка, спора нет`, () => {
        const карточки = [карточка("p1", с.карточка), карточка("p2", "Snickers")];
        const алиасы = [алиас("p1", с.алиас), алиас("p2", "Сникерс")];
        const индекс =
          порядок === "карточка первой"
            ? productIndex(карточки, алиасы)
            : productIndex([...карточки].reverse(), [...алиасы].reverse());
        const о = resolveCatalogName(индекс, с.имя);
        assert.equal(о.kind, "hit", "оба ключа прода указывают на СВОЮ карточку — конфликта быть не должно");
        assert.equal(о.kind === "hit" ? о.canon : null, с.карточка);
        assert.equal(о.kind === "hit" ? о.id : null, "p1");
      });
    }
  }

  it("три строки истории склада с «неправильным» разделителем ложатся на карточки", () => {
    // Ровно эти три строки `vending_stock_count` (замер 26.08) сегодня живой
    // резолвер отдаёт СЫРЫМИ: алиаса у них нет, а имя карточки он не
    // спрашивает. Бэкфилл их уже привязывает — унификация делает живое
    // правило равным ему, и примерка бэкфилла после выкатки печатает
    // «обновилось БЫ 3».
    const пары: [string, string][] = [
      ["Fresh Tag Lemonade CAN 0.45", "Fresh Tag Lemonade CAN 0,45"],
      ["Lit Energy Blueberry CAN 0.45", "Lit Energy Blueberry CAN 0,45"],
      ["Royal Pomegranate CAN 0.3", "Royal Pomegranate CAN 0,3"],
    ];
    const индекс = productIndex(
      пары.map(([, канон], i) => карточка(`p${i + 1}`, канон)),
      [],
    );
    for (const [сырое, канон] of пары) {
      const о = resolveCatalogName(индекс, сырое);
      assert.equal(о.kind === "hit" ? о.canon : null, канон, сырое);
      assert.equal(о.kind === "hit" ? о.source : null, "name");
    }
  });
});
```
- [ ] **Step 2: Тесты RED — живой Core.**
```ts
// apps/core/src/vending/vending.service.test.ts — дописать в набор про алиасы
  it("алиас, чей ключ равен имени ЧУЖОЙ карточки, строку не уводит (R-G-1)", async () => {
    // Живой резолвер спрашивал алиас первым: строка «Fanta CAN 0,25» ложилась
    // на «Sprite CAN 0,25». На проде таких пар ноль — фикс закрывает не
    // сегодняшний убыток, а завтрашний алиас.
    const rows = [slot("AH", "31", "Fanta CAN 0,25", 6, 0)];
    const aliases: AliasRow[] = [{ productId: "p2", alias: "Fanta CAN 0,25" }];
    const products: ProdRow[] = [
      { id: "p1", name: "Fanta CAN 0,25", purchasePrice: null, packSize: 1 },
      { id: "p2", name: "Sprite CAN 0,25", purchasePrice: null, packSize: 1 },
    ];
    const summary = await new VendingService(readDb(rows, aliases, products)).deficitSummary();
    assert.deepEqual(summary.map((s) => s.product), ["Fanta CAN 0,25"]);
  });

  it("имя, отличающееся только запятой, ложится на карточку, а не отдельной позицией", async () => {
    // Три строки истории склада прода (`…0.45`, `…0.3`) до среза резолвились
    // сырыми: алиаса нет, а имя карточки живой резолвер не спрашивал.
    const rows = [slot("AH", "31", "Royal Pomegranate CAN 0.3", 6, 0)];
    const products: ProdRow[] = [{ id: "p1", name: "Royal Pomegranate CAN 0,3", purchasePrice: null, packSize: 1 }];
    const summary = await new VendingService(readDb(rows, [], products)).deficitSummary();
    assert.deepEqual(summary.map((s) => s.product), ["Royal Pomegranate CAN 0,3"]);
  });

  it("спор отдаёт карточку по ИМЕНИ и пишет предупреждение в лог", async () => {
    const products: ProdRow[] = [
      { id: "p1", name: "Fanta CAN 0,25", purchasePrice: null, packSize: 1 },
      { id: "p2", name: "Sprite CAN 0,25", purchasePrice: null, packSize: 1 },
    ];
    const svc = new VendingService(readDb([], [{ productId: "p2", alias: "Fanta CAN 0,25" }], products));
    const предупреждения: string[] = [];
    // Логгер сервиса — private readonly поле; в тесте подменяем его целиком:
    // проверяем НАБЛЮДАЕМОЕ («первый спор на проде будет видно»), а не вызов.
    (svc as unknown as { logger: { warn: (m: string) => void } }).logger = {
      warn: (m: string) => предупреждения.push(m),
    };
    const canon = await svc.canonResolver();
    assert.equal(canon("Fanta CAN 0,25"), "Fanta CAN 0,25");
    assert.equal(предупреждения.length, 1);
    assert.match(предупреждения[0]!, /Sprite CAN 0,25/);
  });

  it("на спорном имени ссылка на карточку НЕ проставляется: NULL чинится, ошибка — нет", async () => {
    // `бэкфиллWhere` держит `isNull(product_id)`: ошибочно проставленную
    // ссылку повторный прогон уже не тронет, а молчаливая привязка к чужой
    // карточке хуже оставленного NULL.
    const products: ProdRow[] = [
      { id: "p1", name: "Fanta CAN 0,25", purchasePrice: null, packSize: 1 },
      { id: "p2", name: "Sprite CAN 0,25", purchasePrice: null, packSize: 1 },
    ];
    const db = writeDb([{ productId: "p2", alias: "Fanta CAN 0,25" }], products);
    const svc = new VendingService(db.db);
    await svc.ingestStock({ items: [{ product: "Fanta CAN 0,25", quantity: 5 }] });
    const строка = db.inserts.find((i) => i.table === "vending_stock");
    assert.equal((строка?.values as { productName?: string }).productName, "Fanta CAN 0,25");
    assert.equal((строка?.values as { productId?: string | null }).productId, null);
  });
```
```ts
// apps/core/src/vending/refill.service.test.ts — новый тест рядом со стабом :69
  it("спорное имя — отказ, заливка не пишется (R-G-1)", async () => {
    // Заливка НЕОБРАТИМА для склада: она списывает остаток. Записать её на
    // «одну из двух карточек» значит увести списание не с того товара, и
    // повторный прогон этого не исправит.
    const vending = {
      resolveProductRef: async () => {
        throw new BadRequestException("имя «Fanta CAN 0,25» разрешается двумя путями");
      },
    } as unknown as VendingService;
    const db = стенд();
    await assert.rejects(
      () => new RefillService(db.db, vending).create({ machineSerial: "2508160376", productName: "Fanta CAN 0,25", qty: 3, clientKey: "k1" }),
      /двумя путями/,
    );
    assert.equal(db.inserts.length, 0, "отказ обязан случиться ДО записи");
  });
```
- [ ] **Step 3:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → RED («resolveCatalogName is not a function»); `pnpm --filter core build` → RED.
- [ ] **Step 4: Общее правило.** `packages/shared/src/stock-history.ts`: добавить `CatalogResolution` и `resolveCatalogName` (докблоки из «Interfaces (produces)»), затем переписать хвост `productIndex`:
```ts
  // ОДНА ДВЕРЬ (R-G-1): `canon`/`id` отвечают ЧЕРЕЗ общий резолвер, а не
  // повторяют его правило рядом. Раньше их две ветки («спор → byName») жили
  // копиями, и первое же уточнение приоритета пришлось бы вносить трижды.
  const резолв = (raw: string): CatalogResolution => resolveCatalogName({ explain }, raw);

  const canon: CanonIndex = (raw) => {
    const ответ = резолв(raw);
    if (ответ.kind === "hit") return ответ.canon;
    // Спор `canon` НЕ ЗНАЕТ: его зовёт импорт, и «не знаю» там значит
    // потерянную строку. Отказываться на споре — дело того, кто пишет
    // необратимое (`resolveProductIds`, `productIdResolver`).
    return ответ.kind === "conflict" ? ответ.byName : null;
  };

  return {
    canon,
    id: (raw) => {
      const ответ = резолв(raw);
      if (ответ.kind === "hit") return ответ.id;
      // На споре ссылка обязана указывать на ТУ ЖЕ карточку, что вернул
      // `canon` (по ИМЕНИ): иначе импорт записал бы `product_name` одной
      // карточки и `product_id` другой — строку, противоречащую самой себе.
      return ответ.kind === "conflict" ? (idByKey.get(normalizeProductName(ответ.byName)) ?? null) : null;
    },
    explain,
  };
```
- [ ] **Step 5: Бэкфилл.** `packages/db/src/backfill-product-ids.ts`: импорт `resolveCatalogName` из `@mydon/shared`; в `resolveProductIds` — `const ответ = resolveCatalogName(индекс, raw);` вместо `индекс.explain(raw)` (ветки `hit`/`conflict` не меняются, `conflict` теперь несёт `raw` — брать его оттуда, а не из переменной цикла). Блок шапки «⚠️ ИЗВЕСТНОЕ РАСХОЖДЕНИЕ С ЖИВЫМ РЕЗОЛВЕРОМ CORE» (`:46-61`) заменить на:
```
 * ОДНО ПРАВИЛО НА ВСЕХ (R-G-1, срез «Гигиена»). Резолв имени живёт в
 * `resolveCatalogName` (`@mydon/shared`): точное имя карточки главнее алиаса,
 * нормализация — `normalizeProductName`, спор возвращается явно. Тем же
 * правилом отвечают живой резолвер Core (`VendingService.resolveProduct`) и
 * импорт истории склада. Раньше их было три с РАЗНЫМ приоритетом, и
 * расхождение было записано здесь как долг — этот срез его закрыл.
 *
 * Строже здесь по-прежнему ОДНО: на споре скрипт ОТКАЗЫВАЕТСЯ привязывать
 * (живой резолвер берёт карточку по имени и пишет warn). Причина в
 * необратимости: `бэкфиллWhere` держит `isNull`, и ошибочную ссылку повторный
 * прогон уже не тронет.
```
- [ ] **Step 6: Core.** `apps/core/src/vending/vending.service.ts`:
```ts
  // В `loadProductIndex()` — вместо сборки `aliasByKey`:
  // ИНДЕКС КАТАЛОГА, А НЕ КАРТА АЛИАСОВ (R-G-1). Карта отвечала только «есть
  // ли такой алиас» и на вопрос «какая это карточка» ответить не могла — из-за
  // чего живой резолвер и спрашивал алиас первым. Строится из ТЕХ ЖЕ двух
  // выборок, второго похода в базу нет.
  const catalog = productIndex(products, aliases);
  …
  return { catalog, priceByName, packByName, rulesByName, productRows: products };

  resolveProduct(name: string, catalog: ProductIndex): string {
    const ответ = resolveCatalogName(catalog, name);
    if (ответ.kind === "hit") return ответ.canon;
    if (ответ.kind === "conflict") {
      // На проде таких имён 0 (замер 26.08). Появление ПЕРВОГО обязано быть
      // видно: молча решать в пользу карточки и молчать — значит повторить ту
      // же ошибку, из-за которой правило разъехалось на три реализации.
      this.logger.warn(
        `Имя «${ответ.raw}» разрешается двумя путями: карточка «${ответ.byName}» и алиас карточки «${ответ.byAlias}». ` +
          `Берём карточку по ИМЕНИ — уберите лишний алиас.`,
      );
      return ответ.byName;
    }
    // ПРОМАХ — СЫРОЕ ИМЯ, КАК БЫЛО. Шестнадцать вызывающих принимают `string` и
    // отличить канон от сырого имени не могут; верни отсюда пустоту — и они
    // начнут писать в склад и планограмму имена, которых нет.
    return ответ.raw;
  }

  private productIdResolver(index: { catalog: ProductIndex }): (raw: string) => string | null {
    return (raw: string) => {
      const ответ = resolveCatalogName(index.catalog, raw);
      return ответ.kind === "hit" ? ответ.id : null;
    };
  }

  async resolveProductRef(raw: string): Promise<{ name: string; productId: string | null }> {
    const trimmed = raw.trim();
    const { catalog } = await this.loadProductIndex();
    const ответ = resolveCatalogName(catalog, trimmed);
    if (ответ.kind === "conflict") {
      // Заливка списывает склад — это необратимо. «Одна из двух карточек»
      // увела бы списание не с того товара, и повтор этого не починит.
      throw new BadRequestException(
        `Имя «${ответ.raw}» разрешается двумя путями: карточка «${ответ.byName}» и алиас карточки «${ответ.byAlias}». Уберите лишний алиас.`,
      );
    }
    // `id` приезжает из индекса — SELECT по имени больше не нужен (минус один
    // запрос на каждую заливку из бота).
    return ответ.kind === "hit" ? { name: ответ.canon, productId: ответ.id } : { name: trimmed, productId: null };
  }
```
Дальше — механическая замена, которую ведёт компилятор: тринадцать мест `aliasByKey` → `catalog` и четыре сигнатуры (`latestSold7(serials, catalog)`, `loadProductIndex()`, `productIdResolver({ catalog })`, `retailFacts(days, catalog?, now)`); `resolveSlots(slots, catalog)`, `priceIndex().canonOf` и `canonResolver` — через `catalog`. `findProductRow` не трогаем. В `analytics.service.ts:480` — `this.vending.resolveProduct(raw, index.catalog)`.
- [ ] **Step 7: Документация.** `docs/DATA_SOURCES.md`, к абзацу про резолв донорских имён (`:1075-1085`) дописать: правило резолва каталога ОДНО и живёт в `resolveCatalogName` (`@mydon/shared`); приоритет — точное имя карточки, потом алиас; ключ сравнивается нормализованным (`ё`→`е`, пробелы, запятая между цифрами → точка); имя, которое разрешается ДВУМЯ путями на разные карточки, не привязывается вовсе и печатается владельцу отдельной строкой — чинится это разведением алиаса и карточки, а не заведением ещё одной карточки.
- [ ] **Step 8:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build && pnpm --filter core build && pnpm --filter @mydon/shared test && pnpm --filter @mydon/db test && pnpm --filter core test` → GREEN. `pnpm -s typecheck`.
- [ ] **Step 9:** `git commit -m "fix(core,shared,db): единый резолвер каталога — имя карточки главнее алиаса, спор возвращается явно (гигиена, R-G-1)" -- packages/shared/src/stock-history.ts packages/shared/src/catalog-resolve.test.ts packages/db/src/backfill-product-ids.ts apps/core/src/vending/vending.service.ts apps/core/src/vending/vending.service.test.ts apps/core/src/vending/analytics.service.ts apps/core/src/vending/refill.service.ts apps/core/src/vending/refill.service.test.ts docs/DATA_SOURCES.md`

---

### Task 2: Вставка задач ТО перестаёт падать 42P10 — за всё время не поставлено ни одной (S, R-G-2)

**Files:** Modify `packages/db/src/schema.ts` (индексы `task`, стр. 228–244); `packages/db/src/schema.test.ts` (в конец файла); `apps/core/src/tasks/tasks.service.ts` (импорт стр. 2, `ensureForDay` 353–401); `apps/core/src/tasks/tasks.controller.ts` (импорт стр. 2, `EnsureForDayDto` 110–115); `apps/core/src/tasks/tasks.test.ts` (`StubOpts` 7–21, `insert` 42–54, набор «Задачи» 102–145); `apps/agents/src/maintenance-monitor.ts` (хвост `runMaintenanceMonitor`, стр. 219–225); `apps/agents/src/maintenance-monitor.test.ts` (`stubCore` 34–50, конец файла); `tools/smoke-core.mjs` (новый сценарий рядом с `проверитьРетенцию`, вызов в главном блоке 1885–1890, итоговая строка 1917); `docs/FIELD_OPS_SPEC.md` (§6.7, стр. 2441–2470). Create `apps/core/src/tasks/tasks.controller.test.ts`.

**Interfaces (consumes):** `task` (`packages/db/src/schema.ts:172`), `uniqueIndex("task_source_key")` и миграция `packages/db/drizzle/0040_task_entity_photo_stage.sql:5`, `PgDialect` (`drizzle-orm/pg-core`, 0.45.2), `jsonRequest(method, path, body)` (`tools/smoke-core.mjs:1105`), `MaintenanceMonitorCoreClient.recordEvent` (`apps/agents/src/maintenance-monitor.ts:76`).

**Interfaces (produces):**
```ts
/** packages/db/src/schema.ts */
/**
 * Предикат ЧАСТИЧНОГО индекса `task_source_key` — ОДНО значение на схему и на
 * вставку (R-G-2).
 *
 * `ensureForDay` обязан повторить его в `onConflictDoNothing({ target, where })`:
 * без `where` drizzle печатает `on conflict ("source") do nothing`, Postgres не
 * может вывести из этого ЧАСТИЧНЫЙ индекс и отвечает `42P10`; класс `42` не
 * подходит ни под `22*`, ни под `23*` в `pg-exception.filter.ts:28`, поэтому
 * наружу уходил 500 — и задач обслуживания не создавалось НИ ОДНОЙ (замер
 * прода 26.08.2026: строк с датой в `source` — 0, при 19 попытках в сутки).
 *
 * Экспортируется, а не копируется строкой рядом со вставкой: разошедшийся
 * предикат — тот же `42P10`, но уже без единого признака в коде.
 */
export const TASK_SOURCE_DAY_PREDICATE = sql`source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
```
```ts
/** apps/agents/src/maintenance-monitor.ts — новый тип события */
type: "maintenance.monitor_failed";
payload: { errorCount: number; errors: string[]; tasks: number; day: string };
```

Что обязана делать реализация:
- Предикат в `uniqueIndex("task_source_key")` заменяется НА ТУ ЖЕ КОНСТАНТУ. Текст DDL при этом не меняется ни на байт (шаблон без параметров), и `db:generate` обязан ответить «No schema changes»: миграции в срезе нет.
- `where` в `onConflictDoNothing` — это `index_predicate` Postgres, а не фильтр строк. Он обязан рендериться ЛИТЕРАЛОМ без параметров: с `$1` вывод индекса не сработает и вернётся тот же `42P10`.
- Ответ роута НЕ меняется: `ensureForDay` возвращает `null` → 200/201 с пустым телом → `core-client` читает `{ created: false }`. 409 не вводим (R-G-2).
- `@Matches(/^\d{4}-\d{2}-\d{2}$/)` ставится РЯДОМ с `@IsISO8601`, а не вместо: первый отвечает «это вообще дата», второй — «это голые сутки». Полная дата-время уводит `source` из-под предиката, и дедуп выключается молча.
- Событие агента пишется ПОД СВОИМ `try/catch`: сторож, который роняет прогон, хуже отсутствующего. Потолок на список — 20 строк, как у `idleReasons`.
- Смоук — часть фикса, а не проверка: юнит-стенд SQL не исполняет, и `ensureForDay` был «покрыт тестами», не работая ни разу.

- [ ] **Step 1: Тесты RED — стенд и рендер.**
```ts
// apps/core/src/tasks/tasks.test.ts
// 1) стенд начинает ЗАПОМИНАТЬ спецификацию конфликта
interface StubOpts {
  …
  /** Куда складывать аргумент `onConflictDoNothing` — иначе фикс регрессирует так же незаметно. */
  conflicts?: { target?: unknown; where?: unknown }[];
}
…
      return {
        onConflictDoNothing: (cfg?: { target?: unknown; where?: unknown }) => {
          opts.conflicts?.push({ target: cfg?.target, where: cfg?.where });
          return { returning };
        },
        …
      };

// 2) новый набор
import { PgDialect } from "drizzle-orm/pg-core";
import { task, TASK_SOURCE_DAY_PREDICATE } from "@mydon/db";

describe("Дедуп задач на день держится ЧАСТИЧНЫМ индексом (R-G-2)", () => {
  it("вставка называет и колонку, и ПРЕДИКАТ индекса — иначе Postgres отвечает 42P10", async () => {
    // Без `where` drizzle печатает `on conflict ("source") do nothing`, и
    // частичный индекс `task_source_key` из такой спецификации не выводится.
    // Прод 26.08: задач от монитора 0 за всё время при 19 попытках в сутки.
    const conflicts: { target?: unknown; where?: unknown }[] = [];
    await makeTasks(stubDb({ conflicts })).ensureForDay({
      title: "Мойка миксера",
      ownerKind: "human",
      source: "maint:pl-1",
      dayKey: "2026-08-26",
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.target, task.source, "конфликт объявлен по той же колонке, что индекс");
    assert.equal(
      conflicts[0]!.where,
      TASK_SOURCE_DAY_PREDICATE,
      "предикат — ТО ЖЕ значение, что у индекса в схеме, а не его копия строкой",
    );
  });

  it("предикат рендерится литералом, без единого параметра", () => {
    // `index_predicate` в `ON CONFLICT` сравнивается с предикатом индекса, а
    // не исполняется как фильтр: `$1` вместо литерала снова дал бы 42P10.
    const { sql: текст, params } = new PgDialect().sqlToQuery(TASK_SOURCE_DAY_PREDICATE);
    assert.equal(текст, "source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    assert.deepEqual(params, [], "параметр в предикате ломает вывод частичного индекса");
  });
});
```
```ts
// packages/db/src/schema.test.ts — новый набор в конец файла
import { readFileSync } from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { TASK_SOURCE_DAY_PREDICATE } from "./schema";

describe("Предикат частичного индекса task_source_key (R-G-2)", () => {
  it("константа дословно совпадает с миграцией 0040 — иначе вставка снова получит 42P10", () => {
    // Индекс уже в проде, миграция — единственная запись о том, КАК он выглядит
    // в базе. Разойдясь с ней, константа не сломает ни сборку, ни тесты
    // схемы: сломается вставка, и ровно тем же молчаливым 500.
    const { sql: предикат } = new PgDialect().sqlToQuery(TASK_SOURCE_DAY_PREDICATE);
    const миграция = readFileSync(
      path.resolve(__dirname, "../drizzle/0040_task_entity_photo_stage.sql"),
      "utf8",
    );
    assert.ok(
      миграция.includes(`WHERE ${предикат}`),
      `предикат «${предикат}» не найден в 0040 — схема и вставка разошлись`,
    );
  });
});
```
```ts
// apps/core/src/tasks/tasks.controller.test.ts — новый файл
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { EnsureForDayDto } from "./tasks.controller";

/**
 * `dayKey` — ЧАСТЬ КЛЮЧА ИДЕМПОТЕНТНОСТИ, а не просто дата (R-G-2).
 *
 * `source` собирается как `<ключ>:<dayKey>` и обязан попасть под предикат
 * частичного индекса `:[0-9]{4}-[0-9]{2}-[0-9]{2}$`. Полная дата-время проходит
 * `@IsISO8601({strict:true})`, но под предикат НЕ попадает — и дедуп
 * выключается молча: дубли пойдут без единой ошибки.
 */
const тело = (dayKey: string) => plainToInstance(EnsureForDayDto, { title: "Мойка миксера", ownerKind: "human", dayKey });

describe("EnsureForDayDto: dayKey — только голые сутки", () => {
  it("YYYY-MM-DD принимается", async () => {
    assert.deepEqual(await validate(тело("2026-08-26")), []);
  });

  for (const плохой of ["2026-08-26T06:00:00.000Z", "2026-08-26 06:00", "26.08.2026", "2026-8-26"]) {
    it(`«${плохой}» отбивается: такой source уходит из-под предиката индекса`, async () => {
      const ошибки = await validate(тело(плохой));
      assert.ok(ошибки.length > 0, "иначе дедуп молча перестаёт работать");
    });
  }
});
```
```ts
// apps/agents/src/maintenance-monitor.test.ts — новые тесты
  it("Core ответил 500 на один норматив — прогон не падает, остальные обработаны", async () => {
    // Каждая строка в своём try/catch. До 26.08.2026 500 отвечал КАЖДЫЙ вызов
    // (42P10 на вставке), и единственным следом была строка в console.log,
    // которую съедало пересоздание контейнера деплоем.
    let n = 0;
    const { core, tasks } = stubCore([row({ planId: "pl-1" }), row({ planId: "pl-2" })], {
      ensureTaskForDay: async (input: EnsureTaskInput) => {
        n += 1;
        if (n === 1) throw new Error("Core ответил 500 на /tasks/ensure-for-day");
        tasks.push(input);
        return { created: true, taskId: "t-2" };
      },
    });
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /pl-1/);
    assert.equal(r.tasks, 1, "второй норматив обязан быть обработан");
  });

  it("прогон с ошибками пишет СОБЫТИЕ, а не строку в лог", async () => {
    // «Монитор не смог поставить ни одной задачи» обязано переживать
    // пересоздание контейнера: доказывать аварию 26.08 пришлось схемой и
    // нулевыми счётчиками именно потому, что логов уже не было.
    const { core, events } = stubCore([row()], {
      ensureTaskForDay: async () => {
        throw new Error("Core ответил 500 на /tasks/ensure-for-day");
      },
    });
    const r = await runMaintenanceMonitor(core, { now: NOW });
    const сбой = events.find((e) => e.type === "maintenance.monitor_failed");
    assert.ok(сбой, "непустой errors обязан стать событием");
    assert.equal(сбой!.payload.errorCount, 1);
    assert.equal(сбой!.payload.tasks, 0);
    assert.equal(сбой!.payload.day, "2026-08-06");
    assert.equal(r.errors.length, 1);
  });

  it("чистый прогон события о сбое не пишет", async () => {
    const { core, events } = stubCore([row()]);
    await runMaintenanceMonitor(core, { now: NOW });
    assert.ok(!events.some((e) => e.type === "maintenance.monitor_failed"));
  });
```
- [ ] **Step 2:** `pnpm --filter @mydon/db build && pnpm --filter core build && pnpm --filter agents build && pnpm --filter core test && pnpm --filter @mydon/db test && pnpm --filter agents test` → RED (`TASK_SOURCE_DAY_PREDICATE` не экспортирован, `where` не приехал, события нет).
- [ ] **Step 3: Схема.** `packages/db/src/schema.ts`: объявить `TASK_SOURCE_DAY_PREDICATE` (докблок выше) НАД таблицей `task` и подставить его в `uniqueIndex("task_source_key").on(t.source).where(TASK_SOURCE_DAY_PREDICATE)`. Комментарий у индекса дополнить одной фразой: «предикат вынесен в `TASK_SOURCE_DAY_PREDICATE` — его обязана дословно повторять спецификация `ON CONFLICT` в `ensureForDay`, иначе `42P10`».
- [ ] **Step 4: Core.** `apps/core/src/tasks/tasks.service.ts`:
```ts
      .onConflictDoNothing({
        // ПРЕДИКАТ ОБЯЗАТЕЛЕН (R-G-2): индекс `task_source_key` ЧАСТИЧНЫЙ, и
        // из голого `target` Postgres его не выводит — `42P10`, который фильтр
        // исключений (класс не 22/23) отдаёт как 500. Так эта вставка не
        // проходила НИ РАЗУ: задач от монитора в проде 0 при 19 попытках в
        // сутки (замер 26.08.2026).
        target: task.source,
        where: TASK_SOURCE_DAY_PREDICATE,
      })
```
и импорт `TASK_SOURCE_DAY_PREDICATE` из `@mydon/db` рядом с `task`.
- [ ] **Step 5: DTO.** `apps/core/src/tasks/tasks.controller.ts`:
```ts
export class EnsureForDayDto extends CreateTaskDto {
  /**
   * Календарный день по Ташкенту — ЧАСТЬ КЛЮЧА ИДЕМПОТЕНТНОСТИ.
   *
   * `@IsISO8601` пропускает и полную дату-время; такой `source`
   * (`maint:<plan>:2026-08-26T06:00:00Z`) не попадает под предикат частичного
   * индекса, и дедуп выключается МОЛЧА — дубли пойдут без единой ошибки.
   */
  @IsISO8601({ strict: true }, { message: "dayKey: дата YYYY-MM-DD" })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dayKey: только голые сутки YYYY-MM-DD, без времени" })
  dayKey!: string;
}
```
(`Matches` — в импорт из `class-validator`.)
- [ ] **Step 6: Агент.** `apps/agents/src/maintenance-monitor.ts`, перед `return result`:
```ts
  // СБОЙ ПРОГОНА — СОБЫТИЕ, А НЕ СТРОКА В ЛОГЕ. `result.errors` уезжали только
  // в `console.log` крона (`index.ts:447`), а логи контейнера живут до первого
  // деплоя: аварию 26.08.2026 («ни одной задачи ТО не поставлено ни разу»)
  // пришлось доказывать схемой и нулевыми счётчиками, потому что строк уже не
  // было. Под своим `try/catch`: сторож, который роняет прогон, хуже
  // отсутствующего.
  if (result.errors.length > 0) {
    try {
      await core.recordEvent({
        source: "maintenance-monitor",
        type: "maintenance.monitor_failed",
        payload: {
          errorCount: result.errors.length,
          errors: result.errors.slice(0, 20),
          tasks: result.tasks,
          day: today,
        },
      });
    } catch (err) {
      result.errors.push(`событие о сбое не записано: ${String(err)}`);
    }
  }
```
- [ ] **Step 7: Смоук — единственная застава, видящая 42P10.** `tools/smoke-core.mjs`, рядом с `проверитьРетенцию`:
```js
/**
 * Идемпотентная постановка задачи на день — против НАСТОЯЩЕГО Postgres (R-G-2).
 *
 * Юнит-стенд `stubDb` возвращает заготовленный ответ и SQL не исполняет:
 * `ensureForDay` был «покрыт тестами» и при этом не работал НИ РАЗУ —
 * `on conflict ("source") do nothing` против ЧАСТИЧНОГО индекса даёт `42P10`,
 * а тот превращается в 500. Увидеть это может только живая база.
 */
async function проверитьЗадачиТО() {
  const сутки = (сдвиг) =>
    new Date(Date.now() + сдвиг * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  // Ключ уникален на прогон, но ОДИН на первые два вызова: дедуп проверяется
  // повтором того же ключа, а не разными.
  const ключ = `smoke:maint:${Date.now()}`;
  const тело = (dayKey) => ({
    title: "Дымовая мойка миксера",
    ownerKind: "human",
    source: ключ,
    dayKey,
    createdBy: "agent:smoke",
  });

  const первый = await jsonRequest("POST", "/tasks/ensure-for-day", тело(сутки(0)));
  if (!первый.r.ok) throw new Error(`создание → ${первый.r.status}: ${первый.text.slice(0, 200)}`);
  if (!первый.json?.id) throw new Error(`первая постановка не вернула id: ${первый.text.slice(0, 200)}`);

  const повтор = await jsonRequest("POST", "/tasks/ensure-for-day", тело(сутки(0)));
  if (!повтор.r.ok) throw new Error(`повтор → ${повтор.r.status}: ${повтор.text.slice(0, 200)}`);
  if (повтор.json?.id) throw new Error("повтор в тот же день создал ВТОРУЮ задачу — дедуп не работает");

  const завтра = await jsonRequest("POST", "/tasks/ensure-for-day", тело(сутки(1)));
  if (!завтра.r.ok) throw new Error(`следующий день → ${завтра.r.status}: ${завтра.text.slice(0, 200)}`);
  if (!завтра.json?.id) throw new Error("на следующий день задача обязана появиться заново");
  if (завтра.json.id === первый.json.id) throw new Error("вернулась вчерашняя задача — ключ дня не участвует");

  // Полная дата-время не имеет права попасть в ключ: такой source уходит
  // из-под предиката индекса, и дедуп выключается молча.
  const время = await jsonRequest("POST", "/tasks/ensure-for-day", тело(`${сутки(0)}T06:00:00.000Z`));
  if (время.r.ok) throw new Error("dayKey с временем принят — предикат индекса перестанет ловить дубли");
}
```
В главном блоке, рядом с прочими сценариями:
```js
  try {
    await проверитьЗадачиТО();
    console.log("  ok  сценарий: задача ТО на день — создание, повтор без дубля, следующий день");
  } catch (e) {
    провалы.push(`задачи ТО: ${e.message}`);
  }
```
и в итоговой строке (`:1917`) — `14 сценариев`.
- [ ] **Step 8: Документация.** `docs/FIELD_OPS_SPEC.md` §6.7, после блока с контрактом клиента — абзац: до 26.08.2026 `POST /tasks/ensure-for-day` отвечал 500 на КАЖДУЮ вставку (`on conflict ("source") do nothing` против ЧАСТИЧНОГО индекса `task_source_key` → `42P10`), поэтому задач обслуживания не создавалось ни одной; дедуп держится предикатом `TASK_SOURCE_DAY_PREDICATE`, который обязаны дословно повторять И индекс, И спецификация конфликта; `dayKey` — только голые сутки; непустой `errors` прогона пишет событие `maintenance.monitor_failed`.
- [ ] **Step 9:** `pnpm --filter @mydon/db build && pnpm --filter core build && pnpm --filter agents build && pnpm -s test` → GREEN; `pnpm --filter @mydon/db db:generate` → «No schema changes»; локально на scratch-БД `node tools/smoke-core.mjs` — сценарий задач ТО зелёный.
- [ ] **Step 10:** `git commit -m "fix(core,db,agents): задачи ТО перестают падать 42P10 — конфликт по предикату частичного индекса (гигиена, R-G-2)" -- packages/db/src/schema.ts packages/db/src/schema.test.ts apps/core/src/tasks/tasks.service.ts apps/core/src/tasks/tasks.controller.ts apps/core/src/tasks/tasks.test.ts apps/core/src/tasks/tasks.controller.test.ts apps/agents/src/maintenance-monitor.ts apps/agents/src/maintenance-monitor.test.ts tools/smoke-core.mjs docs/FIELD_OPS_SPEC.md`

---

### Task 3: Сторож свежести снапшота — в обоих режимах (S, R-G-3)

**Files:** Modify `apps/core/src/ourvend/sync-stale.service.ts` (докстринг `checkSnapshot` 161–183, ранний `return` 201); `apps/core/src/ourvend/sync-stale.service.test.ts` (набор «Сторож свежести учётного снапшота», 338–470); `docs/DEPLOY.md` (строка таблицы `SNAPSHOT_STALE_HOURS`, 259); `docs/PLAN_STOCK_ABSORPTION.md` (абзац «сторож свежести учётного снапшота», 507–512).

**Interfaces (consumes):** `accountingSource(db, now)` (`apps/core/src/sales/accounting-source.ts`), `lastSnapshotAt`, `snapshotStaleThreshold`, `snapshotStaleVerdict` (`apps/core/src/ourvend/sync-runs.ts`), `staleHours`, `tashkentDayStartOf` (`@mydon/shared`), `SNAPSHOT_STALE_EVENT` (`sync-stale.service.ts:26`), стенд `снапшотныйСтенд({источник})` (`sync-stale.service.test.ts:352`), `OurvendHealthService` (уже собирается в этом же тесте, `:317`).

**Interfaces (produces):** новых экспортов нет. Меняется УСЛОВИЕ: `checkSnapshot(now)` считает свежесть в ЛЮБОМ режиме учёта; сигнатура, порог, вердикт, дедуп и `which` — прежние. Поле `OurvendHealth.snapshotStale` остаётся own-only (правит его докстринг T4).

Что обязана делать реализация:
- Убирается ровно одна строка — ранний `return` (`:201`). `accountingSource(this.db, now)` при этом ОСТАЁТСЯ в `Promise.all`: режим по-прежнему нужен — им подписывается событие и по нему объясняется различие с витриной. Убрать чтение вместе с гейтом значило бы потерять контекст в payload.
- Докстринг `«ПОЧЕМУ В РЕЖИМЕ stock НЕ ПРОВЕРЯЕМ НИЧЕГО»` заменяется на объяснение РАЗЛИЧИЯ (текст в Step 3). Оставить старый текст рядом с новым поведением — худший исход правки: следующий читатель поверит комментарию.
- Порог (36 ч), решение по СЫРЫМ часам, показ с округлением 0.1 ч, дедуп по ташкентским суткам по СВОЕМУ типу события и разбивка `which` — без единой правки.
- Тест «в режиме stock не проверяет ничего» (`:390`) не удаляется, а ПЕРЕВОРАЧИВАЕТСЯ: его место занимает утверждение о новом правиле, чтобы история набора осталась читаемой.
- **Ловушка стенда:** `accountingSource` держит кеш в МОДУЛЕ и ключует его временем (60 с, `t >= кеш.at`). Набор гоняет тесты с одним и тем же `сейчас`, поэтому режим предыдущего теста может «протечь» в следующий — в якорном тесте перед сборкой отчёта обязателен `resetAccountingSourceCache()` (импорт в файле уже есть, `:4`). Для самого сторожа это безразлично: после снятия гейта он по режиму не ветвится вовсе.

- [ ] **Step 1: Тесты RED.**
```ts
// apps/core/src/ourvend/sync-stale.service.test.ts — замена теста :390 и три новых
  it("в режиме stock сторож работает так же: 37 ч → событие (R-G-3)", async () => {
    // Раньше здесь стояло «в режиме stock не проверяет ничего: снапшот там
    // теневой». Теневой он ДЛЯ УЧЁТА, но это единственный вход в паритет, а
    // паритет — гейт катовера: вставший агент даёт «зелёную» серию из нулей.
    // Прод 26.08: режим `stock`, снимки приходят ежедневно в 08:05 обе
    // половины, лаг ≈ 5,8 ч при пороге 36 — ложных тревог не будет.
    const { svc, события } = снапшотныйСтенд({ источник: "stock", снапшотAt: "2026-09-04T00:00:00+05:00" });
    const r = await svc.checkSnapshot(сейчас);
    assert.deepEqual([r.stale, r.emitted], [true, true]);
    assert.equal(события[0]!.type, SNAPSHOT_STALE_EVENT);
    assert.equal(события[0]!.payload.часы_продаж, 37);
  });

  it("в режиме stock порог тот же: 35 ч при пороге 36 — тишина", async () => {
    // Порог не имеет права «съехать» вместе с режимом: 36 ч — это два
    // пропущенных суточных съёма, независимо от того, кто читает снапшот.
    const { svc, события } = снапшотныйСтенд({ источник: "stock", снапшотAt: "2026-09-04T02:00:00+05:00" });
    const r = await svc.checkSnapshot(сейчас);
    assert.deepEqual([r.stale, r.emitted, r.threshold], [false, false, SNAPSHOT_STALE_HOURS_FALLBACK]);
    assert.equal(события.length, 0);
  });

  it("дедуп по ташкентским суткам действует и в stock", async () => {
    // Крон ходит каждые полчаса: без дедупа сутки застоя дали бы 48 сообщений.
    const { svc, события } = снапшотныйСтенд({
      источник: "stock",
      снапшотAt: "2026-09-04T00:00:00+05:00",
      уже: [{ type: SNAPSHOT_STALE_EVENT, occurredAt: new Date("2026-09-05T09:00:00+05:00") }],
    });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, false);
    assert.equal(события.length, 0);
    assert.equal((await svc.checkSnapshot(new Date("2026-09-06T13:00:00+05:00"))).emitted, true);
  });

  it("сторож и витрина отвечают на РАЗНЫЕ вопросы: в stock он тревожит, а snapshotStale остаётся false", async () => {
    // Якорь различия (R-G-3). Сторож — про АГЕНТА: приносит ли
    // `ourvend:accounting` суточный снимок. Поле витрины — про УЧЁТ:
    // остановился ли он от этого. В режиме `stock` не остановился — продажи и
    // остатки едут зеркалом mydon-stock. Расклеить эти две половины молча
    // нельзя: «⛔ учёт стоит» каждый день до катовера — ровно тот дефект,
    // из-за которого гейт когда-то и поставили сразу в двух местах.
    const { svc, db, события } = снапшотныйСтенд({
      источник: "stock",
      снапшотAt: "2026-09-04T00:00:00+05:00",
      lastSuccessAt: "2026-09-05T12:00:00+05:00",
    });
    // Источник учёта кеширует МОДУЛЬ (`accounting-source.ts`, 60 с по
    // переданному `now`), а не сервис: без сброса отчёт получил бы режим
    // предыдущего теста набора — `own`, — и `snapshotStale` стал бы `true` по
    // причине, к правке отношения не имеющей. Тот же приём, что в стенде
    // `сервис()` теста здоровья.
    resetAccountingSourceCache();
    const отчёт = new OurvendHealthService(db, {
      parity: async () => ПАРИТЕТ,
      streak: async () => СЕРИЯ_ПУСТО,
    } as unknown as OurvendParityService);

    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true, "сторож обязан тревожить и в stock");
    assert.equal(события.length, 1);
    assert.equal((await отчёт.health(20, сейчас)).snapshotStale, false, "витрина в stock молчит намеренно");
  });
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → RED (в `stock` сторож пока молчит).
- [ ] **Step 3: Сторож.** `apps/core/src/ourvend/sync-stale.service.ts`: удалить строку `:201` (`if (источник !== "own") return …`) и заменить абзац докстринга:
```ts
   * ПОЧЕМУ В ОБОИХ РЕЖИМАХ, ХОТЯ ПОЛЕ ВИТРИНЫ — ТОЛЬКО В `own` (R-G-3).
   * Сторож и `OurvendHealth.snapshotStale` отвечают на РАЗНЫЕ вопросы. Поле —
   * про УЧЁТ: «остановился ли он от того, что снимка нет». В режиме `stock` не
   * остановился (продажи и остатки едут зеркалом mydon-stock), поэтому поле
   * там всегда `false`, и это НЕ забытая правка (`ourvend-health.service.ts`).
   * Сторож — про АГЕНТА: «приносит ли `ourvend:accounting` суточный снимок».
   * Не приносит — и в режиме `stock` тоже плохо: снапшот там единственный вход
   * в ПАРИТЕТ (R-P8b-1), а паритет — гейт катовера. Вставший агент даёт
   * «зелёную» серию из нулей: ноль сверенных пар читается как «расхождений
   * нет». Раньше здесь стоял ранний `return` с доводом «а на проде до катовера
   * это КАЖДЫЙ день» — прод-замер 26.08.2026 его снял: в действующем режиме
   * `stock` снимки приходят ежедневно в 08:05, обе половины, лаг ≈ 5,8 ч при
   * пороге 36 ч (два пропущенных съёма подряд).
   *
   * Режим по-прежнему читается: им подписывается событие и объясняется это
   * различие. Убрать чтение вместе с гейтом значило бы потерять контекст.
```
- [ ] **Step 4: Документация.** `docs/DEPLOY.md:259` — вместо «(`ourvend.snapshot_stale`, только в режиме `own`)» написать «(`ourvend.snapshot_stale`, в ОБОИХ режимах учёта: сторож следит за АГЕНТОМ, а не за учётом; поле витрины `health.snapshotStale` остаётся own-only)». `docs/PLAN_STOCK_ABSORPTION.md:507-512` — там же дописать, что сторож работает и до катовера, потому что снапшот — единственный вход в паритет, а паритет и есть гейт катовера.
- [ ] **Step 5:** `pnpm --filter core test` → GREEN, `pnpm -s typecheck`. Смоук не меняется: сторож живёт по крону и в дымовом прогоне не участвует.
- [ ] **Step 6:** `git commit -m "fix(core): сторож свежести учётного снапшота работает в обоих режимах (гигиена, R-G-3)" -- apps/core/src/ourvend/sync-stale.service.ts apps/core/src/ourvend/sync-stale.service.test.ts docs/DEPLOY.md docs/PLAN_STOCK_ABSORPTION.md`

---

### Task 4: `parityLastRed` и `parityStreakSince` в здоровье — вместо второго запроса (M, R-G-4)

**Files:** Modify `packages/shared/src/vending-reports.ts` (`OurvendHealth`, докблок `snapshotStale` 952–968, поля после `cutoverThreshold` 986); `packages/shared/src/vending-reports-contracts.test.ts` (фикстура `ЗДОРОВЬЕ` 28–52, ключ-гвард 105–118); `apps/core/src/ourvend/ourvend-health.service.ts` (`return` 226–227); `apps/core/src/ourvend/ourvend-health.service.test.ts` (`Мир` и `healthDb` 137–147, стенд `сервис` 149–155, набор про гейт катовера 290–305 — литерала `OurvendHealth` в файле нет, только `ParityStreak`); `apps/core/src/vending/weekly-digest.service.ts` (`ЗДОРОВЬЕ_НЕИЗВЕСТНО` 118–145); `apps/core/src/vending/weekly-digest.service.test.ts` (276, 301); `apps/bot/src/handler.ts` (420–423); `apps/bot/src/analytics-brief.ts` (`строкаКрасногоДня` 833, `formatOurvendHealth` 909, печать 932); `apps/bot/src/analytics-brief.test.ts` (204, 631–648, 755); `apps/bot/src/core-client.ts` (докблок `ourvendParityStreak` 445–455); `apps/bot/src/core-client.test.ts` (105–121); `apps/bot/src/weekly-digest.test.ts` (70, 336); `apps/bot/src/weekly-delivery.test.ts` (30); `apps/bot/src/bot.test.ts` (680–697); `apps/cc/src/lib/core.ts` (докблок `ourvendParityStreak` 2270–2277); `apps/cc/src/lib/core-types.test.ts` (фикстура 49–62, ключ-гвард 131); `apps/cc/src/components/ourvend-health-view.tsx` (88, 128–141, 279, 318–341); `apps/cc/src/components/ourvend-health-view.test.tsx` (42, 59, 76, 133, 141, 150, 412, 436).

**Interfaces (consumes):** `ParityStreak.lastRed` / `.since` (`packages/shared/src/parity-streak.ts:101,103`), `серияПаритета` из `Promise.all` (`ourvend-health.service.ts:162-167`, фолбэк уже отдаёт оба `null`), `деньРу`/`день` форматтеры витрин.

**Interfaces (produces):**
```ts
/** packages/shared/src/vending-reports.ts — сразу за `cutoverThreshold` */

/**
 * Дата последнего НЕзелёного дня паритета, `YYYY-MM-DD`. `null` — красных не было.
 *
 * МОЖЕТ ЛЕЖАТЬ ВНЕ ОКНА ПОКАЗА: `lastRed` ищется по ВСЕМУ прочитанному журналу
 * событий, а `GET /ourvend/parity/streak` показывает две недели. Прод-красный
 * 25.08.2026 продержится в поле до конца октября, хотя серия идёт с 26-го, —
 * читать его как «серия сорвана» нельзя: серия отвечает `parityStreak`.
 *
 * Едет ЗДЕСЬ, а не вторым запросом: Core уже считает серию внутри этого же
 * `Promise.all` и до среза «Гигиена» выбрасывал обе даты. Витрины ходили за
 * ними в `/ourvend/parity/streak` под `.catch(() => null)` — и на его отказе
 * строка про последний сбой молча исчезала из отчёта о здоровье.
 */
parityLastRed: string | null;

/**
 * Первый день ТЕКУЩЕЙ серии зелёных дней, `YYYY-MM-DD`. `null` — серии нет.
 *
 * Имя с префиксом `parity*`, а не голое `since`: в плоском объекте здоровья
 * `since` читается как «здоровье с такого-то момента», а это про серию.
 */
parityStreakSince: string | null;
```
```ts
/** apps/bot/src/analytics-brief.ts */
export function строкаКрасногоДня(h: OurvendHealth): string;
export function formatOurvendHealth(h: OurvendHealth): string[];
/** apps/cc/src/components/ourvend-health-view.tsx */
export function OurvendHealthCard({ health }: { health: OurvendHealth }): JSX.Element;
```

Что обязана делать реализация:
- Поля добавляются РЯДОМ с `parityStreak`/`cutoverThreshold` — они об одном и том же счёте, и разносить их по объекту значит заставлять читателя искать.
- `GET /ourvend/parity/streak` НЕ удаляется и его троттл не трогается: он несёт `days[]` — пофакторный разбор 14 дней, которого в здоровье нет и быть не должно. Убираются только ВТОРЫЕ ВЫЗОВЫ из двух витрин и `.catch(() => null)` вместе с ними.
- Правило «в `retired` строку про красный день не печатаем» СОХРАНЯЕТСЯ: там серии нет вовсе, и старая дата только сбивала бы.
- Докблоки клиентов (`bot/core-client.ts`, `cc/lib/core.ts`) перестают утверждать, что дату последнего красного дня отдаёт только этот роут: после среза это неправда, а докблок обязан оставаться правдой.
- Докблок `OurvendHealth.snapshotStale` получает вторую половину различия по R-G-3 (первая — у сторожа, T3): поле про УЧЁТ и в `stock` всегда `false`, а СТОРОЖ `ourvend.snapshot_stale` следит за агентом в ОБОИХ режимах — это не рассогласование, а разные вопросы.
- Одиннадцать фикстур `OurvendHealth` получают два новых ключа. `sync-stale.service.test.ts:299` (`СЕРИЯ_ПУСТО`) — фикстура `ParityStreak`, у неё оба поля уже есть, и файл принадлежит T3: не трогать.

- [ ] **Step 1: Тесты RED — контракт и ядро.**
```ts
// packages/shared/src/vending-reports-contracts.test.ts
// в фикстуру ЗДОРОВЬЕ:
  parityStreak: 3,
  cutoverThreshold: 7,
  parityLastRed: "2026-08-25",
  parityStreakSince: "2026-08-26",
// в ключ-гвард (после "parity", "parityStreak"):
      "parityLastRed",
      "parityStreakSince",
// и новый тест рядом:
  it("дата последнего красного дня и начало серии — поля ЗДОРОВЬЯ, а не второго запроса (R-G-4)", () => {
    // `null` — законные значения: «красных не было» и «серии нет». Витрина
    // обязана печатать их словами, а не молчать.
    const чисто: OurvendHealth = { ...ЗДОРОВЬЕ, parityLastRed: null, parityStreakSince: null };
    assert.equal(чисто.parityLastRed, null);
    assert.equal(чисто.parityStreakSince, null);
    assert.match(ЗДОРОВЬЕ.parityLastRed!, /^\d{4}-\d{2}-\d{2}$/, "голые сутки, а не ISO-момент");
  });
```
```ts
// apps/core/src/ourvend/ourvend-health.service.test.ts
// В `Мир` добавить отказ серии — СИММЕТРИЧНО уже существующему `parityError`
// (`healthDb` :139): у `streak()` свои поводы отказать (журнал событий плюс
// настройка порога), и проверять её `catch` без этого нечем.
interface Мир {
  …
  /** Серия не посчиталась: отчёт обязан выжить и отдать оба поля как `null`. */
  streakError?: string;
}
// в `healthDb`, рядом со `streak` (:144):
    streak: async () => {
      if (м.streakError !== undefined) throw new Error(м.streakError);
      return м.streak ?? СЕРИЯ_ПО_УМОЛЧАНИЮ;
    },

// новые тесты в наборе про гейт катовера (:290-305)
  it("дата последнего красного дня и начало серии едут в здоровье — БЕЗ второго запроса (R-G-4)", async () => {
    // Серия уже считается внутри этого же `Promise.all`; до среза «Гигиена»
    // наружу брались только `greenDays` и `threshold`, а обе даты выбрасывались.
    const h = await сервис({
      runs: [УСПЕХ("r1", "2026-08-25T06:00:00Z")],
      streak: { greenDays: 3, threshold: 7, readyForCutover: false, days: [], lastRed: "2026-08-25", since: "2026-08-26" },
    }).health(20, СЕЙЧАС);
    assert.equal(h.parityLastRed, "2026-08-25");
    assert.equal(h.parityStreakSince, "2026-08-26");
    assert.equal(h.parityStreak, 3, "счёт серии не изменился");
  });

  it("серия не посчиталась — оба поля null, а отчёт жив", async () => {
    // Отчёт о здоровье — та витрина, которую владелец открывает в дни
    // катовера; ронять её из-за спутника нельзя, это уже решено своим `catch`.
    const h = await сервис({
      runs: [УСПЕХ("r1", "2026-08-25T06:00:00Z")],
      streakError: "журнал событий недоступен",
    }).health(20, СЕЙЧАС);
    assert.deepEqual([h.parityLastRed, h.parityStreakSince, h.parityStreak], [null, null, 0]);
  });
```
```ts
// apps/bot/src/analytics-brief.test.ts
  it("строка про красный день печатается из ЗДОРОВЬЯ, без второго запроса (R-G-4)", () => {
    const строки = formatOurvendHealth({ ...ЗДОРОВЬЕ, parityLastRed: "2026-08-25" });
    assert.ok(строки.join("\n").includes("последний красный день: 25.08.2026"));
  });

  it("красных не было — так и сказано: молчание владелец прочитал бы как потерянную строку", () => {
    const строки = formatOurvendHealth({ ...ЗДОРОВЬЕ, parityLastRed: null });
    assert.ok(строки.join("\n").includes("красных дней не было"));
  });

  it("в режиме retired строки про красный день нет: серии там нет вовсе", () => {
    const строки = formatOurvendHealth({
      ...ЗДОРОВЬЕ,
      parityLastRed: "2026-08-25",
      parity: { ...ЗДОРОВЬЕ.parity, mode: "retired" },
    });
    assert.ok(!строки.join("\n").includes("красный день"));
  });
```
```ts
// apps/bot/src/bot.test.ts — замена теста :693
  it("«сверка» ходит в Core ОДИН раз: серия по дням отдельным роутом больше не нужна", async () => {
    // Раньше отказ `/ourvend/parity/streak` молча отнимал у отчёта строку про
    // последний красный день. Теперь она едет полем здоровья, и второго
    // запроса нет — ломаться нечему.
    const { core, вызовы } = стендСверки();
    await handle(сообщение("сверка"), core);
    assert.deepEqual(вызовы, ["health"], "второй роут из «сверки» убран (R-G-4)");
  });
```
```tsx
// apps/cc/src/components/ourvend-health-view.test.tsx — замена тестов «серия не пришла»
  it("«красных дней не было» печатается из здоровья, когда parityLastRed = null", () => {
    render(<OurvendHealthCard health={{ ...ЗДОРОВЬЕ, parityLastRed: null }} />);
    expect(screen.getByText(/красных дней не было/)).toBeVisible();
  });

  it("дата последнего красного дня — из здоровья, вторым запросом за ней никто не ходит", () => {
    render(<OurvendHealthCard health={{ ...ЗДОРОВЬЕ, parityLastRed: "2026-08-25" }} />);
    expect(screen.getByText(/последний красный день: 25\.08\.2026/)).toBeVisible();
  });
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter bot build && pnpm --filter core test && pnpm --filter bot test && pnpm --filter cc test` → RED (полей нет, сигнатуры со `streak`).
- [ ] **Step 3: Общий тип.** `packages/shared/src/vending-reports.ts`: два поля с докблоками из «Interfaces (produces)» сразу за `cutoverThreshold` (`:986`); в докблок `snapshotStale` (`:952-968`) дописать абзац:
```
   * СТОРОЖ И ЭТО ПОЛЕ — РАЗНЫЕ ВОПРОСЫ (R-G-3). Событие
   * `ourvend.snapshot_stale` (`SyncStaleService.checkSnapshot`) пишется в
   * ОБОИХ режимах: оно про АГЕНТА `ourvend:accounting` — приносит ли он
   * суточный снимок, из которого считается паритет. Это поле — про УЧЁТ:
   * остановился ли он от того, что снимка нет. В режиме `stock` не
   * остановился, поэтому здесь `false` и при вставшем агенте. Расхождения нет,
   * есть два разных утверждения.
```
- [ ] **Step 4: Ядро.** `apps/core/src/ourvend/ourvend-health.service.ts`, в `return` рядом с `parityStreak`/`cutoverThreshold`:
```ts
      // ДАТЫ СЕРИИ — ОТСЮДА, А НЕ ВТОРЫМ ЗАПРОСОМ (R-G-4). `серияПаритета` уже
      // посчитана выше в этом же `Promise.all`; до среза «Гигиена» обе даты
      // вычислялись и выбрасывались, а витрины ходили за ними в
      // `/ourvend/parity/streak` — и на его отказе теряли строку. Ноль новых
      // запросов. Роут остаётся: у него есть `days[]`, которого здесь нет.
      parityLastRed: серияПаритета.lastRed,
      parityStreakSince: серияПаритета.since,
```
- [ ] **Step 5: Литералы `OurvendHealth` — девять файлов, одиннадцать объектов.** Добавить `parityLastRed`/`parityStreakSince` в каждый: `apps/core/src/vending/weekly-digest.service.ts:129` (`ЗДОРОВЬЕ_НЕИЗВЕСТНО` — оба `null` с комментарием «не посчитали ≠ красных не было: причину говорит `note` рядом, а не молчание полей»), `apps/core/src/vending/weekly-digest.service.test.ts:276`, `packages/shared/src/vending-reports-contracts.test.ts:47`, `apps/bot/src/core-client.test.ts:113`, `apps/bot/src/analytics-brief.test.ts:204,755`, `apps/bot/src/weekly-digest.test.ts:70,336`, `apps/bot/src/weekly-delivery.test.ts:30`, `apps/cc/src/lib/core-types.test.ts:57` (и его ключ-гвард `:131`), `apps/cc/src/components/ourvend-health-view.test.tsx:42,59`. Не трогаем: `apps/core/src/ourvend/ourvend-health.service.test.ts` (здоровье там строит сервис, литерала нет) и `apps/bot/src/bot.test.ts:680` (свободный `as unknown as`-каст — новые ключи ему не нужны, меняется только тест про второй роут).
- [ ] **Step 6: Бот.** `handler.ts:420-423`:
```ts
      // ОДИН запрос: дата последнего красного дня едет полем здоровья (R-G-4).
      // Пока их было два, отказ `/ourvend/parity/streak` молча отнимал у
      // отчёта строку — «сверка» печаталась без неё и выглядела нормально.
      const здоровье = await deps.core.ourvendHealth();
      const [first, ...more] = formatOurvendHealth(здоровье);
```
`analytics-brief.ts`: `строкаКрасногоДня(h: OurvendHealth)` читает `h.parityLastRed`; `formatOurvendHealth(h: OurvendHealth)` теряет второй параметр; печать (`:932`) — `if (h.parity.mode !== "retired") lines.push(строкаКрасногоДня(h));`. Докблок `ourvendParityStreak` в `core-client.ts` — «роут отвечает `days[]` (пофакторный разбор 14 дней); счёт серии и обе даты едут в `/ourvend/health`».
- [ ] **Step 7: Панель.** `ourvend-health-view.tsx`: `OurvendHealthCard({ health })`; `красныйДень` считается из `health.parityLastRed` (ветки «нет данных» больше нет — поле есть всегда); `OurvendHealthSection` делает ОДИН `core.ourvendHealth().catch(() => null)`; импорт `ParityStreak` убрать, если он больше не нужен. Докблок `ourvendParityStreak` в `lib/core.ts` — как у бота.
- [ ] **Step 8:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter bot build && pnpm -s test && pnpm -s typecheck` → GREEN.
- [ ] **Step 9:** `git commit -m "feat(shared,core,bot,cc): дата последнего красного дня паритета едет в /ourvend/health вместо второго запроса (гигиена, R-G-4)" -- packages/shared/src/vending-reports.ts packages/shared/src/vending-reports-contracts.test.ts apps/core/src/ourvend/ourvend-health.service.ts apps/core/src/ourvend/ourvend-health.service.test.ts apps/core/src/vending/weekly-digest.service.ts apps/core/src/vending/weekly-digest.service.test.ts apps/bot/src/handler.ts apps/bot/src/analytics-brief.ts apps/bot/src/analytics-brief.test.ts apps/bot/src/core-client.ts apps/bot/src/core-client.test.ts apps/bot/src/weekly-digest.test.ts apps/bot/src/weekly-delivery.test.ts apps/bot/src/bot.test.ts apps/cc/src/lib/core.ts apps/cc/src/lib/core-types.test.ts apps/cc/src/components/ourvend-health-view.tsx apps/cc/src/components/ourvend-health-view.test.tsx`

---

### Сборка волны: интеграционный коммит (R-G-5)

Делается ПОСЛЕ того, как все четыре задачи в ветке. Один файл, одна правка — она
не принадлежит ни одной задаче, потому что `tools/smoke-core.mjs` занят T2, а поля
приносит T4.

- [ ] **Step 1:** `tools/smoke-core.mjs`, в проверку `/ourvend/health?runs=20` (`:441-447`), сразу за блоком `parityStreak`/`cutoverThreshold`:
```js
      // R-G-4: обе даты серии едут ЗДЕСЬ, а не вторым запросом. Ключи ОБЯЗАНЫ
      // присутствовать, даже когда они `null`: витрина отличает «красных не
      // было» от «поле не приехало» только их наличием — а на засеянной базе
      // журнал паритета пуст, и оба честно `null`.
      for (const ключ of ["parityLastRed", "parityStreakSince"]) {
        if (!(ключ in о)) throw new Error(`health.${ключ} — ключа нет`);
        if (о[ключ] !== null && !/^\d{4}-\d{2}-\d{2}$/.test(о[ключ]))
          throw new Error(`health.${ключ}=${о[ключ]} — не голые сутки YYYY-MM-DD и не null`);
      }
```
- [ ] **Step 2:** `node tools/smoke-core.mjs` на scratch-БД — зелено (и шаг здоровья, и сценарий задач ТО).
- [ ] **Step 3:** `git commit -m "test(smoke): даты серии паритета в проверке /ourvend/health (гигиена, R-G-4)" -- tools/smoke-core.mjs`

## Выкатка (спека §9)

> **Из задач плана прод НЕ пишется ни разу.** Единственные записи среза случаются САМИ после деплоя: монитор графиков в 06:00 Ташкент поставит до 19 задач ТО. Примерка бэкфилла (`--dry-run`) — только чтение.

1. **Ветка и PR.** `fix/gigiena-snek` от `main` b3b595d (+ коммит спеки). После `git checkout main` ПЕРВОЙ командой — `git checkout -b`: фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты. PR → CI зелёный (lint · typecheck · build · test · миграции на живом Postgres · `backfill-product-ids.js` без флагов · smoke-import · smoke-core · smoke-panel) → adversarial-ревью → squash-мерж.
2. **Полный прогон перед PR:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`; отдельно `pnpm --filter @mydon/db db:generate` → **«No schema changes»** (миграции в срезе нет; предложил файл — предикат разошёлся с `0040`); смоук на scratch-БД целиком: `createdb mydon_gigiena` → `migrate.js` → `seed.js` → `seed-vending.js` → `backfill-product-ids.js` → `SMOKE_SCRATCH=1 node tools/smoke-import.mjs` → `SMOKE_SCRATCH=1 node tools/smoke-core.mjs` → `node tools/smoke-panel.mjs` → `dropdb mydon_gigiena`.
3. **Деплой и сверка, что выкачено ИМЕННО это.** `GET /health` → `commit` совпадает с коммитом мержа: каталог обновляется за секунды, образ собирается минуты.
4. **Примерка резолвера — ЧТЕНИЕ (R-G-1).**
   ```bash
   docker exec -i mydon-core node packages/db/dist/backfill-product-ids.js --dry-run </dev/null
   ```
   Ожидание: `История склада (vending_stock_count): обновилось БЫ 3` — те самые три имени с «неправильным» разделителем (`Fresh Tag Lemonade CAN 0.45`, `Lit Energy Blueberry CAN 0.45`, `Royal Pomegranate CAN 0.3`); по трём остальным целям **0**, конфликтов **0**. Это и есть доказательство «ни одна прод-строка не меняет привязку от смены приоритета». `</dev/null` обязателен: без него остаток скрипта уходит в контейнер и шаги после молча не выполняются.
   **Если владелец уже прогнал `--apply` из чек-листа среза «Хвосты»,** три строки привязаны, и примерка законно покажет `0` — тогда доказательство читается прямым запросом:
   ```sql
   select product_name, product_id is not null as привязана from vending_stock_count
    where product_name in ('Fresh Tag Lemonade CAN 0.45','Lit Energy Blueberry CAN 0.45','Royal Pomegranate CAN 0.3');
   ```
   Ноль строк в выводе примерки — законный результат, а не провал шага.
5. **ЗАДАЧИ ТО — ПРЕДУПРЕДИТЬ ВЛАДЕЛЬЦА ЗАРАНЕЕ (R-G-2).** В ближайшие 06:00 Ташкент монитор поставит **до 19** задач обслуживания разом («Мойка миксера — <точка>»: KIUT M corp, KIMYO, KIUT CLINIC, KIUT Библиотека, KIUT Общежитие, American hospital, Grand clinic, 2/4 корпус кардиология, Logistics, Mevazor Med, OFB Яккасарайский фил, Olma Администрация, SKLAD 1C/8C/9C, SOLIQ OLMAZOR, UzPost Hall, Winners school, Zemfira…). Это НЕ сбой и не «прорвало»: с момента появления монитора не поставлено ни одной, потому что каждая вставка падала. Проверка после прогона (только чтение):
   ```sql
   select count(*) from task where created_by like 'agent:maintenance-monitor%';        -- ожидаем ≈19
   select count(*) from task where source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$';             -- ожидаем ≈19
   select count(*) from event where type = 'maintenance.monitor_failed';                -- ожидаем 0
   ```
   На СЛЕДУЮЩЕЕ утро число задач расти НЕ должно (тот же `dayKey` — тот же ключ): рост означает, что дедуп не сработал, и первым делом смотрят, не уехал ли `dayKey` из голых суток.
   Потолка на число задач за прогон срез не вводит намеренно (R-G-6): это П7, и здесь он спрятал бы первый честный результат за незнакомым порогом.
6. **Сторож снапшота (R-G-3).** `GET /ourvend/health` в действующем режиме `stock` → `snapshotStale: **false**` (поле осталось own-only — так и задумано). Событие `ourvend.snapshot_stale` появится, только если агент реально замолчит дольше 36 ч; на прод-данных (снимки ежедневно в 08:05, лаг ≈ 5,8 ч) первые сутки после выкатки обязаны пройти БЕЗ него:
   ```sql
   select count(*) from event where type = 'ourvend.snapshot_stale' and occurred_at > now() - interval '1 day';  -- ожидаем 0
   ```
   Единица здесь — не ложная тревога, а повод посмотреть на `max(fetched_at)` обеих таблиц снапшота: сторож называет, какая половина встала.
7. **Витрины (R-G-4).** «сверка» в боте и секция «Здоровье сбора» в панели печатают строку про последний красный день; в сетевых логах панели — ОДИН запрос к `/ourvend/health` вместо двух. `GET /ourvend/parity/streak` продолжает отвечать и несёт `days[]` (`docs/CUTOVER.md:61,141,333` им пользуются — эти команды остаются рабочими).
8. **Память и планы.** Отдельного шага нет: `docs/DATA_SOURCES.md` (T1), `docs/FIELD_OPS_SPEC.md` (T2), `docs/DEPLOY.md` и `docs/PLAN_STOCK_ABSORPTION.md` (T3) правятся внутри своих задач и к моменту мержа уже в коммитах.

## Самопроверка плана

**Покрытие рулингов спеки:**

| Рулинг | Где закрыт | Чем проверен |
|---|---|---|
| R-G-1 единая дверь резолва, спор явно, все вызывающие покрыты | T1 Steps 4–6 (`resolveCatalogName`, `canon`/`id` через неё, `catalog` вместо `aliasByKey`, три писателя необратимого) | `catalog-resolve.test.ts`: имя бьёт алиас · алиас на свою карточку не спор · источник `alias` · промах несёт `raw` · пустое → `miss` · алиас на удалённый товар · нормализация (запятая, «ё», пробелы, регистр) · **табличный тест на два прод-ключа × два порядка строк** · **три прод-имени истории**; `vending.service.test.ts`: чужой алиас не уводит · запятая ложится на карточку · спор пишет warn и берёт имя · спор не проставляет `product_id`; `refill.service.test.ts`: спор → отказ до записи; `backfill-product-ids.test.ts` остаётся зелёным без правок — он и есть контракт; выкатка §4 (примерка «обновилось БЫ 3») |
| R-G-2 конфликт по `source` с предикатом, смоук на живом Postgres | T2 Steps 3–7 (константа схемы, `where`, `@Matches`, событие агента, сценарий смоука) | `tasks.test.ts`: «вставка называет колонку И предикат» (тот же ОБЪЕКТ, что у схемы) · «предикат рендерится литералом без параметров»; `schema.test.ts`: «константа дословно совпадает с миграцией 0040»; `tasks.controller.test.ts`: голые сутки принимаются, четыре формы с временем отбиваются; `maintenance-monitor.test.ts`: 500 не роняет прогон · сбой пишет событие · чистый прогон не пишет; **`tools/smoke-core.mjs`: создание → повтор без дубля → следующий день → `dayKey` со временем отбит** — единственная застава, видящая `42P10`; выкатка §5 (≈19 задач, три `SELECT`) |
| R-G-3 сторож в обоих режимах, поле витрины own-only с докстрингом различия | T3 Steps 3–4 (снят `return`, переписан докстринг, две доки), T4 Step 3 (вторая половина докстринга у типа) | `sync-stale.service.test.ts`: «в `stock` 37 ч → событие» (замена теста `:390`) · «35 ч — тишина, порог не съехал» · «дедуп по ташкентским суткам и в `stock`» · **якорь «сторож тревожит, а `health.snapshotStale` остаётся `false`»** одним прогоном обоих сервисов; выкатка §6 (ноль событий за первые сутки) |
| R-G-4 `lastRed`/`since` в здоровье, второй вызов убран, роут жив | T4 Steps 3–7 + интеграционный коммит | контракты: ключ-гвард `OurvendHealth` (+2) и «`null` — законные значения»; ядро: «обе даты едут в здоровье» · «серия не посчиталась → оба `null`, отчёт жив»; бот: строка из здоровья · «красных не было» · нет строки в `retired` · **«сверка» ходит в Core ОДИН раз**; панель: два теста вместо «серия не пришла»; смоук: оба ключа обязаны присутствовать; роут `/ourvend/parity/streak` в диффе не удаляется — его троттл и тесты не тронуты |
| R-G-5 волна из четырёх непересекающихся задач | «Карта файлов» + матрица ниже | ни один путь не встречается в двух списках `Files`; спорные три файла назначены явно; два ключа смоука вынесены в интеграционный коммит |
| R-G-6 охват | Global Constraints, §10 спеки | в диффах нет `norm-fact.service.ts`, `sales.service.ts`, `ourvend.controller.ts`, файлов П7; событие `maintenance.monitor_failed` заведено БЕЗ правила |
| §6 спеки: миграций нет | T2 Step 3 + выкатка §2 | `db:generate` → «No schema changes»; в `packages/db/drizzle/` нового файла нет |
| §7 спеки: события | T2 Step 6 (`maintenance.monitor_failed`), T3 (условие `ourvend.snapshot_stale`) | тесты агента на оба направления; payload и дедуп сторожа не тронуты (десять снапшотных тестов переиспользуются) |
| §4 общие ограничения (время-параметр, показ ≠ решение, троттлы, ноль ≠ хорошо) | Global Constraints; T1·T3·T4 | `now` остаётся параметром во всех тронутых сигнатурах (`checkSnapshot(now)`, `health(runs, now)`, `retailFacts(days, catalog, now)`); порог сравнивается сырыми часами (T3 не трогает `snapshotStaleVerdict`); «красных не было» и «не посчитали» печатаются словами, а не пустотой |

**Матрица пересечений файлов (по спискам `Files`).** Пересечений нет:

| Область | T1 | T2 | T3 | T4 |
|---|---|---|---|---|
| `packages/shared/src` | `stock-history.ts`, `catalog-resolve.test.ts` | — | — | `vending-reports.ts`, `vending-reports-contracts.test.ts` |
| `packages/db/src` | `backfill-product-ids.ts` | `schema.ts`, `schema.test.ts` | — | — |
| `apps/core/src/vending` | `vending.service.ts` (+test), `analytics.service.ts`, `refill.service.ts` (+test) | — | — | `weekly-digest.service.ts` (+test) |
| `apps/core/src/tasks` | — | все четыре файла | — | — |
| `apps/core/src/ourvend` | — | — | `sync-stale.service.ts` (+test) | `ourvend-health.service.ts` (+test) |
| `apps/agents/src` | — | `maintenance-monitor.ts` (+test) | — | — |
| `apps/bot/src` | — | — | — | шесть файлов + тесты |
| `apps/cc/src` | — | — | — | четыре файла |
| `tools/` | — | `smoke-core.mjs` | — | — (два ключа — интеграционный коммит) |
| `docs/` | `DATA_SOURCES.md` | `FIELD_OPS_SPEC.md` | `DEPLOY.md`, `PLAN_STOCK_ABSORPTION.md` | — |

**Сканирование на заглушки.** В плане нет `TBD`, нет «add validation», нет «аналогично Task N» и нет «см. выше» вместо кода: каждый тест и каждый фрагмент реализации выписан там, где он нужен. Четыре места, где план сознательно НЕ выписывает код построчно, названы явно и заглушками не являются: (а) механическая замена `aliasByKey → catalog` в тринадцати местах и четырёх сигнатурах T1 Step 6 — её ведёт компилятор, и выписывать семнадцать одинаковых строк значило бы спрятать за ними единственное содержательное место (`resolveProduct`), а номера строк для каждой названы в `Files`; (б) добавление двух ключей в одиннадцать литералов девяти файлов T4 Step 5 — файлы и строки перечислены поимённо, значение у всех одно и то же; (в) фикстуры `ЗДОРОВЬЕ`/`стенд` в тестах, которые УЖЕ есть в этих файлах, — новые тесты их переиспользуют, а не переобъявляют; (г) точный текст абзацев документации — сказано, ЧТО обязано быть в них написано, потому что доки правятся связным текстом, а не патчем.

**Согласованность типов между задачами.** `CatalogResolution` объявлен ровно один раз (`packages/shared/src/stock-history.ts`, T1); `ProductIndex`/`CanonAnswer`/`CanonSource` остаются там же и НЕ переезжают — перенос ради красивого имени модуля стоил бы правок в `packages/db` и цикла «значение туда, типы обратно». `resolveCatalogName` принимает `Pick<ProductIndex, "explain">`, а не весь индекс: так её можно звать изнутри самого `productIndex` (там `explain` — локальная константа) и не заводить второй сборки карт. `OurvendHealth` живёт в `packages/shared/src/vending-reports.ts` (T4) — бот и панель его РЕЭКСПОРТИРУЮТ, своих копий нет, поэтому два новых поля не требуют правок зеркал типа: ломаются только фикстуры, и их ловит ключ-гвард. `ParityStreak` (T4 читает, не меняет) остаётся в `parity-streak.ts`; `sync-stale.service.test.ts:299` и `ourvend-health.service.test.ts:45` — его фикстуры, у них оба поля уже есть, и файлы принадлежат T3 и T4 соответственно. `TASK_SOURCE_DAY_PREDICATE` (T2) — `SQL`-значение drizzle, экспортируется из `packages/db` и импортируется Core; второй копии предиката в репозитории после среза нет (её отсутствие и проверяет тест «тот же ОБЪЕКТ, а не копия строкой»). Тип возврата `loadProductIndex()` меняется несовместимо (поле `aliasByKey` исчезает) — это НАМЕРЕННО: совместимая правка не показала бы девять мест, где канон считался мимо карточек.

**Известные риски исполнения.** (1) T1 меняет сигнатуру `resolveProduct` (шестнадцать вызовов) и тип возврата `loadProductIndex()` (тринадцать мест плюс четыре сигнатуры) — правку вести по одному файлу (`shared` → `db` → `core`), иначе `pnpm -s typecheck` покажет полтора десятка причин вместо одной. (2) Тест «спор пишет warn» подменяет `private readonly logger` через `as unknown as`: если поле переименуют, тест станет зелёным и слепым — поэтому он проверяет ещё и ВОЗВРАТ (`byName`), который от логгера не зависит. (3) T2 трогает `packages/db/src/schema.ts` — файл, где `db:generate` сравнивает снапшот: любой лишний символ в предикате родит миграцию, и это признак ошибки, а не повод её закоммитить. (4) Смоук-сценарий T2 пишет в `task` scratch-базы и за собой НЕ убирает — как соседние сценарии; на базе без слова «smoke» в имени прогон и так требует `SMOKE_SCRATCH=1`. (5) T4 трогает 18 файлов в четырёх пакетах, из них 9 — литералы фикстур: собирать `@mydon/shared` ПЕРЕД прогоном тестов core/bot обязательно, иначе `node --test` по dist прочитает старые типы и покажет ложную зелень. (6) Общий worktree с Codex: перед правкой дерева сверять `mtime` чужих файлов и коммитить только своими путями (`git commit -- …`); `git add -A` утащит чужое.
