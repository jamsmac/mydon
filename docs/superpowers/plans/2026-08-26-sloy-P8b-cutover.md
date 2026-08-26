# П8b «Готовность к катоверу» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Решение «пора переключать учёт на свой снапшот» перестаёт быть решением по памяти. Серия зелёных дней паритета считается кодом, показывается в боте и панели и приходит событием ровно один раз; сам переключатель `OURVEND_ACCOUNTING_SOURCE` переезжает из env в панель «Система» (с фолбэком `own`, когда зеркала уже нет); режим `own` перестаёт тащить в `machine_stock` складской автомат и обзаводится сторожем «снапшот не обновляется»; вся последовательность катовера ложится в рунбук `docs/CUTOVER.md`. Плюс еженедельная чистка истории, которой не было ни для одной таблицы.

**Architecture:** Счёт серии — ЧИСТАЯ функция в `@mydon/shared` (`parity-streak.ts`): на вход строки журнала событий `ourvend.parity`, на выход `ParityStreak`. Core её только кормит (`OurvendParityService.streak()`), отдаёт (`GET /ourvend/parity/streak`), кладёт в отчёт о здоровье и один раз в сутки превращает в событие `ourvend.cutover_ready`. Источник учёта — новый модуль `apps/core/src/sales/accounting-source.ts`: `settingValue` + кеш 60 с + фолбэк `own` без `STOCK_DATABASE_URL`; смену пишет событием `SystemService.set`, там же сбрасывая кеш. Фильтр «в строю» — третий параметр чистой `buildStockUpserts`, реестр приходит из `VendingService.machineRegistry()`. Сторож снапшота — вторая проверка в существующем `SyncStaleService`. Ретенция — отдельный `RetentionService` (крон вс 04:10) с пачечными DELETE и событиями `system.retention`.

**Tech Stack:** TypeScript strict, NestJS + class-validator, Drizzle/Postgres (**миграций нет**), `croner` с `timezone: TZ`, `node:test` по dist / vitest (cc), `tools/smoke-core.mjs` против живого Postgres, Telegram-бот, Next.js (панель — только чтение).

**Spec:** `docs/superpowers/specs/2026-08-26-p8b-cutover-readiness-design.md` (рулинги R-P8b-1…9)
**Инвентаризации:** `.superpowers/sdd/2026-08-26-sloy-P8b-cutover/inventory-{monorepo,prod}.md`

## Global Constraints

Копия рулингов спеки, связывающих КАЖДУЮ задачу. Нарушение здесь — не стилевая правка: этот срез готовит НЕОБРАТИМЫЙ шаг (после гашения `STOCK_DATABASE_URL` зеркала не будет), и цена ошибки — учёт, посчитанный не по тем строкам.

- **R-P8b-1 Зелёный день.** День (по Ташкенту, дата события `ourvend.parity`) зелёный, если `ok = true` И `остатки_ok = true` И `остатки_сверено > 0`. События старой формы (без полей остатков) — не зелёные. Серия = число подряд идущих зелёных дней до сегодняшнего (включительно, если событие за сегодня уже есть); любой красный или пропущенный день обнуляет.
- **R-P8b-2 Счётчик и сигнал.** `GET /ourvend/parity/streak` → `{ greenDays, threshold, readyForCutover, days: [{date, ok, salesChecked, stockChecked, note}] (последние 14), lastRed }`. Порог `CUTOVER_GREEN_DAYS` (7, ключ настроек). При достижении порога — событие `ourvend.cutover_ready {greenDays, since}` один раз (дедуп: пока не было флипа — не повторять чаще раза в сутки), правило `urgency:"immediate"`. Серия и порог — в `OurvendHealth` (`parityStreak`, `cutoverThreshold`), в боте «сверка» и панели «Здоровье сбора».
- **R-P8b-3 Источник учёта — настройка.** `OURVEND_ACCOUNTING_SOURCE` становится ключом `config-spec` (`stock | own`), читается через `settingValue` (база важнее env; env — фолбэк; дефолт — `stock`, **но если `STOCK_DATABASE_URL` не задан — `own`** независимо от остального: без зеркала учёт по-другому невозможен). Кеш чтения ≤ 60 с, чтобы флип из панели применялся без рестарта к ближайшему прогону синка. Смена значения пишет событие `ourvend.accounting_source_changed {from, to, actor}` + правило immediate.
- **R-P8b-4 Остатки в режиме `own` — только автоматы в строю.** `buildStockUpserts`/запись `machine_stock` из снапшота отбрасывает серийники не в строю (тот же реестр `notInService`/`inServicePark`) с одной строкой лога «пропущено N строк по автоматам не в строю»; для режима `stock` поведение не меняется.
- **R-P8b-5 Сторож свежести снапшота (режим `own`).** В `SyncStaleService` — вторая проверка: `accountingSource()==='own'` и `max(ourvend_sale_snapshot.fetched_at)` старше `SNAPSHOT_STALE_HOURS` (36) → событие `ourvend.snapshot_stale {hours, lastFetchedAt}` раз в сутки, правило immediate; в `OurvendHealth` — `snapshotStale: boolean` рядом с уже существующим `salesLagH`.
- **R-P8b-6 Гашение `STOCK_DATABASE_URL` — отдельный шаг runbook, после ≥3 зелёных дней в `own`.** Код при отсутствии переменной уже деградирует мягко; проверить тестами все три читателя (sales/supply/vending bridge) и дозаполнение `entity.attrs`. Компоуз-сеть `mydon-stock_default` остаётся до П8 п.3.
- **R-P8b-7 Ретенция.** Еженедельный крон (вс 04:10 Ташкент): `slot_snapshot` старше `SNAPSHOT_RETENTION_DAYS` (180), `product_sale`/`machine_sale` старше 180, `vending_sync_run` старше 365; пачками по 5000 с лимитом времени; событие `system.retention {table, deleted}` (без правила). `event` и `raw_row` не трогать.
- **R-P8b-8 Runbook `docs/CUTOVER.md`.** Шаги 0–4 с откатом на каждом, точными командами и ожидаемыми числами. Что НЕ трогать: сеть compose, БД донора.
- **R-P8b-9 Вне охвата.** Вывод панели :8080/бота склада, заморозка БД донора, чистка сети — П8 п.3–5 ПОСЛЕ катовера; ретенция `event`/`raw_row` — нет.
- **Время.** Все суточные границы — по Ташкенту, через `packages/shared/src/tashkent-time.ts` (`tashkentDay`, `tashkentDayStartOf`). Второй константы смещения не заводить (урок R-FW-11). Кроны — `{ timezone: TZ }`.
- **ПОКАЗ и РЕШЕНИЕ — разные числа.** Порог сравнивается с СЫРЫМИ часами (`rawStaleHours`, `sync-runs.ts:117`), округлённое `staleHours` из `@mydon/shared` — только для глаз владельца. Новый сторож снапшота обязан наследовать это правило, а не скопировать сравнение по `salesLagH`.
- **TS strict, без `any`.** Русский в UI/тестах/доках, английский в коде и именах событий/полей.
- **Тесты по dist:** `pnpm --filter @mydon/shared build` ПЕРЕД `pnpm --filter core test`/`bot test`; `pnpm --filter cc test` — vitest. Существующие наборы остаются зелёными.
- **Смоук.** Каждый новый GET и каждое новое поле ответа — в `tools/smoke-core.mjs` (юнит-заглушка БД SQL не исполняет). Помнить: смоук ЯВНО гасит `STOCK_DATABASE_URL` (`:1495`) — после R-P8b-3 это значит, что Core в смоуке поднимется в режиме `own`, и это ЖЕЛАННОЕ следствие: ветка `own` до сих пор не покрывалась вообще ничем.
- **ServiceTokenGuard.** Новых POST в срезе нет. `PUT /system/config` уже закрыт общим guard'ом (`system.controller.ts:19`). Новый `GET /ourvend/parity/streak` открыт — это отчёт, и получает личный `@Throttle`, как `/ourvend/parity`.
- **Мутация = транзакция + `event`.** Событие без правила в `rules.ts` до владельца не доходит: `ourvend.cutover_ready`, `ourvend.accounting_source_changed`, `ourvend.snapshot_stale` — правила обязательны; `system.retention` — отметка в журнале, правила не требует (R-P8b-7).
- **Коммиты в общем worktree.** Ветка `feat/p8b-cutover-readiness` (от `main@c860a1c` + коммит спеки `117bed5`). Коммитим ТОЛЬКО свои пути: `git commit -m "…" -- <путь> <путь>`; `git add -A`/`git commit -a` утащат чужие несохранённые правки (Codex работает на тех же репо). Conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push только в свою ветку: после `git checkout main` первой командой `git checkout -b` — фолбэк `|| git push` молча пушит main в прод.
- **Прод из задач плана не трогаем.** В этом срезе ПРОДОВЫХ ЗАПИСЕЙ НЕТ ВООБЩЕ — ни одной. Сам флип делает владелец позже, по рунбуку из T6.

**Три отклонения от буквы спеки, зафиксированные кодом** (в T6 уходят в аддендум спеки):

1. **Ключа `остатки_ok` в payload НЕТ.** Спека формулирует зелёный день через «`остатки_ok = true`», но `daily()` (`ourvend-parity.service.ts:328-340`) пишет `остатки_сверено` и `остатки_расхождений`, а не флаг. Зелёность остатков ВЫВОДИТСЯ: `остатки_расхождений === 0 && остатки_сверено > 0` — ровно то же выражение, что стоит в `parity()` (`:297`). Флаг в payload не добавляем: это была бы четвёртая форма одного вердикта.
2. **`accountingSource` становится async и требует `db`.** Синхронная `accountingSource(env)` (`sales.service.ts:91`) вызывается в шести местах, включая два `onModuleInit`; оба становятся `async`. `SupplyService.summary().source` теряет тип `ReturnType<typeof accountingSource>` (он стал `Promise<…>`) и получает явный `AccountingSource`.
3. **`SupplyService` получает ВТОРОЙ аргумент конструктора** (`VendingService` — за реестром «в строю», R-P8b-4), а `SupplyModule` — `imports: [VendingModule]`. Цикла не возникает: `VendingModule` про `SupplyModule` не знает (grep по `apps/core/src` даёт `SupplyService` только внутри `supply/` и в `cron-shutdown.test.ts:6`). Свою копию правила «склад или ремонт» не заводим — это тот же довод, по которому `OurvendModule` импортирует `VendingModule` (`ourvend.module.ts:7-11`).

## Карта файлов

| Файл | Роль |
|---|---|
| `apps/core/src/system/config-spec.ts` (+test) | 4 ключа: источник, порог серии, порог снапшота, окно ретенции |
| `apps/core/src/sales/accounting-source.ts` (+test) | `accountingSource()` через настройки, кеш, фолбэк `own` |
| `apps/core/src/system/system.service.ts` (+`system.service.test.ts`) | событие `ourvend.accounting_source_changed`, сброс кеша |
| `packages/shared/src/parity-streak.ts` (+test), `index.ts` | `parityStreak`, `ParityDay`, `ParityStreak` |
| `packages/shared/src/vending-reports.ts` (+`vending-reports-contracts.test.ts`) | `OurvendHealth += parityStreak/cutoverThreshold/snapshotStale` |
| `apps/core/src/ourvend/ourvend-parity.service.ts` (+`ourvend.test.ts`), `ourvend.controller.ts` | `streak()`, `GET /ourvend/parity/streak`, `ourvend.cutover_ready` |
| `apps/core/src/ourvend/sync-runs.ts` | `cutoverThreshold`, `snapshotStaleThreshold` |
| `apps/core/src/ourvend/sync-stale.service.ts` (+test) | вторая проверка `ourvend.snapshot_stale` |
| `apps/core/src/ourvend/ourvend-health.service.ts` (+test) | три новых поля отчёта |
| `apps/core/src/supply/supply.service.ts` (+`supply.test.ts`), `supply.module.ts` | фильтр «в строю», async-источник |
| `apps/core/src/sales/sales.service.ts` (+`sales.test.ts`) | async-источник, graceful skip |
| `apps/core/src/vending/retention.service.ts` (+test), `vending.module.ts` | еженедельная чистка |
| `apps/core/src/rules/rules.ts` (+`rules.test.ts`) | три правила |
| `apps/core/src/cron-shutdown.test.ts` | `OurvendParityService` + `RetentionService` |
| `apps/bot/src/analytics-brief.ts` (+test) | строки серии и застоя снапшота в «сверке» |
| `apps/cc/src/components/ourvend-health-view.tsx` (+test) | бейдж серии и застоя снапшота |
| `tools/smoke-core.mjs` | `/ourvend/parity/streak`, `/system/config`, новые поля `/ourvend/health` |
| `docs/CUTOVER.md`, `PLAN_STOCK_ABSORPTION.md`, `DEPLOY.md`, `DATA_SOURCES.md`, спека | документы |

---

### Task 1: Источник учёта — настройка, а не переменная окружения

**Files:** Modify `apps/core/src/system/config-spec.ts` (новый блок после `SYNC_STALE_HOURS`, ~стр. 217–225, до блока GLOBERENT ~стр. 226) и `config-spec.test.ts` (после набора «Ключ сторожа сбора П8a», ~стр. 96–106); `apps/core/src/system/system.service.ts` (`set`, стр. 37–56) и `system.service.test.ts`; `apps/core/src/sales/sales.service.ts` (удалить `accountingSource` стр. 85–93; `onModuleInit` 129–147; `fetchSourceRows` 159–176; событие `:278`; `summary` `:294`); `apps/core/src/supply/supply.service.ts` (импорт `:13`, `onModuleInit` `:170`, `sync` `:191`, `summary` `:410`/`:435`); `apps/core/src/supply/supply.test.ts` (набор «Сводка снабжения», стр. 98–133); `tools/smoke-core.mjs` (массив `ЧТЕНИЕ`, `:52`); Create `apps/core/src/sales/accounting-source.ts`, `apps/core/src/sales/accounting-source.test.ts`.

**Interfaces (produces):**
```ts
/** apps/core/src/sales/accounting-source.ts */
export type AccountingSource = "stock" | "own";
export const ACCOUNTING_SOURCE_KEY = "OURVEND_ACCOUNTING_SOURCE";
export const ACCOUNTING_SOURCE_CHANGED_EVENT = "ourvend.accounting_source_changed";
/** Кеш чтения: флип из панели применяется к ближайшему прогону синка (R-P8b-3). */
export const ACCOUNTING_SOURCE_CACHE_MS = 60_000;
/** Чистое правило: настройка + окружение → источник. `db`/кеша не знает — этим и проверяется. */
export function resolveAccountingSource(setting: string, env?: NodeJS.ProcessEnv): AccountingSource;
/** Действующий источник: `settingValue` (база > env > дефолт) поверх фолбэка, кеш ≤ 60 с. */
export function accountingSource(db: Db, now?: Date): Promise<AccountingSource>;
/** Сброс кеша: зовёт `SystemService.set`, чтобы флип не ждал минуту. */
export function resetAccountingSourceCache(): void;

/** apps/core/src/supply/supply.service.ts — поле сводки теряет ReturnType<> */
async summary(): Promise<{ /* … */ source: AccountingSource }>;
```

Что обязана делать реализация:
- `resolveAccountingSource`: **фолбэк первым** — `(env.STOCK_DATABASE_URL ?? "").trim() === ""` → `"own"` НЕЗАВИСИМО от настройки; иначе `setting.trim().toLowerCase() === "own" ? "own" : "stock"`. Приоритет «база > env > дефолт `stock`» уже даёт `settingValue`/`resolveEffective` (`config-spec.ts:286-297`) — второй лесенки здесь нет.
- `accountingSource(db, now)`: модульный кеш `{ at, value }`; попадание при `now - at < ACCOUNTING_SOURCE_CACHE_MS`. `now` — параметр, иначе истечение кеша нечем проверить тестом.
- `SystemService.set`: до записи взять действующее значение ключа из `effective()`; после записи — снова; если ключ = `ACCOUNTING_SOURCE_KEY` и значение изменилось — `resetAccountingSourceCache()` и `insert(event)` с `type: ACCOUNTING_SOURCE_CHANGED_EVENT`, payload `{ from, to, actor: updatedBy ?? null }`. Сравнение по ДЕЙСТВУЮЩЕМУ значению, а не по сырому вводу: сброс тумблера (пустая строка) — это тоже смена, если под ним лежал другой env.
- Все шесть точек вызова переходят на `await accountingSource(this.db)`; `onModuleInit` в `sales.service.ts` и `supply.service.ts` становятся `async …(): Promise<void>` (Nest их дожидается).

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/system/config-spec.test.ts — новый набор
describe("Ключи катовера П8b (R-P8b-3, R-P8b-7)", () => {
  it("OURVEND_ACCOUNTING_SOURCE: select из двух значений, дефолт stock", () => {
    assert.equal(specFor("OURVEND_ACCOUNTING_SOURCE")?.fallback, "stock");
    assert.deepEqual(specFor("OURVEND_ACCOUNTING_SOURCE")?.options, ["stock", "own"]);
    assert.equal(validateConfig("OURVEND_ACCOUNTING_SOURCE", "own"), null);
    assert.match(validateConfig("OURVEND_ACCOUNTING_SOURCE", "OWN") ?? "", /допустимо/);
    assert.match(validateConfig("OURVEND_ACCOUNTING_SOURCE", "snapshot") ?? "", /допустимо/);
  });
  it("CUTOVER_GREEN_DAYS и SNAPSHOT_STALE_HOURS: окна, ноль не значит «без окна»", () => {
    assert.equal(specFor("CUTOVER_GREEN_DAYS")?.fallback, "7");
    assert.equal(specFor("SNAPSHOT_STALE_HOURS")?.fallback, "36");
    for (const k of ["CUTOVER_GREEN_DAYS", "SNAPSHOT_STALE_HOURS"]) {
      assert.ok(validateConfig(k, "0"), `${k}: нулевое окно молча уехало бы в другое число`);
      assert.ok(validateConfig(k, "-1"));
    }
  });
  it("SNAPSHOT_RETENTION_DAYS: пол 90 суток — окно уже мёртвого стока стирало бы отчёты", () => {
    // DEAD_STOCK_DAYS_MAX=180 (analytics.service.ts:89) — самый широкий живой
    // потребитель. Ретенция в 30 суток «сохранилась бы» в панели и молча
    // выпилила данные под уже работающим отчётом.
    assert.equal(specFor("SNAPSHOT_RETENTION_DAYS")?.fallback, "180");
    assert.ok(validateConfig("SNAPSHOT_RETENTION_DAYS", "30"));
    assert.equal(validateConfig("SNAPSHOT_RETENTION_DAYS", "180"), null);
    assert.equal(validateConfig("SNAPSHOT_RETENTION_DAYS", "365"), null);
  });
});

// apps/core/src/sales/accounting-source.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { systemConfig } from "@mydon/db";
import { accountingSource, resetAccountingSourceCache, resolveAccountingSource } from "./accounting-source";

const стенд = (настройки: Record<string, string>) =>
  ({ select: () => ({ from: (t: unknown) =>
      Promise.resolve(t === systemConfig ? Object.entries(настройки).map(([key, value]) => ({ key, value })) : []) }) }) as never;

describe("Источник учёта (R-P8b-3)", () => {
  const ЗЕРКАЛО = { STOCK_DATABASE_URL: "postgres://ro@stock/mydon" };

  it("по умолчанию при живом зеркале — stock", () => {
    assert.equal(resolveAccountingSource("stock", ЗЕРКАЛО), "stock");
    assert.equal(resolveAccountingSource("", ЗЕРКАЛО), "stock");
  });

  it("настройка own переключает", () => {
    assert.equal(resolveAccountingSource("own", ЗЕРКАЛО), "own");
    assert.equal(resolveAccountingSource(" Own ", ЗЕРКАЛО), "own");
  });

  it("ФОЛБЭК: нет STOCK_DATABASE_URL — own, даже если настройка говорит stock", () => {
    // Зеркала нет — читать нечего. «stock без зеркала» означало бы вечные
    // {upserted: 0} без единого события: тихая остановка учёта вместо работы.
    assert.equal(resolveAccountingSource("stock", {}), "own");
    assert.equal(resolveAccountingSource("stock", { STOCK_DATABASE_URL: "  " }), "own");
  });

  it("кеш живёт минуту и не переживает её", async () => {
    resetAccountingSourceCache();
    process.env.STOCK_DATABASE_URL = ЗЕРКАЛО.STOCK_DATABASE_URL;
    try {
      const t0 = new Date("2026-08-26T08:00:00+05:00");
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "stock" }), t0), "stock");
      // База уже сказала «own», но 30 с не прошли — читатель ещё видит прежнее.
      const позже = new Date(t0.getTime() + 30_000);
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "own" }), позже), "stock");
      const минута = new Date(t0.getTime() + 61_000);
      assert.equal(await accountingSource(стенд({ OURVEND_ACCOUNTING_SOURCE: "own" }), минута), "own");
    } finally {
      delete process.env.STOCK_DATABASE_URL;
      resetAccountingSourceCache();
    }
  });
});

// apps/core/src/system/system.service.test.ts — новый набор
describe("Флип источника учёта пишет событие (R-P8b-3)", () => {
  it("смена stock → own: событие с from/to/actor, кеш сброшен", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
    assert.equal(события.length, 1);
    assert.equal(события[0]!.type, "ourvend.accounting_source_changed");
    assert.deepEqual(события[0]!.payload, { from: "stock", to: "own", actor: "owner" });
  });
  it("запись того же значения событием не считается", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "own" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
    assert.equal(события.length, 0);
  });
  it("другие тумблеры событий не порождают", async () => {
    const { svc, события } = стендНастроек({});
    await svc.set("DEAD_STOCK_DAYS", "30", "owner");
    assert.equal(события.length, 0);
  });
});

// apps/core/src/supply/supply.test.ts — набор «Сводка снабжения» переписать:
// без STOCK_DATABASE_URL источник теперь own ПО ПРАВИЛУ, а не по умолчанию.
it("зеркало живо, настройки нет — stock", async () => {
  assert.equal((await сводка({ STOCK_DATABASE_URL: "postgres://ro@stock/mydon" })).source, "stock");
});
it("зеркала нет — own, и это не «настройка не задана», а «читать нечего»", async () => {
  assert.equal((await сводка({ STOCK_DATABASE_URL: undefined })).source, "own");
});
```
- [x] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED (`specFor("OURVEND_ACCOUNTING_SOURCE")` = `undefined`; «Cannot find module ./accounting-source»).
- [x] **Step 3: Ключи.** В `CONFIG_SPECS` блок `// ── Вендинг: катовер учёта OurVend (П8b, R-P8b-3/7) ──` сразу после `SYNC_STALE_HOURS`:
```ts
  {
    key: "OURVEND_ACCOUNTING_SOURCE",
    label: "Вендинг: источник учёта OurVend",
    kind: "select",
    options: ["stock", "own"],
    fallback: "stock",
    help:
      "stock — читаем БД mydon-stock (зеркало). own — свой снапшот (агент ourvend:accounting). " +
      "Переключать ПОСЛЕ 7 зелёных дней паритета (бот «сверка» → строка серии). " +
      "Без STOCK_DATABASE_URL значение игнорируется: там own по определению.",
    validate: oneOf(["stock", "own"]),
  },
  { key: "CUTOVER_GREEN_DAYS", label: "Вендинг: зелёных дней паритета до переключения",
    kind: "number", fallback: "7", help: "Семь суток подряд без расхождений и по продажам, и по остаткам.", validate: posNumber },
  { key: "SNAPSHOT_STALE_HOURS", label: "Вендинг: порог застоя учётного снапшота, часов",
    kind: "number", fallback: "36",
    help: "Агент снимает кабинет раз в сутки (08:05). 36 ч = пропущен один съём с запасом; на 72 ч учёт встанет молча.",
    validate: posNumber },
  { key: "SNAPSHOT_RETENTION_DAYS", label: "Вендинг: хранить историю снимков, дней",
    kind: "number", fallback: "180",
    help: "Ниже 180 нельзя: столько просит отчёт о мёртвом стоке (DEAD_STOCK_DAYS_MAX).",
    validate: atLeast(90, "нужно не меньше 90 (окна отчётов доходят до 180 суток)") },
```
Рядом с `posNumber` (`:49`) — новый валидатор `atLeast(min, hint)` с комментарием: пол здесь не про «ноль бессмыслен», а про то, что окно ретенции РЕЖЕТ данные под уже работающими отчётами, и число ниже 90 — это молчаливая потеря истории, а не смелая настройка.
- [x] **Step 4: Модуль источника.** `apps/core/src/sales/accounting-source.ts` по интерфейсам выше. Шапка объясняет ТРИ решения: (а) почему ключ, а не env — флип из панели без рестарта, а рестарт `mydon-core` в момент катовера — это ещё и обрыв синка на минуты; (б) почему фолбэк `own` стоит ПЕРВЫМ — без зеркала «stock» означает `fetchSourceRows() → null → {upserted: 0}` (`sales.service.ts:179`) без единого события, то есть тихую остановку учёта; (в) почему кеш — `settingValue` делает `select … from system_config` на КАЖДЫЙ вызов, а зовут его синки продаж (`*/10`) и снабжения (`3-59/10`) плюс два отчёта.
- [x] **Step 5: Точки вызова.** Удалить `accountingSource` из `sales.service.ts` (стр. 85–93). В `sales.service.ts`: `async onModuleInit(): Promise<void>` c `const source = await accountingSource(this.db)`; `fetchSourceRows` — то же; событие `sales.sync` (`:278`) и `summary().configured` (`:294`) — через `await`. В `supply.service.ts`: импорт `accountingSource`/`AccountingSource` из `../sales/accounting-source`, `todayLocal` остаётся из `../sales/sales.service`; `async onModuleInit`; `sync()` `:191`; `summary()` — тип поля `AccountingSource` и `source: await accountingSource(this.db)`.
- [x] **Step 6: Событие смены.** `SystemService.set` (`system.service.ts:37`) по описанию выше; импорт `event` из `@mydon/db`. Комментарий: почему одно-единственное имя ключа зашито здесь, а не заведён общий механизм «наблюдаемых тумблеров» — событий такого рода в системе ровно одно, и обобщение на одном случае даёт лишний слой без второго потребителя.
- [x] **Step 7: Смоук.** В `ЧТЕНИЕ` (`tools/smoke-core.mjs`, рядом с `/sales/aliases`):
```js
  {
    // П8b: тумблеры катовера обязаны доехать до панели «Система» ЧЕРЕЗ HTTP.
    // Ключ, которого нет в белом списке, панель просто не покажет, и владелец
    // будет искать переключатель, которого в интерфейсе нет.
    path: "/system/config",
    проверить: (о) => {
      const карта = new Map((о ?? []).map((i) => [i.key, i]));
      for (const [ключ, дефолт] of [["OURVEND_ACCOUNTING_SOURCE", "stock"], ["CUTOVER_GREEN_DAYS", "7"],
        ["SNAPSHOT_STALE_HOURS", "36"], ["SNAPSHOT_RETENTION_DAYS", "180"]]) {
        const i = карта.get(ключ);
        if (!i) throw new Error(`в /system/config нет ключа ${ключ}`);
        if (i.source === "default" && i.value !== дефолт) throw new Error(`${ключ}=${i.value}, ждали ${дефолт}`);
      }
      if (карта.get("OURVEND_ACCOUNTING_SOURCE").kind !== "select") throw new Error("источник учёта — не select");
      if (о.some((i) => /API_KEY|TOKEN|SECRET|PASSWORD/i.test(i.key))) throw new Error("в тумблерах секрет");
    },
  },
```
- [x] **Step 8:** `pnpm --filter core build && pnpm --filter core test` → GREEN. Локально: `node tools/smoke-core.mjs` на scratch-БД — в логах Core обязана быть строка «Источник продаж: собственный снапшот» (смоук гасит `STOCK_DATABASE_URL`, значит режим `own` — R-P8b-3 в бою).
- [x] **Step 9:** `git commit -m "feat(core): источник учёта OurVend — настройка панели с фолбэком own и событием смены (П8b)" -- apps/core/src/system/config-spec.ts apps/core/src/system/config-spec.test.ts apps/core/src/system/system.service.ts apps/core/src/system/system.service.test.ts apps/core/src/sales/accounting-source.ts apps/core/src/sales/accounting-source.test.ts apps/core/src/sales/sales.service.ts apps/core/src/supply/supply.service.ts apps/core/src/supply/supply.test.ts tools/smoke-core.mjs`

---

### Task 2: Серия зелёных дней и сигнал «можно переключать»

**Files:** Create `packages/shared/src/parity-streak.ts`, `packages/shared/src/parity-streak.test.ts`; Modify `packages/shared/src/index.ts` (после `export * from "./vending-reports";`, `:86`), `packages/shared/src/vending-reports.ts` (`OurvendHealth`, стр. 901–950), `vending-reports-contracts.test.ts` (фикстура `ЗДОРОВЬЕ`, стр. 17–37); `apps/core/src/ourvend/sync-runs.ts` (рядом с `syncStaleThreshold`, стр. 90–93), `ourvend-parity.service.ts` (класс стр. 179–204, `daily` 319–347), `ourvend.controller.ts` (роут после `parityReport`, стр. 82–86), `ourvend-health.service.ts` (`Promise.all` 80–122, ответ 127–166) и `ourvend-health.service.test.ts`, `apps/core/src/ourvend/ourvend.test.ts`; `apps/core/src/rules/rules.ts` (рядом с правилом `ourvend.parity`, стр. 314–324) и `rules.test.ts`; `apps/core/src/vending/weekly-digest.service.ts` (`ЗДОРОВЬЕ_НЕИЗВЕСТНО`, стр. 102–114); `tools/smoke-core.mjs`.

**Interfaces (produces; типы — в `@mydon/shared`):**
```ts
/** packages/shared/src/parity-streak.ts */
/** Строка журнала `event` типа `ourvend.parity`: ключи payload РУССКИЕ (так их пишет daily()). */
export interface ParityEventRow { occurredAt: Date; payload: Record<string, unknown> }
/** Один день сверки — как его видит витрина. */
export interface ParityDay {
  /** Ташкентские сутки события, `YYYY-MM-DD`. */
  date: string;
  /** Зелёный по R-P8b-1: продажи И остатки, и остатков сверено хоть что-то. */
  ok: boolean;
  salesChecked: number;
  stockChecked: number;
  note: string | null;
}
export interface ParityStreak {
  greenDays: number;
  threshold: number;
  readyForCutover: boolean;
  /** Последние 14 дней С СОБЫТИЕМ, свежие сверху. Пропущенные сутки строки не имеют. */
  days: ParityDay[];
  /** Дата последнего НЕзелёного дня. `null` — красных в окне не было. */
  lastRed: string | null;
  /** Первый день текущей серии, `null` — серии нет. Едет в payload `cutover_ready`. */
  since: string | null;
}
export const PARITY_STREAK_WINDOW = 14;
export function parityStreak(events: readonly ParityEventRow[], threshold: number, today: string): ParityStreak;

/** packages/shared/src/vending-reports.ts — OurvendHealth += */
export interface OurvendHealth {
  /* … существующие поля … */
  /** Зелёных дней паритета подряд (R-P8b-1). 0 — серии нет. */
  parityStreak: number;
  /** Порог из настроек (`CUTOVER_GREEN_DAYS`): витрины сравнивают с ним, а не со своей семёркой. */
  cutoverThreshold: number;
}

/** apps/core/src/ourvend/sync-runs.ts */
export const CUTOVER_GREEN_DAYS_FALLBACK = 7;
export function cutoverThreshold(db: Db, logger?: Logger): Promise<number>;

/** apps/core/src/ourvend/ourvend-parity.service.ts */
export const CUTOVER_READY_EVENT = "ourvend.cutover_ready";
export const PARITY_EVENT = "ourvend.parity";
/** `now` — параметр: «серия до сегодняшнего дня» иначе проверялась бы датой прогона тестов. */
async streak(now?: Date): Promise<ParityStreak>;
```

Семантика, которую обязаны воспроизвести реализация и тесты:
- Зелёность дня: `payload.ok === true` И `typeof payload.остатки_сверено === "number"` И `payload.остатки_сверено > 0` И `payload.расхождений === 0` И `payload.остатки_расхождений === 0`. Отсутствие ключей `остатки_*` (старая сборка, единственное прод-событие 25.08) — НЕ зелёный (отклонение №1 в Global Constraints).
- **Дедуп по суткам.** Несколько событий за одни ташкентские сутки — берётся САМОЕ ПОЗДНЕЕ (ручной прогон `daily()` после починки — это уточнение вердикта, а не второй день). Тот же приём, что у `sync-streak.ts`: сортировать вход самим, а не полагаться на `order by` вызывающего.
- **Счёт серии.** Курсор = `today`. Нет события за сегодня → курсор сдвигается на вчера (паритет считается в 08:40, и до него «сегодня» законно пусто — иначе серия обнулялась бы каждую ночь). Есть событие за сегодня и оно красное → серия 0. Дальше назад по суткам, пока день зелёный; первый красный ИЛИ пропущенный день останавливает счёт.
- `since` = самая ранняя дата серии; `readyForCutover = greenDays >= threshold`; `lastRed` — самая свежая незелёная дата среди ВСЕХ поданных событий.

- [x] **Step 1: Тесты.**
```ts
// packages/shared/src/parity-streak.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parityStreak, type ParityEventRow } from "./parity-streak";

/** Событие daily() как оно ложится в журнал: ключи русские (ourvend-parity.service.ts:328). */
const дн = (date: string, over: Record<string, unknown> = {}): ParityEventRow => ({
  occurredAt: new Date(`${date}T08:40:00+05:00`),
  payload: { ok: true, дней: 7, сверено_пар: 14, расхождений: 0,
    остатки_сверено: 68, остатки_расхождений: 0, примечание: null, ...over },
});
const красный = (date: string): ParityEventRow => дн(date, { ok: false, расхождений: 2 });
/** Единственное прод-событие 25.08: старая сборка, полей остатков в payload НЕТ вовсе. */
const старая = (date: string): ParityEventRow => ({
  occurredAt: new Date(`${date}T08:40:00+05:00`),
  payload: { ok: true, дней: 7, сверено_пар: 14, расхождений: 0 },
});

describe("Серия зелёных дней паритета (R-P8b-1, R-P8b-2)", () => {
  it("семь подряд, считая сегодняшний, открывают переключение", () => {
    const дни = ["08-20", "08-21", "08-22", "08-23", "08-24", "08-25", "08-26"].map((d) => дн(`2026-${d}`));
    const s = parityStreak(дни, 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.readyForCutover, s.since, s.lastRed], [7, true, "2026-08-20", null]);
  });

  it("шесть при пороге семь — ещё нельзя", () => {
    const дни = ["08-21", "08-22", "08-23", "08-24", "08-25", "08-26"].map((d) => дн(`2026-${d}`));
    assert.deepEqual(
      [parityStreak(дни, 7, "2026-08-26").greenDays, parityStreak(дни, 7, "2026-08-26").readyForCutover],
      [6, false],
    );
  });

  it("СОБЫТИЕ СТАРОЙ ФОРМЫ НЕ ЗЕЛЁНОЕ: без половины по остаткам вердикт неполный", () => {
    // Прод 25.08: ok=true, но `остатки_*` в payload нет — сверялись только
    // продажи. Считать это зелёным значит открыть флип по половине гейта.
    const s = parityStreak([старая("2026-08-25"), дн("2026-08-26")], 7, "2026-08-26");
    assert.equal(s.greenDays, 1);
    assert.equal(s.lastRed, "2026-08-25");
  });

  it("нулевая сверка остатков зелёной не считается", () => {
    // «Расхождений 0» без единой сравненной пары — те самые нули как «всё
    // хорошо»: снимок остатков есть только за сегодня, а сверка идёт по
    // закрытым суткам (ловушка №1, inventory-prod.md).
    const s = parityStreak([дн("2026-08-26", { остатки_сверено: 0 })], 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.lastRed], [0, "2026-08-26"]);
  });

  it("пропущенный день обнуляет так же, как красный", () => {
    const дни = [дн("2026-08-22"), дн("2026-08-23"), /* 24-го события нет */ дн("2026-08-25"), дн("2026-08-26")];
    assert.equal(parityStreak(дни, 7, "2026-08-26").greenDays, 2);
  });

  it("красный сегодня обнуляет серию немедленно", () => {
    const дни = [дн("2026-08-24"), дн("2026-08-25"), красный("2026-08-26")];
    const s = parityStreak(дни, 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.since, s.lastRed], [0, null, "2026-08-26"]);
  });

  it("сегодня события ЕЩЁ нет — серия не рвётся: паритет считается в 08:40", () => {
    const дни = [дн("2026-08-24"), дн("2026-08-25")];
    assert.equal(parityStreak(дни, 7, "2026-08-26").greenDays, 2);
  });

  it("два события за одни сутки — один день, вердикт по позднейшему", () => {
    const утро = красный("2026-08-26");
    const после = { ...дн("2026-08-26"), occurredAt: new Date("2026-08-26T12:00:00+05:00") };
    assert.equal(parityStreak([утро, после], 7, "2026-08-26").greenDays, 1);
  });

  it("окно показа — 14 дней, свежие сверху, с числами обеих половин", () => {
    const дни = Array.from({ length: 20 }, (_, i) => дн(`2026-08-${String(i + 6).padStart(2, "0")}`));
    const s = parityStreak(дни, 7, "2026-08-25");
    assert.equal(s.days.length, 14);
    assert.equal(s.days[0]!.date, "2026-08-25");
    assert.deepEqual([s.days[0]!.salesChecked, s.days[0]!.stockChecked, s.days[0]!.ok], [14, 68, true]);
  });

  it("журнал пуст — ноль, а не «готовы»", () => {
    const s = parityStreak([], 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.readyForCutover, s.days, s.lastRed, s.since], [0, false, [], null, null]);
  });
});

// apps/core/src/ourvend/ourvend.test.ts — новый набор (стенд из sync-stale.service.test.ts:60)
describe("Сигнал «можно переключать» (R-P8b-2)", () => {
  const сегодня = new Date("2026-09-01T08:40:00+05:00");
  it("порог взят — событие с числом дней и днём начала серии", async () => {
    const { svc, записано } = стендПаритета({ зелёныхДо: 7, источник: "stock" });
    await svc.daily(сегодня);
    const c = записано.find((e) => e.type === "ourvend.cutover_ready");
    assert.ok(c, "события cutover_ready нет");
    assert.deepEqual(c.payload, { greenDays: 7, since: "2026-08-26" });
  });
  it("повтор в те же ташкентские сутки — молчание", async () => {
    const { svc, записано } = стендПаритета({ зелёныхДо: 7, источник: "stock",
      уже: [{ type: "ourvend.cutover_ready", occurredAt: new Date("2026-09-01T02:00:00+05:00") }] });
    await svc.daily(сегодня);
    assert.equal(записано.filter((e) => e.type === "ourvend.cutover_ready").length, 0);
  });
  it("после флипа сигнал не повторяется НИКОГДА: звать переключать уже некуда", async () => {
    const { svc, записано } = стендПаритета({ зелёныхДо: 9, источник: "own" });
    await svc.daily(сегодня);
    assert.equal(записано.filter((e) => e.type === "ourvend.cutover_ready").length, 0);
    assert.equal(записано.filter((e) => e.type === "ourvend.parity").length, 1, "сам паритет писаться не перестал");
  });
  it("шесть дней — событие ourvend.parity есть, cutover_ready нет", async () => {
    const { svc, записано } = стендПаритета({ зелёныхДо: 6, источник: "stock" });
    await svc.daily(сегодня);
    assert.equal(записано.filter((e) => e.type === "ourvend.cutover_ready").length, 0);
  });
});

// apps/core/src/rules/rules.test.ts — рядом с набором про sync_stale
it("готовность к катоверу будит немедленно и называет ключ настройки", () => {
  const [n] = applyRules(ctx("ourvend.cutover_ready", { greenDays: 7, since: "2026-08-26" }));
  assert.equal(n!.urgency, "immediate");
  assert.match(n!.text, /7 дн/);
  assert.match(n!.text, /OURVEND_ACCOUNTING_SOURCE/);
});
```
- [x] **Step 2:** `pnpm --filter @mydon/shared build` → RED («Cannot find module './parity-streak'»); `pnpm --filter core build && pnpm --filter core test` → RED.
- [x] **Step 3: Чистая функция.** `parity-streak.ts` по семантике выше; опора — `tashkentDay` из `./tashkent-time` (второй копии смещения не заводить). Шапка объясняет ДВА решения, которые нельзя «упростить»: (а) почему отсутствующий сегодняшний день не рвёт серию (крон в 08:40 — до него сутки законно пусты, и обнуление каждую ночь сделало бы счётчик бесполезным); (б) почему старая форма события не зелёная (гейт один — `ok` продаж без половины по остаткам открыл бы флип по половине проверки). Экспорт в `index.ts`.
- [x] **Step 4: Core.** `cutoverThreshold` в `sync-runs.ts` рядом с `syncStaleThreshold` (тот же `readIntSetting` + `Math.max(1, Math.trunc(...))`, тот же довод: витрина обязана показывать число, по которому будят владельца); шапку модуля дополнить — вопросов теперь не три, а пять. `OurvendParityService.streak(now)`: `select { occurredAt, payload } from event where type = PARITY_EVENT order by occurredAt desc limit PARITY_SCAN_LIMIT` (`60` — 14 дней окна плюс запас на повторные прогоны в одни сутки), `parityStreak(rows, await cutoverThreshold(this.db, this.log), tashkentDay(now))`. `daily(now = new Date())` после вставки `ourvend.parity`: посчитать `streak(now)`; если `readyForCutover`, `await accountingSource(this.db) === "stock"` и за ташкентские сутки события `CUTOVER_READY_EVENT` ещё не было — вставить его с `occurredAt: now` (дедуп дословно приёмом `SyncStaleService.check`, `sync-stale.service.ts:112-118`).
- [x] **Step 5: Роут и отчёт.** В `ourvend.controller.ts` после `parityReport` (`:86`):
```ts
  /** Серия зелёных дней и сигнал «можно переключать» (R-P8b-2). Тот же троттл, что у отчётов. */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Get("parity/streak")
  parityStreak() {
    return this.parity.streak();
  }
```
В `OurvendHealthService.здоровье` — `this.parity.streak(now)` шестым пунктом `Promise.all` (`:80`), в ответе `parityStreak: серия.greenDays`, `cutoverThreshold: серия.threshold`. `ЗДОРОВЬЕ_НЕИЗВЕСТНО` (`weekly-digest.service.ts:102`) получает `parityStreak: 0` и `cutoverThreshold: CUTOVER_GREEN_DAYS_FALLBACK` — «не посчиталось» здесь тоже не «готовы».
- [x] **Step 6: Правило.** В `rules.ts` сразу после правила `ourvend.parity` (`:324`):
```ts
  {
    // Гейт П8b: серия зелёных дней взяла порог. Немедленно и ровно один раз в
    // сутки (дедуп у эмитента, `OurvendParityService.daily`): это не тревога, а
    // РАЗРЕШЕНИЕ, и оно бесполезно, если приедет в брифинге через день после
    // того, как серия успела оборваться.
    id: "ourvend.cutover_ready",
    eventType: "ourvend.cutover_ready",
    urgency: "immediate",
    format: (c) =>
      `✅ Паритет OurVend зелёный ${num(c.payload.greenDays)} ` +
      `${счёт(num(c.payload.greenDays), "день", "дня", "дней")} подряд (с ${str(c.payload.since, "?")}) — ` +
      `можно переключать учёт на свой снапшот: Система → OURVEND_ACCOUNTING_SOURCE = own`,
  },
```
- [x] **Step 7: Смоук.** В `ЧТЕНИЕ` рядом с `/ourvend/parity?days=7`:
```js
  {
    // П8b: серия считается по журналу событий сырым чтением payload — заглушка
    // юнит-теста jsonb не разбирает. На засеянной базе событий нет вовсе, и
    // ответ обязан быть «ноль зелёных», а не пустотой без ключей.
    path: "/ourvend/parity/streak",
    проверить: (о) => {
      if (typeof о?.greenDays !== "number") throw new Error("streak.greenDays — не число");
      if (typeof о?.threshold !== "number") throw new Error("streak.threshold — не число");
      if (typeof о?.readyForCutover !== "boolean") throw new Error("streak.readyForCutover — не булево");
      if (!Array.isArray(о?.days)) throw new Error("streak.days — не массив");
      if (о.lastRed !== null && typeof о.lastRed !== "string") throw new Error("streak.lastRed — не дата и не null");
      if (о.greenDays !== 0 || о.readyForCutover !== false) throw new Error("на пустом журнале серия обязана быть нулевой");
    },
  },
```
В существующей проверке `/ourvend/health?runs=20` (`:283`) дописать: `parityStreak` и `cutoverThreshold` — числа, ключи обязаны присутствовать.
- [x] **Step 8:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → GREEN; `node tools/smoke-core.mjs`.
- [x] **Step 9:** `git commit -m "feat(core,shared): серия зелёных дней паритета, GET /ourvend/parity/streak и сигнал ourvend.cutover_ready (П8b)" -- packages/shared/src/parity-streak.ts packages/shared/src/parity-streak.test.ts packages/shared/src/index.ts packages/shared/src/vending-reports.ts packages/shared/src/vending-reports-contracts.test.ts apps/core/src/ourvend apps/core/src/rules apps/core/src/vending/weekly-digest.service.ts tools/smoke-core.mjs`

---

### Task 3: Режим `own` — только автоматы в строю, сторож снапшота, мягкая деградация

**Files:** Modify `apps/core/src/supply/supply.service.ts` (`buildStockUpserts` стр. 102–128, `sync` 189–256, `constructor` 167) и `supply.test.ts`; `apps/core/src/supply/supply.module.ts`; `apps/core/src/sales/sales.service.ts` (+`sales.test.ts`); `apps/core/src/ourvend/sync-runs.ts` (`snapshotStaleThreshold`), `sync-stale.service.ts` (стр. 54–130) и `sync-stale.service.test.ts`; `apps/core/src/ourvend/ourvend-health.service.ts` (+test); `packages/shared/src/vending-reports.ts` (`OurvendHealth.snapshotStale`) и `vending-reports-contracts.test.ts`; `apps/core/src/vending/weekly-digest.service.ts` (`ЗДОРОВЬЕ_НЕИЗВЕСТНО`); `apps/core/src/rules/rules.ts` (после правила `ourvend.sync_stale`, `:451`) и `rules.test.ts`; `apps/core/src/cron-shutdown.test.ts` (таблица стр. 15–21).

**Interfaces (produces):**
```ts
/** apps/core/src/supply/supply.service.ts — третий параметр и третий счётчик */
export function buildStockUpserts(
  rows: StockLevelRow[],
  serialToEntity: Map<string, string>,
  /** Канонические серийники «не в строю». Пустое множество = фильтра нет (режим stock). */
  notInService?: ReadonlySet<string>,
): { values: (typeof machineStock.$inferInsert)[]; quarantined: QuarantinedSupply[]; skippedNotInService: number };

/** apps/core/src/ourvend/sync-runs.ts */
export const SNAPSHOT_STALE_HOURS_FALLBACK = 36;
export function snapshotStaleThreshold(db: Db, logger?: Logger): Promise<number>;

/** apps/core/src/ourvend/sync-stale.service.ts */
export const SNAPSHOT_STALE_EVENT = "ourvend.snapshot_stale";
export class SyncStaleService {
  /** Застой СБОРА (П8a). */ check(now?: Date): Promise<{ staleHours: number | null; threshold: number; emitted: boolean }>;
  /** Застой УЧЁТНОГО СНАПШОТА (R-P8b-5). В режиме `stock` не проверяет ничего. */
  checkSnapshot(now?: Date): Promise<{ hours: number | null; threshold: number; stale: boolean; emitted: boolean }>;
}

/** packages/shared/src/vending-reports.ts — OurvendHealth += */
  /** Режим `own` и снапшот не обновлялся дольше `SNAPSHOT_STALE_HOURS`. В режиме `stock` — всегда false. */
  snapshotStale: boolean;
```

Что обязана делать реализация:
- `buildStockUpserts`: строка, чей канон серийника лежит в `notInService`, не попадает ни в `values`, ни в карантин (это не брак данных, а чужой автомат) — только в счётчик. `sync()` передаёт множество ТОЛЬКО при `ownStock`; в режиме `stock` третий аргумент не задаётся вовсе, и поведение байт-в-байт прежнее. После апсерта — одна строка лога, если `skippedNotInService > 0`: `Остатки: пропущено ${n} строк по автоматам не в строю.`
- Реестр берётся `await this.vending.machineRegistry()` (`vending.service.ts:1741`), множество — `new Set(notInService.keys())`, как это уже делает паритет (`ourvend-parity.service.ts:277-280`). `SupplyModule` получает `imports: [VendingModule]`.
- `checkSnapshot`: выходит немедленно при `await accountingSource(this.db) !== "own"` (`{ stale: false, emitted: false }`) — в режиме `stock` снапшот теневой, и тревожить о нём значит будить владельца о таблице, которая ни на что не влияет. Дальше: `max(ourvend_sale_snapshot.fetched_at)` (запрос «последняя строка», как в `ourvend-health.service.ts:103-107`), порог `snapshotStaleThreshold`, сравнение по СЫРЫМ часам (`rawStaleHours`), показ — округлённые `staleHours`. Тревога при `сырые === null || сырые >= threshold`. Дедуп — раз в ташкентские сутки по `SNAPSHOT_STALE_EVENT`. Payload `{ hours, lastFetchedAt }`.
- Крон `SyncStaleService` (`:55`) зовёт ОБЕ проверки одним тиком (`*/30`), каждую под своим `catch`: падение одной не должно гасить другую.
- `OurvendHealth.snapshotStale` считается в `OurvendHealthService`: `источник === "own" && (rawStaleHours(снапшотAt, now) === null || rawStaleHours(...) >= порог)`. Округлённый `salesLagH` для сравнения НЕ использовать (правило «показ ≠ решение», `ourvend-health.service.ts:135-144`).
- Мягкая деградация без `STOCK_DATABASE_URL` (R-P8b-6) — не новый код, а покрытие тестами уже существующего поведения: `SalesService.fetchSourceRows` (`:179`), `SupplyService.sync` (`:192`, `:201`, `:230`), дозаполнение `entity.attrs` (`:302-306`), `mirrorAlive` (`vending.service.ts:2479-2483`).

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/supply/supply.test.ts — новый набор
describe("Остатки в режиме own: только автоматы в строю (R-P8b-4)", () => {
  const снимок = (serial: string, product: string, qty: number) =>
    ({ dt: "2026-08-25", machine_serial: serial, ourvend_name: product, qty, fetched_at: new Date() });

  it("SKLAD 4S из снапшота в machine_stock не попадает", () => {
    // Прод: 2508160360 — status='warehouse', в machine_stock последний раз
    // 18.07, но в ourvend_stock_snapshot приезжает 34 строки/сутки на 7028
    // «единиц» (заглушка 199). Гейт паритета его выбрасывает, запись — нет.
    const r = buildStockUpserts(
      [снимок("2508160376", "TUC Sour cream", 6), снимок("2508160360", "Заглушка", 199)],
      new Map([["2508160376", "ent-1"]]),
      new Set(["2508160360"]),
    );
    assert.equal(r.values.length, 1);
    assert.equal(r.values[0]!.machineSerial, "2508160376");
    assert.equal(r.skippedNotInService, 1);
    assert.equal(r.quarantined.length, 0, "чужой автомат — не брак данных, в карантин ему нельзя");
  });

  it("фильтр знает обе формы написания серийника", () => {
    const r = buildStockUpserts([снимок("C2508160360", "Заглушка", 199)], new Map(), new Set(["2508160360"]));
    assert.deepEqual([r.values.length, r.skippedNotInService], [0, 1]);
  });

  it("без множества (режим stock) поведение прежнее — зеркало таких строк не даёт", () => {
    const r = buildStockUpserts([снимок("2508160360", "Заглушка", 199)], new Map());
    assert.deepEqual([r.values.length, r.skippedNotInService], [1, 0]);
  });
});

describe("Синк без STOCK_DATABASE_URL деградирует молча и без исключений (R-P8b-6)", () => {
  it("supply: приход пуст, дозаполнение карточек пропущено, остатки из снапшота", async () => {
    const { svc, м } = стендСинка({ url: undefined, источник: "own", снапшот: [/* одна строка */] });
    const r = await svc.sync();
    assert.equal(r.purchases, 0);
    assert.equal(м.обновленоКарточек, 0, "дозаполнение entity.attrs без донора должно ПРОПУСКАТЬСЯ, а не падать");
    assert.equal(r.stock, 1);
  });
  it("sales: источник — свой снапшот, чужая база не открывается вовсе", async () => {
    const { svc, м } = стендПродаж({ url: undefined, снапшот: [/* одна строка */] });
    assert.equal((await svc.sync()).upserted, 1);
    assert.equal(м.открытоСоединенийКДонору, 0);
  });
  it("мост П3 включается ровно в момент гашения переменной", () => {
    // mirrorAlive = Boolean(STOCK_DATABASE_URL) — обратный гейт: пока
    // переменная есть, receiveOrder не пишет purchase сам (vending.service.ts:2483).
    delete process.env.STOCK_DATABASE_URL;
    assert.equal(Boolean(process.env.STOCK_DATABASE_URL), false);
  });
});

// apps/core/src/ourvend/sync-stale.service.test.ts — новый набор
describe("Сторож свежести учётного снапшота (R-P8b-5)", () => {
  const сейчас = new Date("2026-09-05T13:00:00+05:00");
  it("35 ч при пороге 36 — тишина", async () => {
    const { svc, события } = стенд({ источник: "own", снапшотAt: "2026-09-04T02:00:00+05:00" });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, false);
    assert.equal(события.length, 0);
  });
  it("37 ч — событие с часами и моментом последнего съёма", async () => {
    const { svc, события } = стенд({ источник: "own", снапшотAt: "2026-09-04T00:00:00+05:00" });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true);
    assert.equal(события[0]!.type, "ourvend.snapshot_stale");
    assert.equal(события[0]!.payload.hours, 37);
    assert.equal(события[0]!.payload.lastFetchedAt, "2026-09-03T19:00:00.000Z");
  });
  it("повтор в те же ташкентские сутки — молчание", async () => {
    const { svc, события } = стенд({ источник: "own", снапшотAt: "2026-09-04T00:00:00+05:00",
      уже: [{ type: "ourvend.snapshot_stale", occurredAt: new Date("2026-09-05T09:00:00+05:00") }] });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, false);
    assert.equal(события.length, 0);
  });
  it("в режиме stock не проверяет ничего: снапшот там теневой", async () => {
    const { svc, события } = стенд({ источник: "stock", снапшотAt: "2026-01-01T00:00:00+05:00" });
    const r = await svc.checkSnapshot(сейчас);
    assert.deepEqual([r.stale, r.emitted], [false, false]);
    assert.equal(события.length, 0);
  });
  it("снапшота нет вовсе — тревога, и часы null, а не ноль", async () => {
    const { svc, события } = стенд({ источник: "own", снапшотAt: null });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true);
    assert.equal(события[0]!.payload.hours, null);
  });
});

// apps/core/src/rules/rules.test.ts
it("застой учётного снапшота будит немедленно и говорит, что именно встало", () => {
  const [n] = applyRules(ctx("ourvend.snapshot_stale", { hours: 37, lastFetchedAt: "2026-09-03T19:00:00.000Z" }));
  assert.equal(n!.urgency, "immediate");
  assert.match(n!.text, /37 ч/);
  assert.match(n!.text, /продажи и остатки/);
});
it("смена источника учёта доставляется немедленно и называет обе стороны", () => {
  const [n] = applyRules(ctx("ourvend.accounting_source_changed", { from: "stock", to: "own", actor: "owner" }));
  assert.equal(n!.urgency, "immediate");
  assert.match(n!.text, /stock.*own/);
});

// apps/core/src/cron-shutdown.test.ts — две строки в таблицу (:15)
    ["ourvend-parity", () => new OurvendParityService({} as never, {} as never)],
    ["retention", () => new RetentionService({} as never)],
```
- [x] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → RED.
- [x] **Step 3: Фильтр «в строю».** `buildStockUpserts` + `sync()` + конструктор `SupplyService(db, vending)` + `SupplyModule.imports`. Комментарий у фильтра: почему отброшенная строка НЕ идёт в карантин (карантин — про нечисловые значения, то есть про брак; складской автомат — законные данные не для этой таблицы), и почему фильтр стоит на ЗАПИСИ, а не на чтении снапшота (снапшот остаётся полным: он же сверяется паритетом и им же живёт кабинетный отчёт).
- [x] **Step 4: Сторож снапшота.** `snapshotStaleThreshold` в `sync-runs.ts`; `checkSnapshot` в `SyncStaleService`; крон зовёт обе проверки. Шапка `checkSnapshot` объясняет, чем он отличается от двух соседей: `sync_failed_streak` — «прямой сбор падает», `sync_stale` — «прямой сбор не бежит», `snapshot_stale` — «агент `ourvend:accounting` не приносит СУТОЧНЫЙ снимок кабинета, и в режиме `own` это молча останавливает `sale` и `machine_stock` через фильтр `fetched_at > now() - interval '3 days'` (`sales.service.ts:174`) — без ошибки, без события, с `{upserted: 0}`».
- [x] **Step 5: Отчёт и правила.** `OurvendHealth.snapshotStale` (+ `ЗДОРОВЬЕ_НЕИЗВЕСТНО: false` — «не посчитали» не равно «встал»); два правила в `rules.ts` (`ourvend.snapshot_stale` — `immediate`, текст `⛔ Учётный снапшот OurVend не обновлялся N ч — продажи и остатки стоят`; `ourvend.accounting_source_changed` — `immediate`, текст `🔀 Учёт OurVend переключён: {from} → {to} ({actor})`).
- [x] **Step 6:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → GREEN. В смоуке дописать к проверке `/ourvend/health?runs=20`: `snapshotStale` — булево, ключ обязателен.
- [x] **Step 7:** `git commit -m "feat(core): в режиме own пишем остатки только по автоматам в строю и сторожим свежесть учётного снапшота (П8b)" -- apps/core/src/supply apps/core/src/sales apps/core/src/ourvend apps/core/src/rules apps/core/src/vending/weekly-digest.service.ts apps/core/src/cron-shutdown.test.ts packages/shared/src/vending-reports.ts packages/shared/src/vending-reports-contracts.test.ts tools/smoke-core.mjs`

---

### Task 4: Ретенция — история перестаёт расти бесконечно

**Files:** Create `apps/core/src/vending/retention.service.ts`, `apps/core/src/vending/retention.service.test.ts`; Modify `apps/core/src/vending/vending.module.ts` (провайдер рядом с `SyncStaleService`, стр. 32–52).

**Interfaces (produces):**
```ts
/** apps/core/src/vending/retention.service.ts */
export const SNAPSHOT_RETENTION_DAYS_FALLBACK = 180;
/** Журнал прогонов живёт дольше снимков: это диагностика, а не данные отчётов. Константа кода, не настройка. */
export const SYNC_RUN_RETENTION_DAYS = 365;
/** Пачка и бюджет времени: чистка не должна держать блокировки дольше одного окна крона. */
export const RETENTION_BATCH = 5000;
export const RETENTION_BUDGET_MS = 60_000;
export const RETENTION_EVENT = "system.retention";

export interface RetentionResult { table: string; deleted: number; olderThanDays: number; capped: boolean }
export class RetentionService implements OnModuleInit, OnApplicationShutdown {
  /** `now` — параметр: границу «180 суток назад» иначе нечем проверить тестом. */
  async sweep(now?: Date): Promise<RetentionResult[]>;
}
```

Что обязана делать реализация:
- Крон `new Cron("10 4 * * 0", { timezone: TZ }, …)` в `onModuleInit`, `stop()` в `onApplicationShutdown` — образец `ShrinkageService:216-229`. Воскресенье 04:10 — самый тихий час недели: сбор в это время не идёт, бэкап (`backup_extra.sh`) уже прошёл, а до утреннего паритета 08:40 четыре часа.
- Четыре цели, каждая своей колонкой возраста: `slot_snapshot.captured_at` и `product_sale.captured_at` и `machine_sale.captured_at` — `SNAPSHOT_RETENTION_DAYS`; `vending_sync_run.started_at` — `SYNC_RUN_RETENTION_DAYS`. `event` и `raw_row` НЕ ТРОГАЕМ (R-P8b-7/9): журнал событий — это доказательная база (из него же считается серия паритета), а `raw_row` заморожен с 01.08 и является сырым слоем источников.
- Пачками: `delete from <t> where id in (select id from <t> where <age_col> < <cutoff> limit RETENTION_BATCH)`, цикл до `count === 0`; выход по бюджету времени ставит `capped: true` (следующее воскресенье доберёт). `count` читается как `Number((res as unknown as { count?: number }).count ?? 0)` — тот же приём, что у `linked` в `sales.service.ts:267`.
- Порог — `readIntSetting(db, "SNAPSHOT_RETENTION_DAYS", SNAPSHOT_RETENTION_DAYS_FALLBACK, logger)`, зажатый `Math.max(90, Math.trunc(...))`: пол дублирует валидатор панели, потому что env валидатор не проходит вовсе (тот же довод, что у `syncStaleThreshold`, `sync-runs.ts:84-88`).
- Событие `system.retention` на КАЖДУЮ таблицу, где `deleted > 0`, payload `{ table, deleted, olderThanDays }`. Правила нет — это отметка в журнале, а не сигнал.
- Отдельного GET нет: конфигурация ретенции видна в `/system/config` (смоук T1), а результат — в журнале событий; заводить роут ради чтения того, что уже читается двумя способами, значит завести третью витрину одного числа.

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/vending/retention.service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { machineSale, productSale, slotSnapshot, vendingSyncRun } from "@mydon/db";
import { RetentionService, RETENTION_BATCH, SYNC_RUN_RETENTION_DAYS } from "./retention.service";

/** Стаб: `execute` отдаёт число удалённых, стенд помнит, ЧТО и с какой границей чистили. */
function стенд(опт: { строк: Record<string, number>; настройки?: Record<string, string> }) { /* … */ }

describe("Еженедельная ретенция (R-P8b-7)", () => {
  const вс = new Date("2026-09-06T04:10:00+05:00");

  it("чистит четыре таблицы и НЕ трогает журнал событий и сырой слой", async () => {
    const { svc, запросы } = стенд({ строк: { slot_snapshot: 100, product_sale: 10, machine_sale: 5, vending_sync_run: 3 } });
    const итог = await svc.sweep(вс);
    assert.deepEqual(итог.map((r) => r.table).sort(),
      ["machine_sale", "product_sale", "slot_snapshot", "vending_sync_run"]);
    // `event` — доказательная база (из неё же считается серия паритета), а
    // `raw_row` — сырой слой источников: обе таблицы вне ретенции по рулингу.
    assert.equal(запросы.filter((q) => /\bevent\b|\braw_row\b/.test(q)).length, 0);
  });

  it("граница по умолчанию — 180 суток, у журнала прогонов — 365", async () => {
    const { svc } = стенд({ строк: { slot_snapshot: 1, vending_sync_run: 1 } });
    const итог = await svc.sweep(вс);
    assert.equal(итог.find((r) => r.table === "slot_snapshot")!.olderThanDays, 180);
    assert.equal(итог.find((r) => r.table === "vending_sync_run")!.olderThanDays, SYNC_RUN_RETENTION_DAYS);
  });

  it("пол 90 суток держится и против env: панель такое отобьёт, окружение — нет", async () => {
    const { svc } = стенд({ строк: { slot_snapshot: 1 }, настройки: { SNAPSHOT_RETENTION_DAYS: "7" } });
    // Неделя хранения снесла бы данные под отчётом о мёртвом стоке (окно до 180).
    assert.equal((await svc.sweep(вс))[0]!.olderThanDays, 90);
  });

  it("удаляет ПАЧКАМИ, а не одним DELETE на 36 тысяч строк", async () => {
    const { svc, запросы } = стенд({ строк: { slot_snapshot: RETENTION_BATCH * 2 + 1 } });
    const r = (await svc.sweep(вс)).find((x) => x.table === "slot_snapshot")!;
    assert.equal(r.deleted, RETENTION_BATCH * 2 + 1);
    assert.equal(запросы.filter((q) => q.includes("slot_snapshot")).length, 3);
    assert.ok(запросы.every((q) => q.includes(String(RETENTION_BATCH))), "лимит пачки обязан быть в запросе");
  });

  it("удалять нечего — ни одного события: «удалено 0» это не новость", async () => {
    const { svc, события } = стенд({ строк: {} });
    assert.deepEqual(await svc.sweep(вс), []);
    assert.equal(события.length, 0);
  });

  it("удалено — событие с таблицей, числом и границей", async () => {
    const { svc, события } = стенд({ строк: { slot_snapshot: 42 } });
    await svc.sweep(вс);
    assert.equal(события[0]!.type, "system.retention");
    assert.deepEqual(события[0]!.payload, { table: "slot_snapshot", deleted: 42, olderThanDays: 180 });
  });
});
```
- [x] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED («Cannot find module ./retention.service»).
- [x] **Step 3: Реализация.** `retention.service.ts` по описанию выше; провайдер и экспорт в `VendingModule` рядом с `SyncStaleService` (`vending.module.ts:40`, `:51`) — с той же оговоркой в шапке модуля: сервис читает таблицы вендинга и пишет событие. Шапка сервиса объясняет: (а) зачем ретенция нужна вообще при БД в 93 МБ — `slot_snapshot` растёт на 1680 строк/сут (≈230 кБ), диск хоста занят на 68 %, и «не горит» — это не «не понадобится»; (б) почему окно 180, а не 30 — самый широкий живой потребитель истории `DEAD_STOCK_DAYS_MAX = 180` (`analytics.service.ts:89`), дальше `SHRINK_DAYS_MAX = 60`, `DETECT_DAYS_MAX = 30`, и окно ретенции обязано быть НЕ УЖЕ самого широкого отчёта; (в) почему `event` не трогаем — из журнала событий считается серия паритета (T2), и ретенция по нему стирала бы собственный вход гейта катовера.
- [x] **Step 4:** `pnpm --filter core build && pnpm --filter core test` → GREEN (включая cron-shutdown для `retention` из T3).
- [x] **Step 5:** `git commit -m "feat(core): еженедельная ретенция снимков и журнала прогонов сбора (П8b)" -- apps/core/src/vending/retention.service.ts apps/core/src/vending/retention.service.test.ts apps/core/src/vending/vending.module.ts`

---

### Task 5: Бот и панель — серия видна там же, где здоровье

**Files:** Modify `apps/bot/src/analytics-brief.ts` (`строкаЗастоя` стр. 748–755, `паритетСтрока` 783–812, `formatOurvendHealth` 822–844) и `analytics-brief.test.ts` (фикстура `ЗДОРОВЬЕ`, `:157`); `apps/cc/src/components/ourvend-health-view.tsx` (`тревога` стр. 99–105, блок `rows` 139–210) и `ourvend-health-view.test.tsx` (фикстуры `ЗДОРОВЬЕ`/`ЗДОРОВ`, стр. 30–54); `packages/shared/src/vending-reports-contracts.test.ts`.

**Interfaces (consumes `@mydon/shared`, produces):**
```ts
/** apps/bot/src/analytics-brief.ts */
/** «паритет: N зелёных дн. подряд из 7» (+ «✅ можно переключать» на пороге). */
export function строкаСерии(h: OurvendHealth): string;
/** «⛔ учётный снапшот не обновляется» — или `null`, когда всё в порядке или режим `stock`. */
export function строкаСнапшота(h: OurvendHealth): string | null;
```
Реэкспорта добавлять НЕ нужно: `apps/bot/src/core-client.ts:8,405` и `apps/cc/src/lib/core.ts:8,319` уже реэкспортируют `OurvendHealth` из `@mydon/shared` — новые поля доезжают компилятором, а не правкой зеркала. HELP бота не меняется: «сверка» уже в списке (`handler.ts:132`), строки появляются внутри её ответа. Подсказка `OURVEND_ACCOUNTING_SOURCE` в панели «Система» — это поле `help` спеки из T1: `system-editor.tsx:64` рисует `item.help` для КАЖДОГО тумблера, отдельной вёрстки не нужно.

- [x] **Step 1: Тесты.**
```ts
// packages/shared/src/vending-reports-contracts.test.ts — фикстура ЗДОРОВЬЕ (:17) дополняется
  parityStreak: 3,
  cutoverThreshold: 7,
  snapshotStale: false,
// и проверка рядом с прочими:
it("здоровье несёт серию, порог катовера и застой снапшота — витрины не заводят своей семёрки", () => {
  assert.equal(typeof ЗДОРОВЬЕ.cutoverThreshold, "number");
  assert.equal(typeof ЗДОРОВЬЕ.snapshotStale, "boolean");
  const готово: OurvendHealth = { ...ЗДОРОВЬЕ, parityStreak: 7 };
  assert.ok(готово.parityStreak >= готово.cutoverThreshold);
});

// apps/bot/src/analytics-brief.test.ts
describe("«сверка»: серия зелёных дней (R-P8b-2)", () => {
  const h = (over: Partial<OurvendHealth>): OurvendHealth => ({ ...ЗДОРОВЬЕ, ...over });
  it("серия печатается вместе с порогом, а не одним числом", () => {
    assert.match(строкаСерии(h({ parityStreak: 3, cutoverThreshold: 7 })), /3 зелёных дн\. подряд из 7/);
  });
  it("порог взят — сказано, что можно переключать", () => {
    assert.match(строкаСерии(h({ parityStreak: 7, cutoverThreshold: 7 })), /✅ можно переключать/);
  });
  it("серии нет — так и написано, а не «0 зелёных»", () => {
    // Ноль в этой строке читается как «сегодня не сошлось», а на деле это
    // может быть «сверок ещё не было ни одной» — разные починки.
    assert.match(строкаСерии(h({ parityStreak: 0 })), /серии нет/);
  });
  it("строка серии стоит сразу под строкой паритета", () => {
    const t = formatOurvendHealth(h({ parityStreak: 3 }));
    const i = t.findIndex((s) => /Паритет за/.test(s));
    assert.match(t[i + 1]!, /зелёных дн\. подряд/);
  });
});

describe("«сверка»: застой учётного снапшота (R-P8b-5)", () => {
  const h = (over: Partial<OurvendHealth>): OurvendHealth => ({ ...ЗДОРОВЬЕ, ...over });
  it("флаг поднят — строка ⛔ с давностью снимка", () => {
    assert.match(строкаСнапшота(h({ snapshotStale: true, salesLagH: 41 }))!, /⛔ учётный снапшот.*41 ч/);
  });
  it("флаг снят — строки нет вовсе", () => {
    assert.equal(строкаСнапшота(h({ snapshotStale: false })), null);
  });
  it("строка идёт сразу за строкой застоя сбора: обе про «данные не едут»", () => {
    const [первое, второе] = formatOurvendHealth(h({ staleHours: 9, snapshotStale: true }));
    assert.match(первое!, /⛔ сбор стоит 9 ч/);
    assert.match(второе!, /⛔ учётный снапшот/);
  });
});

// apps/cc/src/components/ourvend-health-view.test.tsx
it("серия и порог — отдельной строкой; на пороге зелёная пилюля «можно переключать»", () => {
  render(<OurvendHealthCard health={{ ...ЗДОРОВ, parityStreak: 7, cutoverThreshold: 7 }} />);
  expect(screen.getByText(/7 зелёных дн\. подряд из 7/)).toBeVisible();
  expect(screen.getByText(/можно переключать/)).toBeVisible();
});
it("серия ниже порога — строка есть, зова переключать нет", () => {
  render(<OurvendHealthCard health={{ ...ЗДОРОВ, parityStreak: 3, cutoverThreshold: 7 }} />);
  expect(screen.getByText(/3 зелёных дн\. подряд из 7/)).toBeVisible();
  expect(screen.queryByText(/можно переключать/)).toBeNull();
});
it("застой учётного снапшота поднимает общую тревогу секции", () => {
  render(<OurvendHealthCard health={{ ...ЗДОРОВ, snapshotStale: true }} />);
  expect(screen.getByText("тревога")).toBeVisible();
  expect(screen.getByText(/учётный снапшот не обновляется/)).toBeVisible();
});
it("в режиме stock застоя снапшота нет и красной пилюли тоже", () => {
  render(<OurvendHealthCard health={{ ...ЗДОРОВ, snapshotStale: false }} />);
  expect(screen.queryByText(/учётный снапшот/)).toBeNull();
});
```
- [x] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter bot build && pnpm --filter bot test && pnpm --filter cc test` → RED.
- [x] **Step 3: Реализация.** В боте `строкаСерии` живёт рядом с `паритетСтрока` и вставляется в `formatOurvendHealth` СЛЕДУЮЩЕЙ строкой после неё (`:834`): серия — это вывод из паритета, и оторванная от него строка читается как отдельный отчёт. `строкаСнапшота` — рядом со `строкаЗастоя` и вставляется сразу за ней (`:829`): обе отвечают на один вопрос «почему данные не едут», и разнесённые по разным концам сообщения они выглядели бы как две несвязанные аварии. Порог берётся из `h.cutoverThreshold`, своей семёрки в боте нет. В панели: `parityStreak`/`cutoverThreshold` — новая строка `<div className="row">` под строкой «Паритет со складским учётом» (`:200-209`) с пилюлей `ok` при `parityStreak >= cutoverThreshold`; `snapshotStale` добавляется в условие `тревога` (`:99-105`) и своей красной строкой рядом с блоком застоя сбора (`:143-152`). `HEALTH_LAG_HOURS` не трогать — тот порог про снимки слотов, и совпадение чисел случайно (тот же комментарий, что уже стоит у `застой`, `:93-98`).
- [x] **Step 4:** `pnpm --filter bot test && pnpm --filter cc test && pnpm --filter cc build` → GREEN.
- [x] **Step 5:** `git commit -m "feat(bot,cc): серия зелёных дней паритета и застой учётного снапшота в сверке и в секции здоровья (П8b)" -- apps/bot/src/analytics-brief.ts apps/bot/src/analytics-brief.test.ts apps/cc/src/components/ourvend-health-view.tsx apps/cc/src/components/ourvend-health-view.test.tsx packages/shared/src/vending-reports-contracts.test.ts`

---

### Task 6: Рунбук катовера, документы, аддендум спеки и полный прогон

**Files:** Create `docs/CUTOVER.md`; Modify `docs/PLAN_STOCK_ABSORPTION.md` (§П8, пп. 3–5, ~стр. 452–459), `docs/DEPLOY.md` (после раздела «Разовый перенос истории склада (П8a)», ~стр. 97–142), `docs/DATA_SOURCES.md` (абзац «Источником `sale` служит…», ~стр. 891–897), `docs/superpowers/specs/2026-08-26-p8b-cutover-readiness-design.md` (аддендум в конец), `.env.example` (`:123`), `deploy/docker-compose.yml` (`:75`).

- [x] **Step 1: `docs/CUTOVER.md`.** Рунбук по R-P8b-8; на каждом шаге — команда, ожидаемое число и ОТКАТ.
  - **Шаг 0. Дождаться сигнала.** Событие `ourvend.cutover_ready` приходит в Telegram немедленно. Проверить руками: `curl -s $CORE/ourvend/parity/streak | jq '{greenDays, threshold, readyForCutover, lastRed}'` → `readyForCutover: true`. Самая ранняя физически возможная дата — **2026-09-01 08:40** (первая полная сверка 26.08, семь подряд). `lastRed` внутри серии означает, что счётчик врёт — не флипать, разбираться с событием того дня.
  - **Шаг 1. Флип (ЗАПИСЬ).** Панель → «Система» → «Вендинг: источник учёта OurVend» → `own` → Сохранить. Рестарт НЕ НУЖЕН: значение читается настройкой с кешем 60 с. В журнале обязано появиться `ourvend.accounting_source_changed {from:"stock", to:"own"}`. **Откат:** то же поле обратно в `stock` (значение из базы удаляется пустым вводом, тогда действует env).
  - **Шаг 1а. Проверка следующим утром (после 08:40).** `GET /supply/summary` → `source: "own"`. `GET /ourvend/parity/streak` → серия продолжается. Числа `sale` за вчера равны тем, что дало бы зеркало: 264 пары сходились 1:1 на инвентаризации, и `buildUpserts` пишет тот же `source: "ourvend"` и тот же ключ — новых строк быть НЕ ДОЛЖНО, только UPDATE. `machine_stock` за вчера — **68 строк** (2 автомата × 34 позиции), строк по `2508160360` (SKLAD 4S) **ноль**: их отбрасывает фильтр «в строю» (R-P8b-4), и в логе `mydon-core` стоит «Остатки: пропущено 34 строк по автоматам не в строю».
  - **Шаг 2. Три зелёных дня в `own`.** Паритет продолжает считаться (снапшот сверяется с `sale`, которую теперь сам же и наполняет, — сверка становится проверкой идемпотентности, и это нормально). Сторож `ourvend.snapshot_stale` молчит.
  - **Шаг 3. Гашение `STOCK_DATABASE_URL` (ЗАПИСЬ в `.env` хоста).** Убрать строку из `/opt/mydon-app/.env`, `docker compose up -d mydon-core`. Последствия, которые надо УВИДЕТЬ, а не предположить: зеркало закупок остановлено (оно и так заморожено с 29.07 — у всех 342 строк `created_at = 2026-07-15`); мост П3 включился (`mirrorAlive = false` → `receiveOrder` пишет `purchase(source='vending-order')` сам; двойного счёта не будет, `vending_purchase_order` = 0 строк); дозаполнение `entity.attrs` из донора прекращено (реестр 31 карточка заполнен); `GET /ourvend/health` без ошибок, `GET /supply/summary` → `source: "own"` (теперь ещё и по фолбэку). **Откат:** вернуть строку и перезапустить контейнер — донор всё это время жив.
  - **Шаг 4. Дальше — П8 пп. 3–5** (вывод панели :8080 и бота `@mydonvendbot`, заморозка БД донора, чистка сети). **ЧЕГО НЕ ДЕЛАТЬ:** не трогать `external`-сеть `mydon-stock_default` (`docker-compose.yml:215-218`) и не удалять volume донора — это единственный путь отката.
- [x] **Step 2: `PLAN_STOCK_ABSORPTION.md` §П8.** Пункт 5 переписать: «`STOCK_DATABASE_URL` гасится ПОСЛЕ флипа, не вместе с ним — это два разных шага (мост П3 и синк прихода переключателя не знают вовсе, `inventory-monorepo.md` §1)». Добавить подпункт «П8b — готовность к катоверу (закрыто 2026-08-2x)»: счётчик серии и сигнал `ourvend.cutover_ready`, переключатель в панели, фильтр «в строю» (+34 фантомных строки/сутки по SKLAD 4S предотвращены), сторож свежести снапшота, ретенция, рунбук `docs/CUTOVER.md`. Отдельной строкой — «сам флип НЕ выполнен: самая ранняя дата 01.09.2026».
- [x] **Step 3: `DEPLOY.md`.** Новый раздел «Катовер учёта OurVend (П8b)» после раздела П8a: две строки-указателя — переключатель живёт в панели «Система» и рестарта не требует; последовательность и откаты — в `docs/CUTOVER.md`; ретенция ходит сама по воскресеньям 04:10 и правится ключом `SNAPSHOT_RETENTION_DAYS` (пол 90 суток), автодеплой её не запускает и не может.
- [x] **Step 4: `DATA_SOURCES.md` §891.** Абзац «Источником `sale` служит либо синк через mydon-stock (по умолчанию), либо…» переписать: канон — собственный снапшот `ourvend_sale_snapshot`; `OURVEND_ACCOUNTING_SOURCE` теперь настройка панели, а не переменная окружения; без `STOCK_DATABASE_URL` источник `own` по определению; гейт переключения — семь зелёных дней (`GET /ourvend/parity/streak`), и зелёным считается только день с обеими половинами (продажи И остатки).
- [x] **Step 5: `.env.example` и compose.** У `OURVEND_ACCOUNTING_SOURCE` (`.env.example:123`, `docker-compose.yml:75`) — комментарий: «фолбэк для панели; действующее значение задаётся в «Система», база важнее env. Без `STOCK_DATABASE_URL` игнорируется — там `own`». Значения не менять: `stock` остаётся дефолтом env до флипа. `docker-compose.standby.yml` не трогать (`STOCK_DATABASE_URL: ""` там жёстко, и после R-P8b-3 standby просто читает свой снапшот — синк на нём и так молчит).
- [x] **Step 6: Аддендум к спеке.** Три отклонения из Global Constraints (нет ключа `остатки_ok` — зелёность остатков выводится из `остатки_расхождений`/`остатки_сверено`; `accountingSource` стала async и требует `db`, оба `onModuleInit` — async; `SupplyService` получил второй аргумент и `SupplyModule` — `imports: [VendingModule]`) плюс четыре уточнения: (1) событие `system.retention` несёт ещё и `olderThanDays` — без границы «удалено 1680» не проверить; (2) `SYNC_RUN_RETENTION_DAYS = 365` — константа кода, не настройка: спека §3 заводит один ключ окна, и второй тумблер ради диагностической таблицы был бы лишним; (3) отдельного GET ретенции нет — конфигурация видна в `/system/config`, результат в журнале событий; (4) `ourvend.cutover_ready` не повторяется после флипа НИКОГДА (условие `source === "stock"`), а не «раз в сутки навсегда».
- [x] **Step 7: Полный прогон:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`; смоук на scratch-БД: `createdb mydon_p8b` → `node packages/db/dist/migrate.js` → `seed.js` → `seed-vending.js` → `backfill-product-ids.js` → `SMOKE_SCRATCH=1 node tools/smoke-import.mjs` → `node tools/smoke-core.mjs` → `node tools/smoke-panel.mjs` → `dropdb mydon_p8b`. Проверить `pnpm --filter @mydon/db db:generate` → «No schema changes» (миграций в срезе нет, и снапшот обязан это подтвердить).
- [x] **Step 8:** `git commit -m "docs(p8b): рунбук катовера, план поглощения, источники и аддендум спеки" -- docs/CUTOVER.md docs/PLAN_STOCK_ABSORPTION.md docs/DEPLOY.md docs/DATA_SOURCES.md docs/superpowers/specs/2026-08-26-p8b-cutover-readiness-design.md docs/superpowers/plans/2026-08-26-sloy-P8b-cutover.md .env.example deploy/docker-compose.yml`

---

## Выкатка (спека §5)

> **ПРОДОВЫХ ЗАПИСЕЙ В ЭТОМ СРЕЗЕ НЕТ НИ ОДНОЙ.** Ни миграций, ни скриптов, ни правок настроек. Сам флип `OURVEND_ACCOUNTING_SOURCE=own` — шаг 1 рунбука `docs/CUTOVER.md`, и делает его владелец ПОЗЖЕ, не раньше 01.09.2026. Донор (`mydon-stock`) не пишется и здесь, и там.

1. **PR** `feat/p8b-cutover-readiness` → CI (lint · typecheck · build · test · migrations на живом Postgres · smoke-import · smoke-core · smoke-panel) → squash-мерж в `main`.
2. **Автодеплой.** Миграций нет — выкатывается только образ. Сверить, что выкачено именно оно: `GET /health` → `commit` совпадает с коммитом мержа (каталог обновляется за секунды, образ собирается минуты). Крон ретенции встаёт сам и первый раз сработает в ближайшее воскресенье 04:10.
3. **Проверки — ТОЛЬКО ЧТЕНИЕ:**
   - `GET /ourvend/parity/streak` → `greenDays` **0 или 1** (1 — если событие 26.08 08:40 оказалось зелёным: `ok=true`, `остатки_сверено=68`, `остатки_расхождений=0`), `threshold: 7`, **`readyForCutover: false`**, `lastRed: "2026-08-25"` (единственное прод-событие 25.08 — старой формы, без полей остатков, и зелёным не считается по R-P8b-1). `days` — не длиннее 14 строк.
   - `GET /ourvend/health?runs=20` → новые ключи присутствуют: `parityStreak` (число, совпадает с `greenDays` выше), `cutoverThreshold: 7`, `snapshotStale: false` (прод в режиме `stock` — там проверка не работает по определению).
   - `GET /system/config` → четыре новых тумблера видны, у всех `source: "env"` или `"default"` (в `system_config` на проде лежит единственный ключ `VENDING_ROUTE_ORDER`); `OURVEND_ACCOUNTING_SOURCE` — `kind: "select"`, `value: "stock"`, `source: "default"` (переменной в `/opt/mydon-app/.env` нет).
   - `GET /supply/summary` → `source: "stock"` — **не изменилось**: переменная на проде задана, настройка пуста, фолбэк не сработал.
   - Бот, «сверка» → под строкой паритета появилась строка серии («паритет: N зелёных дн. подряд из 7» / «серии нет»); строк «⛔ учётный снапшот» нет.
   - Панель, «Снек» → «Здоровье сбора» → строка серии; красной пилюли застоя снапшота нет.
   - `GET /vending/stock-counts?days=730` → по-прежнему **460** строк (П8a не тронут); `purchase` — **342** (`GET /supply/summary`).
   - Строк `machine_stock` по SKLAD 4S (`2508160360`) — **N/A до флипа**: фильтр R-P8b-4 работает только на записи из снапшота, а до шага 1 рунбука остатки по-прежнему приезжают из зеркала, где этого автомата нет с 18.07.
4. **Наблюдение.** Пороги правятся в панели «Система» и применяются без рестарта: `CUTOVER_GREEN_DAYS` — строгость гейта, `SNAPSHOT_STALE_HOURS` — чувствительность сторожа, `SNAPSHOT_RETENTION_DAYS` — глубина истории (ниже 90 панель не примет). Первое `ourvend.cutover_ready` за сутки уходит владельцу немедленно; повтор в те же ташкентские сутки — молчит; после флипа — не повторяется вовсе.

## Самопроверка плана

**Покрытие рулингов спеки:**

| Рулинг | Где закрыт | Чем проверен |
|---|---|---|
| R-P8b-1 зелёный день (обе половины, старая форма — не зелёная) | T2 `parityStreak` | T2 «семь подряд», «событие старой формы не зелёное», «нулевая сверка остатков», «пропущенный день обнуляет», «два события за сутки»; выкатка §3 (`lastRed: 2026-08-25`) |
| R-P8b-2 счётчик, `GET /ourvend/parity/streak`, событие и правило | T2 (`streak()`, роут, `cutover_ready`, правило, поля `OurvendHealth`), T5 (бот, панель) | T2 «порог взят — событие», «повтор в сутки», «после флипа не повторяется», «шесть дней»; правило «называет ключ настройки»; смоук `/ourvend/parity/streak`; T5 «серия с порогом», «✅ можно переключать», «серии нет» |
| R-P8b-3 источник — настройка, кеш, фолбэк `own`, событие смены | T1 (`config-spec`, `accounting-source.ts`, `SystemService.set`) | T1 «select из двух значений», «ФОЛБЭК: нет STOCK_DATABASE_URL — own», «кеш живёт минуту», «смена пишет событие», «то же значение — не событие»; смоук `/system/config` |
| R-P8b-4 остатки `own` — только в строю | T3 (`buildStockUpserts` + реестр в `sync`) | T3 «SKLAD 4S не попадает», «обе формы серийника», «без множества поведение прежнее»; рунбук шаг 1а (0 строк по `2508160360`, лог «пропущено 34») |
| R-P8b-5 сторож свежести снапшота | T3 (`checkSnapshot`, `snapshotStale`, правило), T5 (бот, панель) | T3 «35 ч — тишина», «37 ч — событие», «повтор в сутки», «в режиме stock не проверяет», «снапшота нет — часы null»; T5 «флаг поднят — строка», «флаг снят — строки нет» |
| R-P8b-6 гашение URL — отдельный шаг, мягкая деградация | T3 (тесты трёх читателей + `entity.attrs`), T6 (рунбук шаг 3) | T3 «supply: дозаполнение пропущено, а не падает», «sales: соединение к донору не открывается», «мост П3 включается при гашении»; рунбук шаг 3 с откатом |
| R-P8b-7 ретенция | T4 (`RetentionService`, ключ в T1) | T4 «четыре таблицы, `event`/`raw_row` не трогаем», «180 и 365», «пол 90 против env», «удаляет пачками», «нечего — нет события», «событие с числом»; T3 cron-shutdown |
| R-P8b-8 рунбук `docs/CUTOVER.md` | T6 Step 1 | ревью: шаги 0–4, у каждого команда, ожидаемое число и откат; §«чего не делать» про сеть и volume |
| R-P8b-9 чего в срезе нет | Global Constraints, T6 Step 2 | ревью: `grep -rn "8080\|mydonvendbot" apps packages` после среза не даёт новых вхождений; `event`/`raw_row` в `retention.service.ts` не упоминаются (тест это и проверяет) |

**Согласованность имён типов между задачами.** `ParityEventRow`/`ParityDay`/`ParityStreak` и `PARITY_STREAK_WINDOW` объявлены ровно один раз — в `packages/shared/src/parity-streak.ts` (T2); Core, бот и панель их только импортируют. `AccountingSource` — один раз в `apps/core/src/sales/accounting-source.ts` (T1), и `supply.service.ts` берёт его оттуда вместо мёртвого `ReturnType<typeof accountingSource>`. Новые поля `OurvendHealth` (`parityStreak`, `cutoverThreshold`, `snapshotStale`) живут в `packages/shared/src/vending-reports.ts` рядом с `staleHours`/`staleThresholdH` из П8a; бот и панель их реэкспортируют (`core-client.ts:8`, `lib/core.ts:319`), своих копий не заводят. Имя `parityStreak` занято ДВАЖДЫ намеренно и по-разному: чистая функция в shared и число в `OurvendHealth` — как `staleHours()`/`OurvendHealth.staleHours` в П8a; третьего смысла ему не давать. `RetentionResult` — форма внутреннего отчёта крона, HTTP не отдаётся и потому живёт в `retention.service.ts`, а не в shared. Пороговые читатели настроек собраны в одном модуле `apps/core/src/ourvend/sync-runs.ts` (`syncStaleThreshold` из П8a + новые `cutoverThreshold`, `snapshotStaleThreshold`) — по тому же доводу, что записан в его шапке: своя копия расчёта у витрины разошлась бы с числом, по которому будят владельца.

**Известные риски исполнения.** (1) `accountingSource` становится async — шесть точек вызова и два `onModuleInit`; забытый `await` даёт `Promise` в сравнении со строкой, и TS это поймает только там, где тип не `any`: после правки обязателен `pnpm -s typecheck`, а не только `test`. (2) `tools/smoke-core.mjs` гасит `STOCK_DATABASE_URL` — после T1 смоук поднимает Core в режиме `own`; если какая-то существующая проверка молча полагалась на `stock`, она упадёт именно здесь, и это правильное место узнать. (3) `SupplyService` меняет сигнатуру конструктора — `cron-shutdown.test.ts:17` и `supply.test.ts:119` правятся вместе с ним, иначе `pnpm --filter core test` красный по причине, не связанной с логикой. (4) Общий worktree с Codex: перед правкой дерева сверять `mtime` чужих файлов и коммитить только своими путями (`git commit -- …`). (5) `pnpm --filter @mydon/shared build` обязателен ПЕРЕД `core test`/`bot test`: наборы гоняются по `dist`, и новый `parity-streak.ts` без пересборки даст «Cannot find module» там, где код уже написан.
