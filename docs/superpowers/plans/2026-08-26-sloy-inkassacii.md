# Инкассации: правда о пробеле — план реализации (5 задач)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Четыре вопроса владельца из §1 спеки получают честный ответ. `/gaps` перестаёт звать в VendCash за данными, которых там нет; у 386 перенесённых инкассаций появляется `client_key` — доказательство происхождения и защита от повторного удвоения; 247 строк `source='import'`, стоящих на пять часов раньше реальности, переезжают на своё место одной транзакцией с построчным аудитом; донор VendCash получает архив на хосте прода, после которого Railway-проект можно гасить, не теряя GPS сборов, `collection_history` и приёмщиков. Ни одной строки за окно 31.07.2025–29.01.2026 в срезе не появляется: их нет ни в одной системе.

**Architecture:** Ничего нового не изобретается там, где готовое уже есть. Ключ идемпотентности — та же колонка + `uniqueIndex`, что у `task`, `stock_movement`, `vending_refill`, `maintenance_log`; идемпотентный `create()` — тот же паттерн `onConflictDoNothing` + возврат существующей строки, что у `tasks.service.ts:86-97`. Оба разовых скрипта построены по образцу `import-stock-history.ts`: белый список аргументов ДО первого запроса, донор через `DonorReader` (тесту нужны массивы, а не Postgres), отчёт колонками, разборная строка `ИТОГИ(json):` для дымового прогона. Смещение зоны живёт ровно в одном месте — `packages/shared/src/tashkent-time.ts`, откуда T2 экспортирует константу и минуту; второй копии «пяти часов» ни в TS, ни в SQL не появляется. След правки — построчный `audit_log` (он же единственный настоящий путь отката) плюс одно событие в `event`; в ленту «Действия» правка не попадает по построению (`actions.service.ts:203` берёт только `source='realtime'`).

**Tech Stack:** TypeScript strict, NestJS + class-validator, Drizzle/Postgres (**одна миграция — следующий свободный номер**, колонка + уникальный индекс), `node:test` + `assert` по `dist` (core / bot / `@mydon/db` / `@mydon/shared`), vitest + Testing Library (cc), `tools/smoke-collections.mjs` против живого Postgres, Telegram-бот, Next.js App Router (панель — только словарь подписей).

**Spec:** `docs/superpowers/specs/2026-08-26-inkassacii-truth-design.md` (рулинги R-I-1…R-I-9, задачи T1–T5)
**Опись:** `.superpowers/sdd/2026-08-26-sloy-inkassacii/inventory.md` (каталог `.superpowers/` не версионируется; в этом worktree он ЕСТЬ и прочитан при написании плана)

> **База ветки.** `fix/inkassacii-truth` = `origin/main` **b3b595d** («Хвосты снек-контура», #217) + коммит спеки **9f7d61e**. Зависимостей от незамёрженных срезов нет.

> **Номер миграции — НЕ 0072 по умолчанию.** На момент написания последняя миграция в дереве — `0071_stock_count_retention_idx`, журнал `drizzle/meta/_journal.json` — 72 записи, `idx` 0…71. Но П6/П7 могут занять `0072` раньше: **перед генерацией посмотреть `packages/db/drizzle/` и `drizzle/meta/_journal.json` и взять первый незанятый номер**. Столкновение ловит новый сторож `migrations-chain.test.ts` — на CI, а не на проде, где второй файл с номером `0072` применился бы молча мимо журнала.

> **Что можно делать параллельно.** Волна A: **T1 ∥ T2** — множества файлов не пересекаются вовсе. Волна B: **T3 ∥ T4** — T3 требует T2 (ключ — доказательство происхождения), T4 требует T1 (дописывает раздел `DATA_SOURCES.md`, который заводит T1); между собой файлов не делят. Волна C: **T5** — после T2 и T3 (дым гоняет оба скрипта, сторож писателя лежит в файле, который правит T2). Матрица пересечений — в «Самопроверке плана».

## Global Constraints

Копия §4 спеки плюс рулинги, связывающие несколько задач. Нарушение здесь — не стилевая правка: срез трогает ЕДИНСТВЕННЫЙ денежный журнал владельца (386 строк, 264 477 000 сум принятого) и делает это операцией, **не идемпотентной по природе** — повторный сдвиг даёт +10 часов.

- **R-I-1 Окно не импортируем.** Строк за 31.07.2025–29.01.2026 в срезе не появляется ни одной. Проверены все источники: VendCash — 1 строка в окне и та `cancelled`; MYDON — та же самая строка; банк (`money_flow.cash_symbol='0200'`) — 223 500 000 за авг–дек против 218 482 000 наличной выручки. Деньги дошли, отсутствуют только записи журнала.
- **R-I-2 `client_key` — идентичность строки В ИСТОЧНИКЕ, а не подпись каждой строки.** Заполняется только там, где источник существует вне MYDON: 386 перенесённых — `vendcash:collection:<uuid донора>`; бот — `bot:collect:<personId>:<machineId>:<минута по Ташкенту>`. Без ключа от клиента — `NULL`, и это законное состояние. Синтетический серверный `mydon:collection:<uuid>` **запрещён**: он уникален по построению и не защищает ни от чего (`apps/bot/src/core-client.ts:1055-1060`).
- **R-I-3 Ключ сопоставления бэкфилла — (код автомата, момент, сумма).** Статус в ключ НЕ входит, но сравнивается и печатается расхождением. Любая неоднозначность (два и более кандидата с одной стороны) — **печатается, не пишется**. Дедуп «по содержимому» запрещён: три одинаковых `manual_history` по 3 831 000 на 30.01.2026 внесены владельцем намеренно.
- **R-I-4 Сдвиг — только по доказанному множеству и только один раз.** `source = 'import' AND client_key LIKE 'vendcash:collection:%'`, ожидание 247. Четыре независимые заставы: строки `import` без ключа, отметка события, записи аудита, распределение часов. `source='import'` в одиночку доказательством НЕ является: DTO пускает `source` от клиента (`collections.controller.ts:44-45`).
- **R-I-5 След — `audit_log` построчно плюс одно событие.** `action='collection.time_corrected'`, `before`/`after` — строка целиком. В ленту «Действия» (`/team/actions`) правка НЕ попадает: лента собирается чтением доменных таблиц по установленному человеку (`actions.service.ts:22-33`) и берёт инкассации только `source='realtime'` (`:203`) — перенесённые строки не видны там ни до правки, ни после, по построению.
- **R-I-6 Бэкап перед правкой — полный дамп helper'ом, откат — из `audit_log.before`.** У `deploy/guards/db_access.sh` нет ключа `-t`: команда `dump` жёстко берёт `--schema=public --schema=drizzle` (`:143-147`, `:169-173`), а прод — managed-БД. Отдельного дампа таблицы `collection` не делаем.
- **R-I-7 Архив донора — шаг рунбука, а не код.** `pg_dump` клиентом **17-й версии** (`postgres:17-alpine`, тот же образ, что у `db_access.sh:18`); локальный `pg_dump` 15 сервер 17 не возьмёт, а `| gzip` спрячет отказ пустым файлом. Проверка — РАЗМЕРОМ (`ls -lh`), а не кодом возврата.
- **R-I-8 Коды `3be8c71f0000` / `3be8c71e0000` не сшиваются.** Ни один скрипт среза не угадывает, какой из них настоящий. 12 строк этого автомата уезжают в отчёт «без пары» — это ожидаемый результат примерки, а не провал.
- **R-I-9 GPS, `collection_history`, приёмщики — вне охвата.** Новые колонки и новая витрина (антифрод), размер L. Живёт в архиве донора (T4).
- **Время — только `packages/shared/src/tashkent-time.ts`.** Вторая копия смещения запрещена. Константа смещения **экспортируется оттуда** (T2), а не переписывается числом `5` в скрипте или `interval '5 hours'` в SQL.
- **«Сейчас» — параметр, а не `new Date()` внутри логики.** Ключ бота, отчёты скриптов и `occurredAt` события принимают `now` сверху; `new Date()` допустим ТОЛЬКО как значение параметра по умолчанию.
- **Мутации Core — под общим `ServiceTokenGuard`** (`apps/core/src/app.module.ts:83`); чтения — без токена. Новых роутов срез не заводит.
- **`@Throttle`** — только именованные лимитеры `burst`/`sustained` (`app.module.ts:42-43`); `default` ThrottlerGuard не читает. Троттлы существующих роутов не трогаем.
- **Скрипты.** Белый список аргументов ДО первого запроса к базе; донор — только SELECT, `max: 1`; строка подключения не печатается никогда (наружу — только host, правило `tools/smoke-import.mjs:127-134`). Коды возврата: `1` — аргументы/окружение, `2` — донор не подключён, `3` — застава отказала (данные не готовы либо правка уже сделана).
- **TS strict, без `any`.** Русский в UI, тестах и документации; экспортируемые идентификаторы — латиницей там, где рядом латиница (`tashkent-time.ts`, `page.tsx`), русские — там, где рядом русские (`packages/db/src/*`, `collections.service.ts`).
- **Ноль ≠ «всё хорошо».** Пустой результат примерки печатается словами («нечего писать»), а не молчанием.
- **Деньги — «N сум», минус — U+2212; числа в отчётах скриптов — без U+00A0.**
- **Документация правится ВНУТРИ задачи, которой она нужна** (`docs/DATA_SOURCES.md` — T1 и T4, `docs/DEPLOY.md` — T4), а не отдельным коммитом в конце.
- **Записей в прод из задач плана — НИ ОДНОЙ.** Все три записи (миграция автодеплоем, `backfill-collection-keys --apply`, `fix-collection-time --apply`) — ручные шаги раздела «Выкатка».
- **Тесты по dist:** `pnpm --filter @mydon/shared build` ПЕРЕД `pnpm --filter core test` / `pnpm --filter bot test` / `pnpm --filter @mydon/db test`; `pnpm --filter cc test` — vitest. Существующие наборы остаются зелёными.
- **Коммиты в общем worktree.** Ветка `fix/inkassacii-truth`. Коммитим ТОЛЬКО свои пути: `git commit -m "…" -- <путь> <путь>`; `git add -A` / `git commit -a` утащат чужие несохранённые правки (Codex работает на тех же репозиториях — перед правкой дерева сверять `mtime`). Conventional Commits + трейлеры `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` и `Claude-Session: …`. Push только в свою ветку: после `git checkout main` ПЕРВОЙ командой `git checkout -b` — фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты.

### Отклонения от буквы спеки, зафиксированные кодом

Четыре — каждое проверено в дереве, каждое уходит в аддендум спеки шагом T5 Step 9.

1. **Границы СРАВНЕНИЯ в детекторе 3 шире границ утверждения на сутки с каждой стороны.** Спека даёт условие `c.from >= ОКНО_СВЕРЕНО.с && c.to <= ОКНО_СВЕРЕНО.по` при `ОКНО_СВЕРЕНО = { с: "2025-07-30", по: "2026-01-30" }`. Но `c.from`/`c.to` — это **UTC-обрезка** момента (`gaps.service.ts:202`, `iv.с.slice(0, 10)`), а окно сверки названо ташкентскими сутками: момент до 05:00 по Ташкенту лежит в ПРЕДЫДУЩИХ UTC-сутках, и точное сравнение выкинуло бы боевой кластер (граница 30.07.2025 14:19) в ветку «периода не сверяли» при первом же сдвиге. Сдвиг T3 (+5 ч) двигает те же границы в обратную сторону. Поэтому рядом с `ОКНО_СВЕРЕНО` (утверждение, попадает в текст) стоит `ОКНО_СРАВНЕНИЯ = { с: "2025-07-29", по: "2026-01-31" }` (условие), и разница объяснена докблоком. Чинить саму UTC-обрезку срез не имеет права — это хвост среза К, явно вынесенный в §10.
2. **У `fix-collection-time.ts` ожидаемое число — флаг `--expect=<N>` с умолчанием 247, а не константа.** R-I-4 требует «иное число печатается и останавливает прогон», и это реализовано буквально. Но дымовой прогон T5 работает на фикстуре из двух строк, и с зашитой константой скрипт нельзя было бы прогнать НИ РАЗУ до прода — то есть единственная проверка транзакционности, уникального индекса и заставы «повтор отказывает» никогда бы не исполнилась. Флаг стоит в том же белом списке, печатается в строке режима и на проде не задаётся вовсе (умолчание 247).
3. **`docs/DEPLOY.md` целиком принадлежит T4.** Спека называет для T4 только раздел архива донора, а рунбуки двух скриптов не называет ни у кого. Разложить их по T2 и T3 значило бы отдать один файл трём задачам, две из которых (T3 и T4) идут одной параллельной волной. T4 — задача-рунбук, и она пишет все три раздела разом; команды берутся из этого плана, а не из готового кода, поэтому порядок задач ей не мешает.
4. **Словарь подписей в `apps/cc/src/app/audit/page.tsx` выносится в экспортируемую константу `ACTION_LABELS`, функция `describe` остаётся приватной обёрткой.** §8 требует тест «действие подписано по-русски, а не кодом» в `page.test.tsx`, а сегодня словарь — тело неэкспортируемой функции `describe` (`:22-54`), имя которой к тому же столкнулось бы с `describe` из vitest в самом тесте. Экспорт константы — две строки диффа, поведение страницы не меняется.

## Карта файлов

| Файл | Задача | Роль |
|---|---|---|
| `apps/core/src/gaps/gaps.service.ts` | T1 | `ОКНО_СВЕРЕНО` / `ОКНО_СРАВНЕНИЯ` / `ДОНОР_СВЕРЕН`, `журнальноеДействие()`, текст `action` (`:209`) |
| `apps/core/src/gaps/gaps.service.test.ts` | T1 | четыре теста текста + переименование `:167` |
| `docs/DATA_SOURCES.md` | T1·T4 | новый раздел «Инкассации: журнал, донор VendCash и окно» + строка про архив |
| `packages/shared/src/tashkent-time.ts` (+test) | T2 | `TASHKENT_OFFSET_MS` (экспорт), `tashkentMinute()` |
| `packages/db/src/schema.ts` | T2 | `collection.clientKey` + `uniqueIndex("collection_client_key")` |
| `packages/db/drizzle/00NN_collection_client_key.sql` + `meta/` | T2 | миграция (следующий свободный номер) и снапшот |
| `packages/db/src/schema.test.ts` | T2 | ключ и индекс объявлены |
| `packages/db/src/migrations-chain.test.ts` | T2 | сторож цепочки: файл ↔ журнал, номера уникальны и подряд |
| `packages/db/src/script-flags.ts` (+test) | T2 | общий белый список аргументов, два умолчания, числовые флаги |
| `packages/db/src/backfill-product-ids.ts` | T2 | `разобратьАргументы` → однострочная обёртка |
| `packages/db/src/backfill-collection-keys.ts` (+test) | T2 | бэкфилл ключей от донора |
| `packages/db/package.json` | T2·T3 | `db:backfill:collection-keys`, `db:fix:collection-time` |
| `apps/core/src/collections/collections.service.ts` | T2 | `clientKey` в `create()`, `onConflictDoNothing`, возврат первой строки |
| `apps/core/src/collections/collections.controller.ts` | T2 | `clientKey` в `CreateCollectionDto` |
| `apps/core/src/collections/collections.test.ts` | T2·T5 | четыре теста писателя (T2) + сторож «писатель ровно один» (T5) |
| `apps/bot/src/core-client.ts` | T2 | третий аргумент `clientKey` у `createCollection` |
| `apps/bot/src/staff.ts` (+test) | T2 | `collectionClientKey()`, `now` пятым параметром |
| `.env.example` | T2 | имя `VENDCASH_DATABASE_URL` с комментарием «в боевом `.env` пусто» |
| `packages/db/src/fix-collection-time.ts` (+test) | T3 | сдвиг +5 ч, четыре заставы, одна транзакция, аудит и событие |
| `apps/cc/src/app/audit/page.tsx` (+test) | T3 | `ACTION_LABELS` + подпись `collection.time_corrected` |
| `docs/DEPLOY.md` | T4 | архив донора + рунбуки обоих скриптов |
| `tools/smoke-collections.mjs` | T5 | дым обоих скриптов на фикстурном доноре |
| `.github/workflows/ci.yml` | T5 | вызов дыма после `smoke-import.mjs` |

---

### Task 1: Правда в `/gaps` и в документации — подсказка перестаёт звать за данными, которых нет

**Files:** Modify `apps/core/src/gaps/gaps.service.ts` (детектор 3: `journalHoleGaps` стр. 196–210, текст `action` стр. 209; константы модуля ставим над функцией, рядом с комментарием-разделителем стр. 190–195), `apps/core/src/gaps/gaps.service.test.ts` (набор «Реестр пробелов — дыра в журнале инкассаций», фабрика `interval()` стр. 122–137, тест стр. 167), `docs/DATA_SOURCES.md` (новый раздел после блока «Синк прихода из mydon-stock», перед `## Построчная сверка источников` стр. 780).

**Interfaces (consumes):** `ИнтервалСверки` (`apps/core/src/collections/collections.service.ts:39-70`), `clusterJournalHoles` / `RawJournalHole` (`gaps.service.ts:170-189`), `formatSum` (`gaps.service.ts:84`).

**Interfaces (produces):**
```ts
/** apps/core/src/gaps/gaps.service.ts */
/**
 * Окно, за которое сверка с донором ПРОВЕДЕНА (ташкентские сутки, границы
 * включительно). Это УТВЕРЖДЕНИЕ, попадающее в текст владельцу.
 */
const ОКНО_СВЕРЕНО = { с: "2025-07-30", по: "2026-01-30" } as const;

/**
 * Границы СРАВНЕНИЯ — шире утверждения ровно на сутки с каждой стороны.
 *
 * `c.from`/`c.to` — это UTC-обрезка момента (`iv.с.slice(0, 10)`, ниже по
 * файлу), а окно сверки названо ташкентскими сутками: момент до 05:00 по
 * Ташкенту лежит в ПРЕДЫДУЩИХ UTC-сутках. Боевая граница окна — 30.07.2025
 * 14:19 — сегодня стоит на пять часов раньше правды (срез правит это в T3), и
 * точное сравнение выкинуло бы кластер в ветку «периода не сверяли» — то есть
 * подсказка соврала бы в другую сторону. Чинить саму обрезку здесь нельзя:
 * это хвост среза К, у него своя причина и свои тесты.
 */
const ОКНО_СРАВНЕНИЯ = { с: "2025-07-29", по: "2026-01-31" } as const;

/** Когда сверяли донора. Дата в тексте — часть утверждения, а не украшение. */
const ДОНОР_СВЕРЕН = "26.08.2026";

/** Текст действия для кластера дыры: проверенный период и любой другой — разные утверждения. */
export function журнальноеДействие(from: string, to: string): string;
```

Что обязана делать реализация:
- В `journalHoleGaps` меняется РОВНО поле `action`: `action: журнальноеДействие(c.from, c.to)`. `topic`, `period`, `missing`, `scale` и вся кластеризация (`clusterJournalHoles`) не трогаются.
- Развилка обязательна: детектор общий и сработает на будущей дыре за другой период. Утверждать про непроверенный период «записей нет нигде» — такая же ложь, как сегодняшняя подсказка, только в другую сторону.
- Витрина (`apps/cc/src/components/gaps-book.tsx:98`) печатает `action` дословно — кода там нет. Бот пробелы не рендерит вовсе (вхождений `gaps` в `apps/bot/src` — ноль); записано, чтобы не искали.
- Функция экспортируется: текст, который обязан НЕ врать, надо чем-то проверять, а `journalHoleGaps` для этого требует построить интервал.

- [ ] **Step 1: Тесты RED.**
```ts
// apps/core/src/gaps/gaps.service.test.ts
// 1) в импорт из "./gaps.service" (стр. 32, рядом с journalHoleGaps) добавить:
//    журнальноеДействие

// 2) переименовать существующий тест :167 — тело НЕ меняется.
  it("КЛЮЧЕВОЙ ТЕСТ: дыра исчезает сама, когда интервал перестаёт быть пробелом (данными, а не выгрузкой)", () => {
    const было = journalHoleGaps([interval({ статус: "пробел в журнале" })]);
    assert.equal(было.length, 1);
    const стало = journalHoleGaps([interval({ статус: "обычный" })]);
    assert.deepEqual(стало, []);
  });

// 3) новый набор в конце блока детектора 3
describe("Реестр пробелов — что детектор дыры СОВЕТУЕТ сделать (R-I-1)", () => {
  it("окно внутри проверенного диапазона: записей нет ни в одной системе, и в VendCash не зовём", () => {
    // Донор проверен построчно 26.08.2026: те же 386 строк, внутри окна ОДНА
    // отменённая. Подсказка «выгрузить из VendCash» стоила бы владельцу похода
    // в Railway за данными, которых там нет.
    const gaps = journalHoleGaps([
      interval({ с: "2025-07-30T09:19:00.000Z", по: "2026-01-30T09:38:00.000Z", статус: "пробел в журнале" }),
    ]);
    assert.equal(gaps.length, 1);
    assert.ok(!/выгруз/i.test(gaps[0].action), "слова «выгрузка» в тексте быть не должно");
    assert.match(gaps[0].action, /записи не велись ни в одной системе/);
    assert.match(gaps[0].action, /26\.08\.2026/);
    assert.match(gaps[0].action, /признать окно пробелом либо реконструировать помесячно/);
  });

  it("окно за пределами проверенного диапазона: не утверждаем, что записей нет, — период не сверяли", () => {
    const gaps = journalHoleGaps([
      interval({ с: "2024-03-01T00:00:00.000Z", по: "2024-09-01T00:00:00.000Z", статус: "пробел в журнале" }),
    ]);
    assert.match(gaps[0].action, /проверить, велись ли записи за это окно/);
    assert.ok(!/не велись ни в одной системе/.test(gaps[0].action), "про непроверенный период так утверждать нельзя");
    assert.ok(!/выгруз/i.test(gaps[0].action), "и сюда VendCash звать больше не за чем");
  });

  it("граница, уехавшая на сутки UTC-обрезкой, остаётся ВНУТРИ проверенного диапазона", () => {
    // `c.from` — это `.slice(0, 10)` по ISO, то есть UTC-сутки. Боевая граница
    // 30.07.2025 14:19 по Ташкенту сегодня лежит в базе как 09:19Z, а после
    // T3 переедет на 14:19Z; при любой другой строке того же дня обрезка даёт
    // 29.07. Точное сравнение выкинуло бы кластер в «непроверенное».
    assert.match(журнальноеДействие("2025-07-29", "2026-01-31"), /не велись ни в одной системе/);
    assert.match(журнальноеДействие("2025-07-28", "2026-01-31"), /проверить, велись ли записи/);
    assert.match(журнальноеДействие("2025-07-29", "2026-02-01"), /проверить, велись ли записи/);
  });

  it("дата сверки и границы окна — константы модуля, а не стенные часы", () => {
    const первый = журнальноеДействие("2025-08-01", "2025-12-01");
    const второй = журнальноеДействие("2025-08-01", "2025-12-01");
    assert.equal(первый, второй, "текст обязан быть детерминированным");
    assert.match(первый, /VendCash сверен 26\.08\.2026/);
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → RED («журнальноеДействие is not a function», старый текст не совпадает).
- [ ] **Step 3: Константы и функция.** В `apps/core/src/gaps/gaps.service.ts`, над `journalHoleGaps` (после комментария-разделителя `:190-195`) — три константы из «Interfaces (produces)» с их докблоками и функция:
```ts
export function журнальноеДействие(from: string, to: string): string {
  // Сравнение строк `YYYY-MM-DD` лексикографически = хронологически — это и
  // есть причина, по которой голые сутки в репозитории живут строкой.
  if (from >= ОКНО_СРАВНЕНИЯ.с && to <= ОКНО_СРАВНЕНИЯ.по) {
    return (
      `за окно записи не велись ни в одной системе (VendCash сверен ${ДОНОР_СВЕРЕН}: те же 386 инкассаций, ` +
      `внутри окна — одна отменённая). Закрывается решением владельца: признать окно пробелом либо ` +
      `реконструировать помесячно из банковской выписки — выгружать из VendCash нечего`
    );
  }
  return (
    `проверить, велись ли записи за это окно. VendCash источником больше не является: донор сверен ` +
    `${ДОНОР_СВЕРЕН} и содержит те же 386 строк, что и MYDON`
  );
}
```
- [ ] **Step 4: Подстановка в детектор.** В `journalHoleGaps` (`:203-210`) единственная правка — строка `action`:
```ts
    action: журнальноеДействие(c.from, c.to),
```
Ничего больше в файле не меняется: `ОКНО_СВЕРЕНО` используется только как источник чисел для текста и как якорь докблока `ОКНО_СРАВНЕНИЯ` — если линтер потребует, сослаться на него прямо в тексте («окно ${ОКНО_СВЕРЕНО.с}…${ОКНО_СВЕРЕНО.по}» в ветке проверенного периода), но НЕ удалять: без него в файле не остаётся записи о том, какое именно окно сверено.
- [ ] **Step 5: Документация.** `docs/DATA_SOURCES.md`, новый раздел `## Инкассации: журнал, донор VendCash и окно 30.07.2025 – 30.01.2026` — ставится после блока «Синк прихода из mydon-stock» (перед `## Построчная сверка источников`, `:780`). Содержание — фактами, каждое число из описи:
  * журнал инкассаций в MYDON — 386 строк: 247 `source='import'` (это записи бота донора) и 139 `manual_history` (ручная история); принято 375 на 264 477 000 сум; строк в статусе `collected` сегодня нет ни одной;
  * донор — VendCash (Railway, проект «VendHub Cash bot»), сверен построчно **26.08.2026**: те же 386 строк, 385 совпали байт-в-байт, единственное расхождение — последняя живая строка 30.06.2026 (`collected` у донора, `cancelled` у нас);
  * автоматы сопоставляются по `machines.code` → `entity.external_ref` (нижний регистр + добивка нулём до 12 символов), **не по имени**: имена разошлись у восьми точек («American Hospital» = «SKLAD 7C», «Фидокор» = «Олма Офис» и далее);
  * окно **31.07.2025 – 29.01.2026** — промежуток между «довнесли историю вручную» (30.07.2025, 14 строк `manual_history`, принятых одним махом 05.03.2026) и «включили бота» (30.01.2026, 19 строк `realtime`). Внутри окна ОДНА строка, и та отменённая;
  * наличная выручка за окно — 262 520 000 сум, взносы в банк за авг–дек — 223 500 000 против 218 482 000 наличной выручки за те же месяцы: **деньги дошли, записей не делали**;
  * ссылка на архив донора — «см. `docs/DEPLOY.md`, раздел «Архив донора VendCash»» (сам архив описывает T4).

- [ ] **Step 6:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → GREEN (набор «Реестр пробелов» целиком, включая существующие тесты кластеризации). `pnpm -s typecheck`. `pnpm --filter core lint`.
- [ ] **Step 7:** `git commit -m "fix(core,docs): детектор дыры перестаёт звать в VendCash — окно проверено, записей нет нигде (инкассации, R-I-1)" -- apps/core/src/gaps/gaps.service.ts apps/core/src/gaps/gaps.service.test.ts docs/DATA_SOURCES.md`

---

### Task 2: `collection.client_key` — колонка, писатель, бэкфилл от донора

**Files:** Modify `packages/shared/src/tashkent-time.ts` (`СМЕЩЕНИЕ_МС` стр. 50, конец файла), `packages/shared/src/tashkent-time.test.ts`; `packages/db/src/schema.ts` (таблица `collection` стр. 260–296: поле рядом с `denominations` `:289`, индекс в списке `:293-296`); `packages/db/src/schema.test.ts`; `packages/db/src/backfill-product-ids.ts` (`ЗНАЕМ_ФЛАГИ` стр. 346, `разобратьАргументы` стр. 365–384); `packages/db/package.json` (блок `scripts`, рядом с `db:backfill:product-ids` стр. 27); `apps/core/src/collections/collections.service.ts` (`CreateCollectionInput` стр. 101–107, `create()` стр. 127–155, вставка стр. 135–144); `apps/core/src/collections/collections.controller.ts` (`CreateCollectionDto` стр. 5–20); `apps/core/src/collections/collections.test.ts` (заглушка `stub()` стр. 12–41, набор «Инкассация» стр. 43); `apps/bot/src/core-client.ts` (`createCollection` стр. 758–767); `apps/bot/src/staff.ts` (импорт `@mydon/shared`, `parseCollectCallback` стр. 236–240, `handleStaffCallback` стр. 626–630, ветка инкассации стр. 895–912); `apps/bot/src/staff.test.ts`; `.env.example` (блок «Синк снабжения» стр. 22–24). Create `packages/db/src/migrations-chain.test.ts`, `packages/db/src/script-flags.ts`, `packages/db/src/script-flags.test.ts`, `packages/db/src/backfill-collection-keys.ts`, `packages/db/src/backfill-collection-keys.test.ts`, `packages/db/drizzle/00NN_collection_client_key.sql` (+ `drizzle/meta/_journal.json`, `drizzle/meta/00NN_snapshot.json` — генерируются).

**Interfaces (consumes):** `uniqueIndex` из `drizzle-orm/pg-core` (уже импортирован в `schema.ts`), образец колонки-ключа — `task.clientKey` (`schema.ts:221/243`), образец идемпотентного `create()` — `tasks.service.ts:73-101`, `createDb`/`Database` (`packages/db/src/index.ts:11-16`), `tashkentInstant` (`packages/shared/src/tashkent-time.ts:26`), образец разового скрипта — `packages/db/src/import-stock-history.ts` (докблок `:1-51`, донор `:471`, точка входа `:658-696`).

**Interfaces (produces):**
```ts
/** packages/shared/src/tashkent-time.ts */
/**
 * Смещение Ташкента в миллисекундах: постоянное, перехода на летнее время нет.
 *
 * ЭКСПОРТИРУЕТСЯ, чтобы разовая правка времени (`fix-collection-time.ts`) брала
 * «пять часов» ОТСЮДА. Написать в скрипте `5 * 3_600_000` или в SQL
 * `interval '5 hours'` — значит завести вторую константу зоны; ровно на этой
 * развилке донор VendCash уехал на пять часов (см. шапку файла).
 */
export const TASHKENT_OFFSET_MS = 5 * 3_600_000;

/**
 * Момент → ташкентская МИНУТА `YYYY-MM-DDTHH:mm`.
 *
 * Единица, в которой повтор нажатия совпадает: клиент Core рвёт запрос по
 * таймауту 10 с, человек видит ошибку и жмёт кнопку снова. Двух РАЗНЫХ сборов
 * одного автомата одним человеком внутри одной минуты не бывает.
 */
export function tashkentMinute(at: Date): string;

/** packages/db/src/schema.ts */
// в collection, рядом с denominations
/**
 * Ключ идемпотентности — идентичность строки В ИСТОЧНИКЕ, а не подпись каждой
 * строки (R-I-2). Заполнен там, где источник существует вне MYDON:
 * `vendcash:collection:<uuid донора>` у 386 перенесённых,
 * `bot:collect:<personId>:<machineId>:<минута>` у нажатий кнопки в боте.
 * NULL — законное состояние: у строки, рождённой внутри MYDON без ключа от
 * клиента, источника вне системы нет. Синтетический серверный ключ здесь
 * запрещён: он уникален по построению и не защищает НИ ОТ ЧЕГО.
 */
clientKey: text("client_key"),
// в списке индексов
uniqueIndex("collection_client_key").on(t.clientKey),

/** packages/db/src/script-flags.ts */
export type РазборФлагов =
  | { ok: true; dryRun: boolean; режим: string; числа: Record<string, number> }
  | { ok: false; error: string };
export function разобратьФлаги(
  argv: readonly string[],
  opts: { безФлагов: "запись" | "отказ"; числа?: Readonly<Record<string, number>> },
): РазборФлагов;

/** packages/db/src/backfill-collection-keys.ts */
export const ПРЕФИКС_КЛЮЧА = "vendcash:collection:";
export interface DonorCollectionRow { id: string; machineCode: string | null; collectedAt: string; amount: string | null; status: string }
export interface DonorReader { collections(): Promise<DonorCollectionRow[]> }
export function нормализоватьКод(code: string | null): string | null;
export function ключСопоставления(code: string | null, at: Date, amount: string | null): string | null;
export interface BackfillKeysReport {
  уДонора: number; уНас: number; сопоставлено: number; кЗаписи: number; записано: number;
  безПарыДонор: { id: string; code: string | null; at: string }[];
  безПарыНаши: { id: string; code: string | null; at: string }[];
  неоднозначно: { ключ: string; донор: string[]; наши: string[] }[];
  расхождениеСтатуса: { ourId: string; donorId: string; уНас: string; уДонора: string }[];
}
export async function backfillCollectionKeys(db: Database, donor: DonorReader, opts: { apply: boolean }): Promise<BackfillKeysReport>;
export function sqlDonor(url: string, schema?: string): { reader: DonorReader; close(): Promise<void> };
export function formatReport(r: BackfillKeysReport): string;

/** apps/core/src/collections/collections.service.ts */
export interface CreateCollectionInput {
  machineId: string;
  operatorId?: string;
  collectedAt?: string;
  source?: "realtime" | "manual_history" | "import";
  notes?: string;
  /** Ключ идемпотентности ОТ КЛИЕНТА. Нет ключа — нет дедупа, и это законно (R-I-2). */
  clientKey?: string;
}

/** apps/bot/src/staff.ts */
export function collectionClientKey(personId: string, machineId: string, now: Date): string;
```

Что обязана делать реализация:
- **Миграция — следующий свободный номер.** Оба оператора защитные (`IF NOT EXISTS`): автодеплой применяет миграции без отката, и упавший оператор вешает выкатку молча и навсегда. Частичного предиката (`WHERE client_key IS NOT NULL`) НЕ нужно: NULL в уникальном индексе Postgres различны — ровно так живут `task_client_key`, `stock_movement_client_key`, `maintenance_log_client_key`.
- **`create()`**: `clientKey: input.clientKey ?? null` в `values`, `.onConflictDoNothing({ target: collection.clientKey })`, при пустом `returning()` — возврат уже существующей строки (образец `tasks.service.ts:86-97`). `audit_log` в ветке повтора **не пишется**: второй записи о том же событии в журнале быть не должно. Возврат первой строки — правильный ответ боту: он покажет момент ПЕРВОГО сбора, а не времени повторного нажатия.
- **Бэкфилл**: сопоставление по `<нормализованный код>|<момент, мс>|<сумма в копейках или "null">`; момент донора = `tashkentInstant(строка донора)` (эта формула §3.2 описи работает на всех 386 строках, потому что прошлый импорт применил её единообразно), момент MYDON — сам `collectedAt`. Статус в ключ не входит, но сравнивается. Любая неоднозначность — печатается, не пишется. `3be8c71f0000` / `3be8c71e0000` не сшиваются: после нормализации обе строки по 12 символов и различаются символом — пара не соберётся сама, и хардкода нет.
- **Без флагов — отказ.** В отличие от `backfill-product-ids.ts`, который CI зовёт без аргументов: этот скрипт запускают только руками по живой базе.
- **Донор — `VENDCASH_DATABASE_URL`** (нет → код возврата 2: «донор не подключён» и «скрипт сломался» — разные разговоры), `max: 1`, только SELECT; схема — `VENDCASH_SCHEMA` (нужна ровно дымовому прогону). Переменная **в `.env` прода не кладётся**: передаётся окружением ровно на время команды.
- **Отметки в `event` бэкфилл не ставит**: следом бэкфилла является сам ключ в данных, а второе событие про то же самое заставило бы читателя гадать, какое полное.
- **Повторный `--apply` — «записано 0»**: счёт по длине `returning()`, а не по длине входа; предикат `client_key IS NULL` в `where`.

- [ ] **Step 1: Тесты RED — общий слой и схема.**
```ts
// packages/shared/src/tashkent-time.test.ts — дописать в существующий файл
// `tashkentDay` в файле уже импортирован (стр. 3) — дописать в тот же импорт:
import { TASHKENT_OFFSET_MS, tashkentMinute } from "./tashkent-time";

describe("Ташкентская минута и смещение (срез «правда о пробеле»)", () => {
  it("минута режется по Ташкенту, а не по часам процесса", () => {
    assert.equal(tashkentMinute(new Date("2026-01-30T06:40:42.626Z")), "2026-01-30T11:40");
    assert.equal(tashkentMinute(new Date("2026-01-30T18:59:59.999Z")), "2026-01-30T23:59");
    assert.equal(tashkentMinute(new Date("2026-01-30T19:00:00.000Z")), "2026-01-31T00:00");
  });

  it("секунды в минуту не входят — повтор нажатия внутри минуты даёт ТУ ЖЕ строку", () => {
    const a = tashkentMinute(new Date("2026-01-30T06:40:00.000Z"));
    const b = tashkentMinute(new Date("2026-01-30T06:40:59.999Z"));
    assert.equal(a, b);
  });

  it("смещение экспортировано и равно ровно пяти часам — второй копии в репозитории быть не должно", () => {
    assert.equal(TASHKENT_OFFSET_MS, 5 * 3_600_000);
    // Тот же сдвиг, что применяет `tashkentDay`: если однажды разойдутся,
    // разовая правка времени уедет не туда, а тест это скажет.
    const at = new Date("2026-06-08T20:30:00.000Z");
    assert.equal(new Date(at.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10), tashkentDay(at));
  });
});
```
```ts
// packages/db/src/schema.test.ts — новый набор
import { getTableConfig } from "drizzle-orm/pg-core";
import { collection } from "./schema";

describe("Инкассация: ключ идемпотентности (R-I-2)", () => {
  it("у `collection` есть `clientKey` — без него повторный перенос удвоил бы 386 строк", () => {
    const cfg = getTableConfig(collection);
    const колонка = cfg.columns.find((c) => c.name === "client_key");
    assert.ok(колонка, "колонки client_key нет");
    assert.equal(колонка!.notNull, false, "ключ обязан быть nullable: у своих строк источника вне MYDON нет");
  });

  it("индекс по ключу УНИКАЛЬНЫЙ — иначе колонка была бы украшением", () => {
    const cfg = getTableConfig(collection);
    const индекс = cfg.indexes.find((i) => i.config.name === "collection_client_key");
    assert.ok(индекс, "индекса collection_client_key нет");
    assert.equal(индекс!.config.unique, true);
  });
});
```
```ts
// packages/db/src/migrations-chain.test.ts — новый файл
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Сторож цепочки миграций.
 *
 * ЗАЧЕМ. Номер миграции занимает тот, кто первым сгенерировал файл. Два среза,
 * идущие параллельно, легко берут один и тот же `0072` — и второй файл на
 * проде применится МИМО журнала либо не применится вовсе, молча. Автодеплой
 * ошибку не покажет: он гонит мигратор, а мигратор читает журнал.
 *
 * Папка резолвится относительно `dist` — тем же способом, что у
 * `migration-0062.integration.ts:45`: тесты пакета исполняются из `dist`.
 */
const ПАПКА = path.resolve(__dirname, "..", "drizzle");

type Запись = { idx: number; tag: string };

const журнал = JSON.parse(readFileSync(path.join(ПАПКА, "meta", "_journal.json"), "utf8")) as {
  entries: Запись[];
};
const файлы = readdirSync(ПАПКА).filter((f) => f.endsWith(".sql")).sort();

describe("Цепочка миграций (срез «правда о пробеле»)", () => {
  it("каждому файлу миграции соответствует запись журнала и наоборот", () => {
    assert.deepEqual(
      файлы.map((f) => f.replace(/\.sql$/, "")).sort(),
      журнал.entries.map((e) => e.tag).sort(),
    );
  });

  it("номера миграций уникальны — два среза не могут занять один номер", () => {
    const номера = файлы.map((f) => f.slice(0, 4));
    assert.equal(new Set(номера).size, номера.length, `дублирующийся номер: ${номера.join(" ")}`);
  });

  it("`idx` идут подряд от нуля и совпадают с номером в имени файла", () => {
    журнал.entries.forEach((e, i) => {
      assert.equal(e.idx, i, `запись ${e.tag}: idx ${e.idx}, ожидался ${i}`);
      assert.equal(e.tag.slice(0, 4), String(i).padStart(4, "0"), `tag ${e.tag} не совпал со своим idx`);
    });
  });

  it("имя файла — это tag журнала, а не соседнее написание", () => {
    for (const f of файлы) {
      assert.ok(
        журнал.entries.some((e) => e.tag === f.replace(/\.sql$/, "")),
        `файл ${f} журналу неизвестен`,
      );
    }
  });
});
```
- [ ] **Step 2: Тесты RED — разбор флагов.**
```ts
// packages/db/src/script-flags.test.ts — новый файл
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { разобратьФлаги } from "./script-flags";

describe("Белый список аргументов разовых скриптов (R-FW-S1 + R-I-4)", () => {
  it("умолчание «запись» и умолчание «отказ» — два разных режима одного разбора", () => {
    // `backfill-product-ids` без флагов ПИШЕТ: его зовёт ci.yml без аргументов.
    // Скрипты этого среза без флагов ОТКАЗЫВАЮТ: их запускают руками по живой
    // базе, и «умолчание = запись» там читалось бы как ловушка.
    const запись = разобратьФлаги([], { безФлагов: "запись" });
    assert.deepEqual(запись, { ok: true, dryRun: false, режим: "Режим: ЗАПИСЬ (без флагов — умолчание).", числа: {} });
    const отказ = разобратьФлаги([], { безФлагов: "отказ" });
    assert.equal(отказ.ok, false);
    if (!отказ.ok) assert.match(отказ.error, /--dry-run/);
  });

  it("`--apply` и `--dry-run` вместе — отказ при любом умолчании", () => {
    for (const безФлагов of ["запись", "отказ"] as const) {
      const о = разобратьФлаги(["--apply", "--dry-run"], { безФлагов });
      assert.equal(о.ok, false);
    }
  });

  it("опечатка отбивается, а `--dry-run=1` не считается числовым флагом", () => {
    for (const мимо of ["--dryrun", "--dry_run", "-n", "--dry-run=1", "—dry-run"]) {
      assert.equal(разобратьФлаги([мимо], { безФлагов: "запись" }).ok, false, `${мимо} обязан быть отвергнут`);
    }
  });

  it("объявленный числовой флаг разбирается, необъявленный — нет", () => {
    const о = разобратьФлаги(["--dry-run", "--expect=2"], { безФлагов: "отказ", числа: { "--expect": 247 } });
    assert.equal(о.ok, true);
    if (о.ok) assert.deepEqual(о.числа, { "--expect": 2 });
    const умолчание = разобратьФлаги(["--apply"], { безФлагов: "отказ", числа: { "--expect": 247 } });
    if (умолчание.ok) assert.deepEqual(умолчание.числа, { "--expect": 247 });
    assert.equal(разобратьФлаги(["--expect=2"], { безФлагов: "запись" }).ok, false, "необъявленный числовой флаг — чужой аргумент");
  });

  it("нечисловое и отрицательное значение числового флага — отказ ДО первого запроса", () => {
    for (const плохо of ["--expect=", "--expect=два", "--expect=-1", "--expect=2.5"]) {
      const о = разобратьФлаги([плохо, "--dry-run"], { безФлагов: "отказ", числа: { "--expect": 247 } });
      assert.equal(о.ok, false, `${плохо} обязан быть отвергнут`);
    }
  });
});
```
- [ ] **Step 3: Тесты RED — бэкфилл ключей.**
```ts
// packages/db/src/backfill-collection-keys.test.ts — новый файл
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ПРЕФИКС_КЛЮЧА,
  backfillCollectionKeys,
  formatReport,
  ключСопоставления,
  нормализоватьКод,
  type DonorCollectionRow,
} from "./backfill-collection-keys";

type НашаСтрока = {
  id: string;
  machineCode: string | null;
  collectedAt: Date;
  amount: string | null;
  status: string;
  clientKey: string | null;
};

/** Донор — массивы, а не Postgres: правило сопоставления к базе отношения не имеет. */
const донор = (rows: DonorCollectionRow[]) => ({ collections: async () => rows });

/**
 * Стенд MYDON: `select` отдаёт строки, `update` уважает предикат
 * `client_key is null` — именно он делает повторный `--apply` нулевым.
 * Заглушка SQL не исполняет, поэтому предикат моделируется явно: иначе тест
 * «повторный apply даёт 0» зеленел бы на сломанном запросе.
 */
function стендDb(наши: НашаСтрока[]) {
  return {
    select: () => ({ from: () => ({ leftJoin: () => ({ orderBy: async () => наши.map((r) => ({ ...r })) }) }) }),
    update: () => ({
      set: (patch: { clientKey: string }) => ({
        where: (пред: { id: string }) => ({
          returning: async () => {
            const цель = наши.find((r) => r.id === пред.id && r.clientKey === null);
            if (!цель) return [];
            цель.clientKey = patch.clientKey;
            return [{ id: цель.id }];
          },
        }),
      }),
    }),
  } as never;
}

const D = (over: Partial<DonorCollectionRow> = {}): DonorCollectionRow => ({
  id: "d1",
  machineCode: "5b7b181f0000",
  collectedAt: "2026-01-30 06:40:42.626",
  amount: "1250000.00",
  status: "received",
  ...over,
});

const M = (over: Partial<НашаСтрока> = {}): НашаСтрока => ({
  id: "m1",
  machineCode: "5b7b181f0000",
  collectedAt: new Date("2026-01-30T01:40:42.626Z"), // = 06:40 Ташкента: как прочитал прошлый импорт
  amount: "1250000.00",
  status: "received",
  clientKey: null,
  ...over,
});

describe("Бэкфилл ключей: правило сопоставления (R-I-3)", () => {
  it("момент донора читается как ташкентские настенные часы — пара находится", () => {
    assert.equal(
      ключСопоставления("5b7b181f0000", new Date("2026-01-30T01:40:42.626Z"), "1250000.00"),
      "5b7b181f0000|" + new Date("2026-01-30T01:40:42.626Z").getTime() + "|125000000",
    );
  });

  it("код в верхнем регистре и код, короткий на символ, нормализуются", () => {
    assert.equal(нормализоватьКод("7D9D181F0000"), "7d9d181f0000");
    assert.equal(нормализоватьКод("039ec91c000"), "039ec91c0000");
    assert.equal(нормализоватьКод("  "), null, "автомата без кода в ключе быть не может");
  });

  it("коды, различающиеся символом (…71f / …71e), НЕ сшиваются", () => {
    // Совпадение по количеству инкассаций доказывает, что автомат один, но
    // КАКОЙ из кодов настоящий, из данных не видно (R-I-8). Захардкодить
    // соответствие — значит запечь угадывание в ключ навсегда.
    assert.notEqual(нормализоватьКод("3be8c71f0000"), нормализоватьКод("3be8c71e0000"));
  });

  it("`amount IS NULL` совпадает с `amount IS NULL`, а не с нулём", () => {
    const at = new Date("2026-06-30T04:22:03.548Z");
    assert.equal(ключСопоставления("8da1181f0000", at, null), "8da1181f0000|" + at.getTime() + "|null");
    assert.notEqual(ключСопоставления("8da1181f0000", at, null), ключСопоставления("8da1181f0000", at, "0.00"));
  });
});

describe("Бэкфилл ключей: примерка и запись", () => {
  it("примерка не пишет ничего и печатает то же число «к записи», что запишет `--apply`", async () => {
    const наши = [M()];
    const примерка = await backfillCollectionKeys(стендDb(наши), донор([D()]), { apply: false });
    assert.equal(примерка.сопоставлено, 1);
    assert.equal(примерка.кЗаписи, 1);
    assert.equal(примерка.записано, 0);
    assert.equal(наши[0].clientKey, null, "примерка не трогает ни одной строки");

    const запись = await backfillCollectionKeys(стендDb(наши), донор([D()]), { apply: true });
    assert.equal(запись.кЗаписи, 1);
    assert.equal(запись.записано, 1);
    assert.equal(наши[0].clientKey, ПРЕФИКС_КЛЮЧА + "d1");
  });

  it("повторный `--apply` даёт «записано 0» — счёт по возвращённым строкам, а не по длине входа", async () => {
    const наши = [M({ clientKey: ПРЕФИКС_КЛЮЧА + "d1" })];
    const повтор = await backfillCollectionKeys(стендDb(наши), донор([D()]), { apply: true });
    assert.equal(повтор.сопоставлено, 1, "пара по-прежнему находится");
    assert.equal(повтор.кЗаписи, 0, "писать нечего: ключ уже стоит");
    assert.equal(повтор.записано, 0);
  });

  it("расхождение статуса паре не мешает, но печатается", async () => {
    // Строка 30.06.2026: `collected` у донора, `cancelled` у нас. Включи статус
    // в ключ — и получили бы ложное «нет пары» на строке, которая очевидно та же.
    const наши = [M({ status: "cancelled", amount: null })];
    const о = await backfillCollectionKeys(стендDb(наши), донор([D({ status: "collected", amount: null })]), { apply: false });
    assert.equal(о.сопоставлено, 1);
    assert.deepEqual(о.расхождениеСтатуса, [{ ourId: "m1", donorId: "d1", уНас: "cancelled", уДонора: "collected" }]);
  });

  it("две донорские строки с одним ключом — неоднозначность: не пишем ни одной, печатаем обе", async () => {
    // Тройной дубль на `fa86d006…` 30.01.2026 12:46 внесён владельцем НАМЕРЕННО
    // (Р-4 описи): схлопнуть его значит стереть след тройной ошибки ввода.
    const наши = [M({ id: "m1" }), M({ id: "m2" })];
    const о = await backfillCollectionKeys(
      стендDb(наши),
      донор([D({ id: "d1" }), D({ id: "d2" })]),
      { apply: true },
    );
    assert.equal(о.сопоставлено, 0);
    assert.equal(о.записано, 0);
    assert.equal(о.неоднозначно.length, 1);
    assert.deepEqual(о.неоднозначно[0].донор.sort(), ["d1", "d2"]);
    assert.deepEqual(о.неоднозначно[0].наши.sort(), ["m1", "m2"]);
    assert.deepEqual(наши.map((r) => r.clientKey), [null, null]);
  });

  it("строки без пары уезжают в отчёт обеими сторонами, с кодом и моментом", async () => {
    const наши = [M({ id: "m7", machineCode: "3be8c71e0000" })];
    const о = await backfillCollectionKeys(
      стендDb(наши),
      донор([D({ id: "d7", machineCode: "3be8c71f0000" })]),
      { apply: true },
    );
    assert.equal(о.сопоставлено, 0);
    assert.deepEqual(о.безПарыДонор.map((r) => [r.id, r.code]), [["d7", "3be8c71f0000"]]);
    assert.deepEqual(о.безПарыНаши.map((r) => [r.id, r.code]), [["m7", "3be8c71e0000"]]);
  });

  it("пустая примерка говорит словами, а не молчит", async () => {
    const о = await backfillCollectionKeys(стендDb([]), донор([]), { apply: false });
    assert.equal(о.уДонора, 0);
    assert.equal(о.уНас, 0);
    assert.equal(о.кЗаписи, 0);
    assert.match(formatReport(о), /нечего писать/i);
  });
});
```
> Стенд получает `where` уже РАЗОБРАННЫМ объектом `{ id }` — реализация обязана звать `.where(...)` так, чтобы стенд мог его прочитать. Практически: `backfillCollectionKeys` вызывает приватный помощник `обновить(db, id, key)`, который в боевом коде строит `and(eq(collection.id, id), isNull(collection.clientKey))`, а стенд подменяет весь `update`. Если стенд оказывается слишком хрупким, допустимо заменить его на счётчик вызовов + отдельную проверку предиката по исходнику (образец — `бэкфиллWhere` в `backfill-product-ids.test.ts:126-136`): утверждение «UPDATE несёт `client_key IS NULL`» обязано быть проверено ЧЕМ-ТО, иначе повторный `--apply` на проде перезапишет ключи.

- [ ] **Step 4: Тесты RED — писатель Core и бот.**
```ts
// apps/core/src/collections/collections.test.ts — правка заглушки
function stub(opts: { machine?: Row | null; existing?: Row | null; конфликт?: Row }) {
  const audit: Row[] = [];
  let выборок = 0;
  const базовые = () =>
    opts.machine !== undefined ? (opts.machine ? [opts.machine] : []) : opts.existing ? [opts.existing] : [];
  const withFor = (r: Row[]) =>
    Object.assign(Promise.resolve(r), { limit: async () => r, for: async () => r });
  const tx = {
    select: () => {
      выборок += 1;
      // В create() ПЕРВЫЙ select ищет автомат, ВТОРОЙ (только в ветке повтора)
      // — уже лежащую инкассацию по ключу. Разводим счётчиком: заглушка таблиц
      // не различает.
      const строки = opts.конфликт && выборок > 1 ? [opts.конфликт] : базовые();
      return { from: () => ({ where: () => withFor(строки) }) };
    },
    insert: () => ({
      values: (v: Row) => {
        if (typeof v.action === "string") audit.push(v);
        const конфликт = opts.конфликт != null && v.clientKey === opts.конфликт.clientKey;
        const хвост = { returning: async () => (конфликт ? [] : [{ id: "c1", ...v }]) };
        return Object.assign(Promise.resolve(undefined), хвост, {
          onConflictDoNothing: () => Object.assign(Promise.resolve(undefined), хвост),
        });
      },
    }),
    update: () => ({
      set: (v: Row) => ({ where: () => ({ returning: async () => [{ ...(opts.existing ?? {}), ...v }] }) }),
    }),
  };
  const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
  return { db, audit };
}

// новый набор рядом с существующим describe («Инкассация»)
describe("Инкассация: ключ идемпотентности (R-I-2)", () => {
  it("`create` без ключа пишет строку и `NULL` в `client_key` — ключ обязателен только там, где его дал клиент", async () => {
    const { db } = stub({ machine: { id: "m1", type: "machine" } });
    const c = await new CollectionsService(db).create({ machineId: "m1", operatorId: "p1" });
    assert.equal((c as unknown as Row).clientKey, null);
  });

  it("`create` кладёт переданный ключ полем, а не выдумывает свой", async () => {
    // Синтетический `mydon:collection:<uuid>` уникален по построению и не
    // защищает НИ ОТ ЧЕГО: повтор нажатия получил бы новый uuid и лёг бы
    // второй строкой — ровно то, против чего ключ заводят.
    const { db } = stub({ machine: { id: "m1", type: "machine" } });
    const c = await new CollectionsService(db).create({ machineId: "m1", operatorId: "p1", clientKey: "bot:collect:p1:m1:2026-08-26T14:07" });
    assert.equal((c as unknown as Row).clientKey, "bot:collect:p1:m1:2026-08-26T14:07");
  });

  it("повтор с тем же `clientKey` возвращает ПЕРВУЮ строку, второй строки нет", async () => {
    const первая = { id: "c1", clientKey: "bot:collect:p1:m1:2026-08-26T14:07", collectedAt: new Date("2026-08-26T09:07:00Z") };
    const { db } = stub({ machine: { id: "m1", type: "machine" }, конфликт: первая });
    const c = await new CollectionsService(db).create({ machineId: "m1", operatorId: "p1", clientKey: первая.clientKey });
    assert.equal(c.id, "c1");
    // Момент ПЕРВОГО сбора, а не времени повторного нажатия: человек увидит,
    // что уже записано, и не станет писать второй раз.
    assert.equal(String(c.collectedAt), String(первая.collectedAt));
  });

  it("повтор с тем же `clientKey` не пишет вторую запись в `audit_log`", async () => {
    const первая = { id: "c1", clientKey: "bot:collect:p1:m1:2026-08-26T14:07" };
    const { db, audit } = stub({ machine: { id: "m1", type: "machine" }, конфликт: первая });
    await new CollectionsService(db).create({ machineId: "m1", operatorId: "p1", clientKey: первая.clientKey });
    assert.equal(audit.filter((a) => a.action === "collection.collected").length, 0, "о том же событии журнал пишут один раз");
  });

  it("разные нажатия (разные ключи) дают две инкассации — за сутки бывает два сбора", async () => {
    const s = new CollectionsService(stub({ machine: { id: "m1", type: "machine" } }).db);
    const a = await s.create({ machineId: "m1", operatorId: "p1", clientKey: "bot:collect:p1:m1:2026-08-26T09:07" });
    const b = await s.create({ machineId: "m1", operatorId: "p1", clientKey: "bot:collect:p1:m1:2026-08-26T17:31" });
    assert.notEqual((a as unknown as Row).clientKey, (b as unknown as Row).clientKey);
  });
});
```
```ts
// apps/bot/src/staff.test.ts — новый набор
import { collectionClientKey, handleStaffCallback } from "./staff";

describe("Инкассация из бота: ключ идемпотентности (R-I-2)", () => {
  const MACHINE = "33333333-3333-4333-8333-333333333333";

  it("кнопка инкассации шлёт ключ `bot:collect:<человек>:<автомат>:<минута>`", async () => {
    const ключи: (string | undefined)[] = [];
    const { core } = stubCore({
      createCollection: async (_m: string, _p: string, clientKey?: string) => {
        ключи.push(clientKey);
        return { id: "c1", collectedAt: "2026-08-26T09:07:11.000Z" };
      },
    });
    const deps = { core, conversations: new Conversations() } as never;
    await handleStaffCallback(555, `c:${MACHINE}`, ME, deps, new Date("2026-08-26T09:07:11.000Z"));
    assert.deepEqual(ключи, [`bot:collect:${ME.id}:${MACHINE}:2026-08-26T14:07`]);
  });

  it("повторное нажатие внутри той же минуты несёт ТОТ ЖЕ ключ", () => {
    // Клиент Core рвёт запрос по таймауту 10 с (`core-client.ts:322/329`),
    // человек видит ошибку и жмёт снова — сегодня это вторая инкассация.
    const a = collectionClientKey(ME.id, MACHINE, new Date("2026-08-26T09:07:00.000Z"));
    const b = collectionClientKey(ME.id, MACHINE, new Date("2026-08-26T09:07:59.999Z"));
    assert.equal(a, b);
  });

  it("часы — параметр, а не стенные: два вызова с одним `now` дают один ключ", () => {
    const now = new Date("2026-08-26T09:07:30.000Z");
    assert.equal(collectionClientKey(ME.id, MACHINE, now), collectionClientKey(ME.id, MACHINE, now));
    assert.notEqual(
      collectionClientKey(ME.id, MACHINE, now),
      collectionClientKey(ME.id, MACHINE, new Date("2026-08-26T09:08:30.000Z")),
    );
  });
});
```
- [ ] **Step 5:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build && pnpm --filter core build && pnpm --filter bot build && pnpm --filter @mydon/shared test && pnpm --filter @mydon/db test && pnpm --filter core test && pnpm --filter bot test` → RED (`tashkentMinute` не экспортируется, `client_key` в схеме нет, `script-flags`/`backfill-collection-keys` не существуют, `handleStaffCallback` принимает четыре аргумента).
- [ ] **Step 6: Общий слой.** `packages/shared/src/tashkent-time.ts`: `const СМЕЩЕНИЕ_МС` (`:50`) заменяется на экспортируемую `TASHKENT_OFFSET_MS` с докблоком из «Interfaces (produces)», все её внутренние использования (`tashkentDay`) переводятся на новое имя; в конец файла — `tashkentMinute`:
```ts
export function tashkentMinute(at: Date): string {
  // `toLocaleString` здесь не годится по той же причине, что у `tashkentDay`:
  // он зависит от набора ICU в рантайме, а строка нужна сортируемая и
  // байт-в-байт одинаковая на всех машинах.
  return new Date(at.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 16);
}
```
- [ ] **Step 7: Схема и миграция.** В `packages/db/src/schema.ts` — поле `clientKey` (после `denominations`, `:289`) и `uniqueIndex("collection_client_key").on(t.clientKey)` в списке индексов (`:293-296`), оба с докблоками из «Interfaces (produces)». Затем:
```bash
ls packages/db/drizzle/*.sql | tail -3           # какой номер занят последним
node -e "console.log(require('./packages/db/drizzle/meta/_journal.json').entries.at(-1))"
pnpm --filter @mydon/db db:generate --name=collection_client_key
```
Сгенерированный `.sql` **переписать** защитным паттерном (образец 0067/0069/0071), сохранив `--> statement-breakpoint`:
```sql
-- collection.client_key (срез «правда о пробеле», R-I-2): ключ идемпотентности
-- у журнала инкассаций. Сегодня его нет вовсе — повторный перенос из VendCash
-- молча удвоил бы все 386 строк, а ретрай кнопки в боте после таймаута 10 с
-- уже сейчас даёт вторую инкассацию.
--
-- Индекс НЕ частичный: NULL в уникальном индексе Postgres различны, поэтому
-- строки без ключа (законное состояние — источника вне MYDON у них нет) друг
-- другу не мешают. Ровно так живут task_client_key, stock_movement_client_key,
-- maintenance_log_client_key.
--
-- IF NOT EXISTS — защитный паттерн 0067/0069/0071: автодеплой применяет
-- миграции без отката, и упавший оператор вешает выкатку молча и навсегда.

ALTER TABLE "collection" ADD COLUMN IF NOT EXISTS "client_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_client_key" ON "collection" USING btree ("client_key");
```
Снапшот `drizzle/meta/00NN_snapshot.json` и запись в `_journal.json` — из генератора, коммитятся вместе с файлом. Проверить сторожем: `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` — набор «Цепочка миграций» зелёный.
- [ ] **Step 8: Общий разбор флагов.** Создать `packages/db/src/script-flags.ts` с докблоком («две причины существования: одна реализация правила и два разных умолчания») и `разобратьФлаги` по «Interfaces (produces)». Регулярка числового флага — `^(--[a-z-]+)=(.*)$`, и объявленным считается только тот, чьё имя есть в `opts.числа`: `--dry-run=1` обязан остаться ОТВЕРГНУТЫМ (он в списке опечаток `backfill-product-ids.test.ts:113`). В `backfill-product-ids.ts` удалить `ЗНАЕМ_ФЛАГИ` (`:346`) и заменить тело `разобратьАргументы` (`:365-384`) обёрткой, СОХРАНИВ прежнюю сигнатуру и прежние строки режима:
```ts
export function разобратьАргументы(
  argv: string[],
): { ok: true; dryRun: boolean; режим: string } | { ok: false; error: string } {
  const r = разобратьФлаги(argv, { безФлагов: "запись" });
  // `числа` наружу НЕ проливается: числовых флагов у этого скрипта нет, а его
  // тесты сверяют объект целиком (`assert.deepEqual`) — лишний ключ покрасил бы
  // их без единой смысловой правки.
  return r.ok ? { ok: true, dryRun: r.dryRun, режим: r.режим } : r;
}
```
Докблок `:350-364` («Раньше распознавались ровно две строки…») остаётся на месте: он объясняет ПОЧЕМУ, и правда не изменилась.
- [ ] **Step 9: Бэкфилл ключей.** Создать `packages/db/src/backfill-collection-keys.ts` по образцу `import-stock-history.ts`. Докблок обязан назвать: зачем ключ (повторный перенос удвоил бы 386 строк), почему сопоставление именно по (код, момент, сумма) и почему статус в ключ не входит, почему неоднозначность печатается, а не пишется, почему донор — только SELECT и почему без флагов скрипт отказывает. Тело:
```ts
export const ПРЕФИКС_КЛЮЧА = "vendcash:collection:";

export function нормализоватьКод(code: string | null): string | null {
  const s = (code ?? "").trim().toLowerCase();
  if (s === "") return null;
  // Донор пишет один код короче на символ (`039ec91c000` против
  // `039ec91c0000`) и один — в верхнем регистре. Обе нормализации взяты из
  // описи §3.1 и НЕ придуманы: сшивать что-то сверх этого — угадывание.
  return s.length >= 12 ? s : s.padEnd(12, "0");
}

export function ключСопоставления(code: string | null, at: Date, amount: string | null): string | null {
  const код = нормализоватьКод(code);
  if (код === null) return null;
  // Копейки, а не строка: `"1250000.00"` и `"1250000.000"` — одна сумма, а
  // побайтовое сравнение развело бы их по разным ключам.
  const сумма = amount == null ? "null" : String(Math.round(Number(amount) * 100));
  return `${код}|${at.getTime()}|${сумма}`;
}
```
Чтение MYDON — `select` с `leftJoin(entity, eq(entity.id, collection.machineId))`, поля `collection.id`, `entity.externalRef as machineCode`, `collection.collectedAt`, `collection.amount`, `collection.status`, `collection.clientKey`, `orderBy(collection.id)` (детерминированность между примеркой и записью — та же причина, что записана в `backfill-product-ids.ts:294-300`). Момент донора — `tashkentInstant(row.collectedAt)`; `null` → строка уезжает в `безПарыДонор`. Запись — по одной строке: `update(collection).set({ clientKey }).where(and(eq(collection.id, id), isNull(collection.clientKey))).returning()`, `записано` считается длиной `returning()`. `formatReport` печатает колонки «у донора / у нас / сопоставлено / к записи / записано / без пары (донор) / без пары (MYDON) / неоднозначно / расхождение статуса», при `кЗаписи === 0` — строку «нечего писать: у всех сопоставленных строк ключ уже стоит» (или «донор пуст»), и последней строкой — `ИТОГИ(json): {…}` для дымового прогона.
Точка входа: `loadEnv` из корня, `разобратьФлаги(process.argv.slice(2), { безФлагов: "отказ" })` ДО первого запроса, `DATABASE_URL` (нет → код 1), `VENDCASH_DATABASE_URL` (нет → код **2**), `sqlDonor(url, process.env.VENDCASH_SCHEMA || "public")` c `postgres(url, { prepare: false, max: 1, connect_timeout: 10 })` и единственным запросом:
```ts
    collections: async () =>
      (await client`
        select c.id::text as id, m.code as machine_code, c.collected_at::text as collected_at,
               c.amount::text as amount, c.status::text as status
          from ${client(schema)}.collections c
          left join ${client(schema)}.machines m on m.id = c.machine_id
         order by c.id`) as unknown as DonorCollectionRow[],
```
В `packages/db/package.json` — `"db:backfill:collection-keys": "node dist/backfill-collection-keys.js"` рядом с `db:backfill:product-ids`.
- [ ] **Step 10: Писатель Core.** `collections.service.ts`: поле `clientKey?: string` в `CreateCollectionInput` (`:101-107`) с докблоком; в `create()` — `clientKey: input.clientKey ?? null` в `values`, `.onConflictDoNothing({ target: collection.clientKey })` после `.values(...)`, и ветка повтора ПЕРЕД записью в `audit_log`:
```ts
      // Повтор по clientKey: сбор уже записан первой попыткой — возвращаем ту
      // же строку и НЕ пишем второй `audit_log`. Бот покажет момент ПЕРВОГО
      // сбора: человеку важно увидеть, что записано, а не когда он нажал ещё раз.
      if (!created) {
        const [existing] = await tx
          .select()
          .from(collection)
          .where(eq(collection.clientKey, input.clientKey!))
          .limit(1);
        if (!existing) throw new BadRequestException("Повтор инкассации ещё сохраняется — нажми ещё раз");
        return existing;
      }
```
`collections.controller.ts`: в `CreateCollectionDto` (после `notes`) — `@IsOptional() @IsString() @MaxLength(200) clientKey?: string;`. Роут `POST /collections` уже под `ServiceTokenGuard`, троттлы не трогаем.
- [ ] **Step 11: Бот.** `core-client.ts:758-767` — третий необязательный аргумент:
```ts
  /**
   * Оператор зафиксировал сбор денег с автомата.
   *
   * `clientKey` генерируется КЛИЕНТОМ — как у заливки (`createRefill` ниже):
   * сгенерируй его сервер, и повтор того же нажатия стал бы новой инкассацией.
   */
  createCollection(
    machineId: string,
    operatorId: string,
    clientKey?: string,
  ): Promise<{ id: string; collectedAt: string }> {
    return this.request<{ id: string; collectedAt: string }>("/collections", {
      method: "POST",
      body: JSON.stringify({ machineId, operatorId, ...(clientKey ? { clientKey } : {}) }),
    });
  }
```
`staff.ts`: импорт `tashkentMinute` из `@mydon/shared` (рядом с `TZ`), экспортируемая `collectionClientKey` (докблок из спеки: минута — единица, в которой повтор совпадает) рядом с `parseCollectCallback` (`:236-240`), пятый параметр `now: Date = new Date()` у `handleStaffCallback` (`:626-630`) и правка ветки инкассации (`:904`):
```ts
    const created = await deps.core.createCollection(
      collect.machineId,
      person.id,
      collectionClientKey(person.id, collect.machineId, now),
    );
```
Вызывающие не правятся: `apps/bot/src/index.ts:945` передаёт четыре аргумента, пятый берёт умолчание — «сейчас» и есть значение по умолчанию, ровно как у `stockCounts` в Core.
- [ ] **Step 12: `.env.example`.** Под блоком «Синк снабжения (mydon-stock)» (`:22-24`) — новый блок:
```
# ── Донор инкассаций VendCash (Railway) — ТОЛЬКО для разового скрипта ──
# Задаётся ОКРУЖЕНИЕМ на время одной команды (см. docs/DEPLOY.md, раздел
# «Разовые шаги среза «правда о пробеле»»). В боевом .env остаётся ПУСТО:
# донор — чужая база со своим владельцем и своим ботом, и постоянное
# подключение к ней Core не нужно ни для чего.
VENDCASH_DATABASE_URL=
```
- [ ] **Step 13:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build && pnpm --filter core build && pnpm --filter bot build && pnpm --filter @mydon/shared test && pnpm --filter @mydon/db test && pnpm --filter core test && pnpm --filter bot test` → GREEN, включая прежние наборы `backfill-product-ids` (белый список) и «Инкассация». `pnpm -s typecheck`, `pnpm -s lint`. Отдельно: `pnpm --filter @mydon/db db:generate` → «No schema changes» (снапшот обязан быть уже в коммите).
- [ ] **Step 14:** `git commit -m "feat(db,core,bot,shared): client_key у инкассаций — колонка, идемпотентный писатель и бэкфилл от донора (инкассации, R-I-2, R-I-3)" -- packages/shared/src/tashkent-time.ts packages/shared/src/tashkent-time.test.ts packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/src/migrations-chain.test.ts packages/db/src/script-flags.ts packages/db/src/script-flags.test.ts packages/db/src/backfill-product-ids.ts packages/db/src/backfill-collection-keys.ts packages/db/src/backfill-collection-keys.test.ts packages/db/drizzle packages/db/package.json apps/core/src/collections/collections.service.ts apps/core/src/collections/collections.controller.ts apps/core/src/collections/collections.test.ts apps/bot/src/core-client.ts apps/bot/src/staff.ts apps/bot/src/staff.test.ts .env.example`

---

### Task 3: Сдвиг пяти часов — 247 строк переезжают на своё место одной транзакцией (**после T2**)

**Files:** Modify `packages/db/package.json` (`scripts`, рядом с `db:backfill:collection-keys` из T2), `apps/cc/src/app/audit/page.tsx` (словарь `describe` стр. 21–54). Create `packages/db/src/fix-collection-time.ts`, `packages/db/src/fix-collection-time.test.ts`, `apps/cc/src/app/audit/page.test.tsx`.

**Interfaces (consumes):** `TASHKENT_OFFSET_MS`, `tashkentDay`, `tashkentMinute` (`@mydon/shared`, T2), `ПРЕФИКС_КЛЮЧА` (`./backfill-collection-keys`, T2), `разобратьФлаги` (`./script-flags`, T2), `collection` / `auditLog` / `event` (`./schema`), `createDb` / `Database` (`./index`).

**Interfaces (produces):**
```ts
/** packages/db/src/fix-collection-time.ts */
export const EVENT_TYPE = "cash.collection_time_corrected";
export const AUDIT_ACTION = "collection.time_corrected";
/** Ожидание прода. Меняется флагом `--expect=<N>` — им пользуется только дымовой прогон. */
export const ОЖИДАНИЕ_ПРОДА = 247;

export class FixTimeRefusal extends Error {}

export interface ЧасыНабора { мин: number; макс: number; сред: number }
export interface FixTimeReport {
  найдено: number;
  кПравке: number;
  правлено: number;
  часыДо: ЧасыНабора;
  часыПосле: ЧасыНабора;
  суткиДо: { from: string; to: string };
  суткиПосле: { from: string; to: string };
  суммыДо: Record<string, number>;
  суммыПосле: Record<string, number>;
  сдвигЧасов: number;
}

export function ташкентскийЧас(at: Date): number;
export function часыНабора(rows: readonly { collectedAt: Date }[]): ЧасыНабора;
export function суммыПоСтатусам(rows: readonly { status: string; amount: string | null }[]): Record<string, number>;
export async function fixCollectionTime(
  db: Database,
  opts: { apply: boolean; expect?: number; now?: Date },
): Promise<FixTimeReport>;
export function formatReport(r: FixTimeReport): string;

/** apps/cc/src/app/audit/page.tsx */
export const ACTION_LABELS: Record<string, string>;
```

Что обязана делать реализация:
- **Множество** — `and(eq(collection.source, "import"), like(collection.clientKey, `${ПРЕФИКС_КЛЮЧА}%`))`, читается целыми строками (`db.select().from(collection).where(...)`): `before`/`after` в аудите обязаны быть строкой целиком.
- **Четыре заставы, любая — `FixTimeRefusal` и код возврата 3.** Порядок фиксирован: (1) есть строки `source='import' AND client_key IS NULL` — происхождение не доказано (обычно это T2, упершийся в R-I-8); (2) в `event` уже есть `cash.collection_time_corrected`; (3) в `audit_log` уже есть `action='collection.time_corrected'`; (4) максимум ташкентского часа по множеству больше 19 — данные выглядят уже сдвинутыми. Застава (1) стоит ПЕРВОЙ: пока не доказано происхождение, все остальные вопросы преждевременны.
- **Застава 4 — третий ремень, а не первый.** После верной правки максимум часа равен ровно 19, то есть повтор она НЕ поймает; повтор ловят заставы 2 и 3. Застава 4 существует для данных, сдвинутых ЧУЖОЙ рукой — когда в наших таблицах следа нет.
- **Число найденных сверяется с `expect` (умолчание `ОЖИДАНИЕ_ПРОДА`)** и расхождение — тоже `FixTimeRefusal`: «найдено N, ожидалось M — остановка».
- **Сдвиг** — `TASHKENT_OFFSET_MS`, новые значения вычисляются в TS и пишутся явными моментами: `before`/`after` в аудите честны построчно, а второй копии «пяти часов» в SQL не появляется. `receivedAt` сдвигается вместе с `collectedAt`; `NULL` остаётся `NULL`.
- **Одна транзакция**: `UPDATE` + записи `audit_log` + одно событие. 247 строк — доли секунды, а половинчатый сдвиг не должен существовать в принципе.
- **Событие**: `source: "vendcash"`, `type: EVENT_TYPE`, `payload: { rows, from, to, hours }`, `occurredAt: now`. `hours` берётся как `TASHKENT_OFFSET_MS / 3_600_000`, а не пишется числом: скрипт разовый и однажды будет удалён — отметка обязана рассказывать, НА СКОЛЬКО сдвинули, без чтения кода.
- **`from`/`to` — крайние ташкентские сутки затронутого диапазона ПОСЛЕ правки.** До и после они обязаны совпадать (максимум часа до правки 14, плюс пять даёт 19:xx — полночь не пересекается ни одной строкой), и отчёт печатает обе пары: их равенство и есть доказательство, что дата сбора не поехала ни у одной строки.
- **Суммы не меняются нигде.** `суммыПоСтатусам` считается до и после; расхождение — ошибка реализации, а не предупреждение. `amount IS NULL` остаётся `NULL` — «ждёт приёма», а не ноль.
- **`--dry-run` не открывает транзакцию вовсе** и печатает те же числа, что запишет `--apply`.

- [ ] **Step 1: Тесты RED — скрипт.**
```ts
// packages/db/src/fix-collection-time.test.ts — новый файл
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TASHKENT_OFFSET_MS, tashkentDay } from "@mydon/shared";
import { ПРЕФИКС_КЛЮЧА } from "./backfill-collection-keys";
import { AUDIT_ACTION, EVENT_TYPE, FixTimeRefusal, fixCollectionTime, ташкентскийЧас } from "./fix-collection-time";

type Строка = {
  id: string;
  source: string;
  clientKey: string | null;
  collectedAt: Date;
  receivedAt: Date | null;
  amount: string | null;
  status: string;
};

const S = (over: Partial<Строка> = {}): Строка => ({
  id: "c1",
  source: "import",
  clientKey: ПРЕФИКС_КЛЮЧА + "d1",
  // 06:40 Ташкента — «оператор выехал в 06:40», хотя на самом деле 11:40.
  collectedAt: new Date("2026-01-30T01:40:42.626Z"),
  receivedAt: new Date("2026-01-30T05:00:00.000Z"),
  amount: "1250000.00",
  status: "received",
  ...over,
});

/**
 * Стенд: одна таблица `collection`, журнал аудита и лента событий — массивами.
 * Транзакция настоящая по смыслу: `сорвать` роняет её посередине, и тест
 * проверяет, что снаружи не осталось ни одной сдвинутой строки.
 */
function стенд(строки: Строка[], опции: { события?: number; аудит?: number; сорватьНа?: number } = {}) {
  const аудит: Record<string, unknown>[] = [];
  const события: Record<string, unknown>[] = [];
  let обновлений = 0;
  const снимок = строки.map((r) => ({ ...r }));
  const состояние = строки.map((r) => ({ ...r }));
  const счётчики = { события: опции.события ?? 0, аудит: опции.аудит ?? 0 };
  const tx = {
    select: (поля?: Record<string, unknown>) => ({
      from: (t: unknown) => ({
        where: async () => {
          if (поля && "n" in поля) return [{ n: счётчики.события }];
          return состояние;
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<Строка>) => ({
        where: (пред: { id: string }) => ({
          returning: async () => {
            обновлений += 1;
            if (опции.сорватьНа === обновлений) throw new Error("падение посреди правки");
            const цель = состояние.find((r) => r.id === пред.id)!;
            Object.assign(цель, patch);
            return [{ ...цель }];
          },
        }),
      }),
    }),
    insert: (t: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        (typeof v.action === "string" ? аудит : события).push(v);
      },
    }),
  };
  const db = {
    ...tx,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => {
      try {
        return await cb(tx);
      } catch (e) {
        // Откат: состояние возвращается к снимку — ровно то, что делает Postgres.
        состояние.splice(0, состояние.length, ...снимок.map((r) => ({ ...r })));
        аудит.length = 0;
        события.length = 0;
        throw e;
      }
    },
  } as never;
  return { db, аудит, события, состояние, счётчики };
}

describe("Правка времени: множество доказано ключом, а не полем source (R-I-4)", () => {
  it("правятся только строки с `source='import'` И ключом донора", async () => {
    const { db, состояние } = стенд([S({ id: "c1" }), S({ id: "c2", source: "manual_history", clientKey: null })]);
    const о = await fixCollectionTime(db, { apply: true, expect: 1 });
    assert.equal(о.найдено, 1);
    assert.equal(о.правлено, 1);
    assert.equal(состояние[1].collectedAt.toISOString(), "2026-01-30T01:40:42.626Z", "manual_history не трогаем");
  });

  it("строка `source='import'` без ключа — отказ: происхождение не доказано", async () => {
    // `source` пускает клиент (`collections.controller.ts`), а ключ доказывает
    // происхождение. Обычно эта застава срабатывает там, где T2 упёрся в R-I-8.
    const { db } = стенд([S({ id: "c1" }), S({ id: "c9", clientKey: null })]);
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 1 }), FixTimeRefusal);
  });

  it("сдвиг берёт смещение из `tashkent-time`, а не из числа в скрипте", async () => {
    const было = new Date("2026-01-30T01:40:42.626Z");
    const { db, состояние } = стенд([S({ collectedAt: было })]);
    await fixCollectionTime(db, { apply: true, expect: 1 });
    assert.equal(состояние[0].collectedAt.getTime() - было.getTime(), TASHKENT_OFFSET_MS);
  });

  it("`received_at` сдвигается вместе с `collected_at`, `NULL` остаётся `NULL`", async () => {
    const { db, состояние } = стенд([
      S({ id: "c1", receivedAt: new Date("2026-01-30T05:00:00.000Z") }),
      S({ id: "c2", receivedAt: null, amount: null, status: "collected" }),
    ]);
    await fixCollectionTime(db, { apply: true, expect: 2 });
    assert.equal(состояние[0].receivedAt!.toISOString(), "2026-01-30T10:00:00.000Z");
    assert.equal(состояние[1].receivedAt, null);
    assert.equal(состояние[1].amount, null, "`amount IS NULL` — «ждёт приёма», а не ноль");
  });

  it("суммы и статусы до и после совпадают — правится время, не деньги", async () => {
    const { db } = стенд([S({ id: "c1" }), S({ id: "c2", status: "cancelled", amount: "3931000.00" })]);
    const о = await fixCollectionTime(db, { apply: true, expect: 2 });
    assert.deepEqual(о.суммыДо, о.суммыПосле);
  });

  it("ташкентские сутки не меняются ни у одной строки: часы 4–14 становятся 9–19", async () => {
    const { db, состояние } = стенд([
      S({ id: "c1", collectedAt: new Date("2026-01-29T23:00:00.000Z") }), // 04:00 Ташкента
      S({ id: "c2", collectedAt: new Date("2026-01-30T09:00:00.000Z") }), // 14:00 Ташкента
    ]);
    const о = await fixCollectionTime(db, { apply: true, expect: 2 });
    assert.deepEqual(о.часыДо, { мин: 4, макс: 14, сред: 9 });
    assert.deepEqual(о.часыПосле, { мин: 9, макс: 19, сред: 14 });
    assert.deepEqual(о.суткиДо, о.суткиПосле, "полночь не пересекает ни одна строка");
    assert.equal(tashkentDay(состояние[0].collectedAt), "2026-01-30");
  });

  it("`--dry-run` печатает те же числа и не пишет ни строки, ни отметки", async () => {
    const { db, состояние, аудит, события } = стенд([S()]);
    const о = await fixCollectionTime(db, { apply: false, expect: 1 });
    assert.equal(о.кПравке, 1);
    assert.equal(о.правлено, 0);
    assert.equal(состояние[0].collectedAt.toISOString(), "2026-01-30T01:40:42.626Z");
    assert.deepEqual([аудит.length, события.length], [0, 0]);
  });

  it("найдено не столько, сколько ожидалось, — остановка, а не флаг", async () => {
    const { db } = стенд([S()]);
    await assert.rejects(() => fixCollectionTime(db, { apply: true }), /найдено 1.*247/s);
  });
});

describe("Правка времени: заставы повторного прогона (R-I-4)", () => {
  it("отметка события в журнале останавливает повторный прогон", async () => {
    const { db } = стенд([S()], { события: 1 });
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 1 }), /cash\.collection_time_corrected/);
  });

  it("записи `collection.time_corrected` в аудите останавливают повторный прогон", async () => {
    const { db } = стенд([S()], { аудит: 1 });
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 1 }), /collection\.time_corrected/);
  });

  it("час больше 19 в множестве — отказ: данные выглядят уже сдвинутыми", async () => {
    // Ремень для правки ЧУЖОЙ рукой: после нашей отметки в наших таблицах есть
    // след, а после чужой — нет, и распределение часов остаётся единственным
    // свидетелем.
    const { db } = стенд([S({ collectedAt: new Date("2026-01-30T15:30:00.000Z") })]); // 20:30 Ташкента
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 1 }), /уже сдвинут/i);
  });
});

describe("Правка времени: след и транзакция (R-I-5)", () => {
  it("на каждую правленую строку — запись аудита с полными `before` и `after`", async () => {
    const { db, аудит } = стенд([S({ id: "c1" }), S({ id: "c2" })]);
    await fixCollectionTime(db, { apply: true, expect: 2 });
    assert.equal(аудит.length, 2);
    for (const a of аудит) {
      assert.equal(a.action, AUDIT_ACTION);
      assert.equal(a.actorKind, "system");
      assert.equal(a.actorRef, "script:fix-collection-time");
      // Полная строка, а не пара полей: `before` — единственный настоящий путь
      // отката 247 отметок времени (полный дамп откатывает 70 таблиц).
      assert.ok((a.before as Record<string, unknown>).amount !== undefined);
      assert.ok((a.after as Record<string, unknown>).status !== undefined);
    }
  });

  it("событие несёт число строк, границы и сам сдвиг в часах", async () => {
    const { db, события } = стенд([S()]);
    await fixCollectionTime(db, { apply: true, expect: 1, now: new Date("2026-08-27T05:00:00.000Z") });
    assert.equal(события.length, 1);
    assert.equal(события[0].source, "vendcash");
    assert.equal(события[0].type, EVENT_TYPE);
    // `hours` в отметке нужен потому, что скрипт разовый и однажды будет
    // удалён — отметка обязана рассказывать, НА СКОЛЬКО сдвинули.
    assert.deepEqual(события[0].payload, { rows: 1, from: "2026-01-30", to: "2026-01-30", hours: 5 });
    assert.equal(String(события[0].occurredAt), String(new Date("2026-08-27T05:00:00.000Z")));
  });

  it("правка и отметка едут одной транзакцией: падение на середине не оставляет половину строк сдвинутыми", async () => {
    const { db, состояние, аудит, события } = стенд([S({ id: "c1" }), S({ id: "c2" })], { сорватьНа: 2 });
    await assert.rejects(() => fixCollectionTime(db, { apply: true, expect: 2 }), /падение посреди правки/);
    assert.deepEqual(
      состояние.map((r) => r.collectedAt.toISOString()),
      ["2026-01-30T01:40:42.626Z", "2026-01-30T01:40:42.626Z"],
    );
    assert.deepEqual([аудит.length, события.length], [0, 0]);
  });
});

describe("Ташкентский час", () => {
  it("час считается по Ташкенту, а не по часам процесса", () => {
    assert.equal(ташкентскийЧас(new Date("2026-01-30T01:40:42.626Z")), 6);
    assert.equal(ташкентскийЧас(new Date("2026-01-29T19:00:00.000Z")), 0);
  });
});
```
- [ ] **Step 2: Тест RED — подпись на витрине.**
```tsx
// apps/cc/src/app/audit/page.test.tsx — новый файл
import { describe, expect, it, vi } from "vitest";

// `page.tsx` тянет клиент Core, а тот первой строкой импортирует пакет
// `server-only`, которого вне RSC не существует.
vi.mock("../../lib/core", () => ({
  core: { audit: vi.fn(), people: vi.fn() },
  CoreUnavailable: class CoreUnavailable extends Error {},
}));

import { ACTION_LABELS } from "./page";

describe("Журнал аудита: подписи действий (R-I-5)", () => {
  it("действие `collection.time_corrected` подписано по-русски, а не кодом", () => {
    // Без подписи владелец увидит в журнале голый код — 247 раз подряд.
    expect(ACTION_LABELS["collection.time_corrected"]).toBe("поправил время инкассации (перенос VendCash, +5 часов)");
  });

  it("подпись называет и причину, и величину: через год «+5 часов» объяснит запись само", () => {
    expect(ACTION_LABELS["collection.time_corrected"]).toMatch(/VendCash/);
    expect(ACTION_LABELS["collection.time_corrected"]).toMatch(/\+5 часов/);
  });

  it("прежние подписи инкассации на месте — словарь дополняется, а не переписывается", () => {
    expect(ACTION_LABELS["collection.collected"]).toBe("снял выручку");
    expect(ACTION_LABELS["collection.received"]).toBe("принял инкассацию");
    expect(ACTION_LABELS["collection.cancelled"]).toBe("отменил инкассацию");
  });
});
```
- [ ] **Step 3:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → RED («Cannot find module ./fix-collection-time»); `pnpm --filter cc test` → RED («ACTION_LABELS is not exported»).
- [ ] **Step 4: Скрипт.** Создать `packages/db/src/fix-collection-time.ts`. Докблок обязан назвать: что правится (247 строк `source='import'` с ключом донора — у донора это записи бота, их `collected_at` настоящий UTC, о чём написано в шапке донорской миграции `FixOrderDateTimezone`; прошлый импорт прочитал их как ташкентские настенные часы и увёл на пять часов НАЗАД), что `manual_history` прошлый импорт прочитал ПРАВИЛЬНО и она не трогается, почему операция не идемпотентна по природе и почему заставы стоят в трёх независимых местах, и почему донор здесь не нужен вовсе (множество доказано ключом в MYDON, лишнее подключение к чужой базе не открывается). Ключевые куски:
```ts
export function ташкентскийЧас(at: Date): number {
  // Через ту же минуту, что режет ключ бота: вторая формула зоны в
  // репозитории запрещена, и «час» — это её же префикс.
  return Number(tashkentMinute(at).slice(11, 13));
}

export async function fixCollectionTime(
  db: Database,
  opts: { apply: boolean; expect?: number; now?: Date },
): Promise<FixTimeReport> {
  const now = opts.now ?? new Date();
  const ожидание = opts.expect ?? ОЖИДАНИЕ_ПРОДА;

  // ЗАСТАВА 1 — происхождение. Пока хоть одна строка `import` без ключа,
  // остальные вопросы преждевременны: чинить время у строк, происхождение
  // которых не доказано, нельзя (обычно это T2, упершийся в R-I-8).
  const [{ n: безКлюча }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(collection)
    .where(and(eq(collection.source, "import"), isNull(collection.clientKey)));
  if (Number(безКлюча) > 0) {
    throw new FixTimeRefusal(
      `строк source='import' без client_key: ${безКлюча}. Происхождение не доказано — сначала ` +
        `backfill-collection-keys, и, если они остались без пары, решение владельца по коду автомата (R-I-8).`,
    );
  }
  // ЗАСТАВЫ 2 и 3 — отметка события и записи аудита. Повторный прогон дал бы
  // +10 часов; один механизм зелёного ответа на сломанных данных мы уже проходили.
  // ЗАСТАВА 4 — распределение часов: третий ремень, для правки ЧУЖОЙ рукой.
  // После верной правки максимум равен ровно 19, и повтор она не поймает —
  // повтор ловят 2 и 3.
  ...
}
```
Запись:
```ts
  await db.transaction(async (tx) => {
    for (const r of строки) {
      const collectedAt = new Date(r.collectedAt.getTime() + TASHKENT_OFFSET_MS);
      const receivedAt = r.receivedAt ? new Date(r.receivedAt.getTime() + TASHKENT_OFFSET_MS) : null;
      // Новые значения считаются в TS и пишутся ЯВНЫМИ моментами: так
      // `before`/`after` в аудите честны построчно, а второй копии «пяти часов»
      // в SQL не появляется.
      const [updated] = await tx
        .update(collection)
        .set({ collectedAt, receivedAt })
        .where(eq(collection.id, r.id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "system",
        actorRef: "script:fix-collection-time",
        action: AUDIT_ACTION,
        target: r.id,
        before: r,
        after: updated,
      });
      правлено += 1;
    }
    await tx.insert(event).values({
      source: "vendcash",
      type: EVENT_TYPE,
      payload: { rows: правлено, from: суткиПосле.from, to: суткиПосле.to, hours: TASHKENT_OFFSET_MS / 3_600_000 },
      occurredAt: now,
    });
  });
```
`formatReport` печатает: найдено / к правке / правлено, крайние моменты до и после, распределение часов до и после, сутки до и после, суммы по статусам до и после (обязаны совпасть), и последней строкой `ИТОГИ(json): {…}`. Точка входа: `разобратьФлаги(process.argv.slice(2), { безФлагов: "отказ", числа: { "--expect": ОЖИДАНИЕ_ПРОДА } })`, `DATABASE_URL` (нет → 1), `FixTimeRefusal` → печать причины и `process.exit(3)`, успех → `process.exit(0)`. В `packages/db/package.json` — `"db:fix:collection-time": "node dist/fix-collection-time.js"`.
- [ ] **Step 5: Подпись на витрине.** `apps/cc/src/app/audit/page.tsx`: словарь из тела `describe` (`:22-54`) выносится в экспортируемую константу, функция остаётся приватной обёрткой, и добавляется одна строка:
```ts
/** Понятное имя действия: в журнале коды, а читать его будет не программист. */
export const ACTION_LABELS: Record<string, string> = {
  ...
  "collection.cancelled": "отменил инкассацию",
  /**
   * Разовая правка среза «правда о пробеле»: 247 перенесённых строк стояли на
   * пять часов раньше реальности. Записей за один момент много — первый экран
   * `/audit` они займут целиком, и это объявлено в чек-листе выкатки (R-I-5);
   * отбор по действию у эндпоинта есть (`?action=`).
   */
  "collection.time_corrected": "поправил время инкассации (перенос VendCash, +5 часов)",
  ...
};

function describe(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
```
- [ ] **Step 6:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build && pnpm --filter @mydon/db test && pnpm --filter cc test` → GREEN. `pnpm -s typecheck`, `pnpm -s lint`.
- [ ] **Step 7:** `git commit -m "feat(db,cc): разовый сдвиг времени 247 перенесённых инкассаций — заставы, транзакция, построчный аудит (инкассации, R-I-4, R-I-5)" -- packages/db/src/fix-collection-time.ts packages/db/src/fix-collection-time.test.ts packages/db/package.json apps/cc/src/app/audit/page.tsx apps/cc/src/app/audit/page.test.tsx`

---

### Task 4: Рунбук — архив донора VendCash и оба разовых шага (**после T1**, кода нет)

**Files:** Modify `docs/DEPLOY.md` (новые разделы рядом с «Разовый перенос истории склада (П8a)» стр. 97–151 и «Разовый бэкфилл `product_id`» стр. 153), `docs/DATA_SOURCES.md` (раздел про инкассации, заведённый T1).

**Interfaces (consumes):** `deploy/guards/db_access.sh` (`dump` / `query`, клиент `postgres:17-alpine` `:18`), конвенция разового шага (`docs/DEPLOY.md:97-124`: `--dry-run` → `--apply`, `</dev/null`, проверка `ls -lh`).

**Interfaces (produces):** кода нет. Производится ЗНАНИЕ: как снять архив донора так, чтобы он не оказался пустым, и как прогнать оба скрипта так, чтобы `VENDCASH_DATABASE_URL` не осел в `.env` прода.

Что обязана делать реализация:
- **Три раздела, а не один.** Спека называет для T4 только архив; рунбуки обоих скриптов тоже пишутся здесь (см. «Отклонения» №3) — иначе один файл правят три задачи, две из которых идут одной параллельной волной.
- **Архив стоит ПЕРВЫМ** и в тексте, и в чек-листе: пока архива нет, гасить донора нельзя и трогать данные незачем.
- Текст фиксирует: донор читается **только на чтение**; строка подключения донора на хост прода **не попадает вовсе** — туда едет готовый архив; архив лежит на ФС хоста, а не в БД MYDON; именно архив — единственный носитель GPS 246 сборов, `distance_from_machine`, `collection_history` (502 строки) и приёмщиков (385).

- [ ] **Step 1: Архив донора.** В `docs/DEPLOY.md`, новый раздел `### Архив донора VendCash (срез «правда о пробеле»)` сразу после раздела П8a (`:151`):
````markdown
Донор жив, продолжает копить (последняя строка 30.06.2026) и в любой момент
может быть погашен владельцем. Всё, чего в MYDON нет вовсе — GPS 246 сборов,
`distance_from_machine`, `collection_history` (502 строки), приёмщики (385
строк `manager_id`), `machine_locations` (31) — живёт только там. Архив
снимается ПЕРВЫМ, до любой правки данных.

```bash
# 1. Строка подключения донора читается ЛОКАЛЬНО (railway CLI уже авторизован
#    под владельцем) и никуда не печатается.
railway link -p "VendHub Cash bot"
export VENDCASH_URL=$(railway variables -s Postgres --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p')

# 2. Дамп снимает клиент 17-й версии — тот же образ, которым ходит db_access.sh:
#    локальный pg_dump 15 сервер 17 не возьмёт, а `| gzip` спрячет отказ пустым
#    файлом (урок П8a). Строка подключения уходит ОКРУЖЕНИЕМ, а не аргументом:
#    в argv её видит любой `ps`.
docker run --rm -e VENDCASH_URL --entrypoint sh postgres:17-alpine \
  -c 'pg_dump --no-owner --no-privileges "$VENDCASH_URL"' \
  | gzip > ./vendcash-archive-$(date +%F).sql.gz

# 3. Проверка РАЗМЕРОМ, а не кодом возврата. Ожидание — единицы мегабайт (база 35 МБ).
ls -lh ./vendcash-archive-*.sql.gz

# 4. Архив переезжает на хост прода; строка подключения донора туда НЕ едет.
scp ./vendcash-archive-$(date +%F).sql.gz mydon:/opt/backups/
ssh mydon 'ls -lh /opt/backups/vendcash-archive-*.sql.gz'
```

Автоматизировать разовое снятие дампа чужой базы не будем: это код, который
запустят один раз. После архива Railway-проект можно гасить — решение владельца
становится обратимым.
````
- [ ] **Step 2: Рунбук разовых шагов.** Ниже — раздел `### Разовые шаги среза «правда о пробеле»`:
````markdown
Миграция `00NN_collection_client_key` заводит колонку и уникальный индекс, но
ключи в неё не приносит — их пишет отдельный **идемпотентный** скрипт, и
автодеплой его НЕ запускает. Порядок обязателен и не переставляется: сначала
ключи (доказательство происхождения), потом время.

```bash
# 0. Бэкап базы перед ПЕРВОЙ записью (R-I-6). У helper'а нет ключа -t: dump
#    берёт схемы public и drizzle целиком, и это правильный бэкап — а откат
#    247 отметок времени идёт не из него, а из audit_log.before.
/opt/backups/db_access.sh dump | gzip > /opt/backups/pre-inkass-timefix-$(date +%F).sql.gz
ls -lh /opt/backups/pre-inkass-timefix-*.sql.gz

# 1. Ключи. VENDCASH_URL получен на шаге архива и передаётся РОВНО на эти две
#    команды: в боевом .env его нет и быть не должно.
docker exec -i -e VENDCASH_DATABASE_URL="$VENDCASH_URL" mydon-core \
  node packages/db/dist/backfill-collection-keys.js --dry-run </dev/null
docker exec -i -e VENDCASH_DATABASE_URL="$VENDCASH_URL" mydon-core \
  node packages/db/dist/backfill-collection-keys.js --apply   </dev/null

# 2. Время. Донор здесь не нужен вовсе: множество доказано ключом в MYDON.
docker exec -i mydon-core node packages/db/dist/fix-collection-time.js --dry-run </dev/null
docker exec -i mydon-core node packages/db/dist/fix-collection-time.js --apply   </dev/null
```

`</dev/null` в конце каждой команды обязателен: без него остаток скрипта уходит
в контейнер и шаги после молча не выполняются.

**Ожидание примерки ключей:** сопоставлено **374**, к записи **374**, без пары
**12 + 12** (автомат с расходящимся кодом `3be8c71f0000` / `3be8c71e0000`,
решение владельца), неоднозначно **0 либо 2** (тройной дубль на `fa86d006…`
30.01.2026 12:46 — единственный кандидат; различаются ли у двух его строк
секунды, скажет примерка), расхождение статуса — **1 строка** (30.06.2026).
Любое другое число — **остановка выкатки**, а не флаг. Повторный `--apply`
обязан дать «записано 0».

**Ожидание правки времени:** найдено **247**, к правке **247**; ташкентские часы
до 4–14, после 9–19; суммы по статусам до и после совпадают до копейки; сутки
до и после совпадают (полночь не пересекает ни одна строка). Третий прогон
обязан ОТКАЗАТЬ кодом 3 по отметке события — это и есть проверка защиты от
двойного сдвига. Скрипт откажется работать и в том случае, если хоть одна
строка `source='import'` осталась без ключа: чинить время у строк, происхождение
которых не доказано, нельзя.

Проверочный запрос распределения часов (до и после):

```bash
/opt/backups/db_access.sh query "
select source,
       min(extract(hour from collected_at at time zone 'Asia/Tashkent'))::int  as ч_мин,
       max(extract(hour from collected_at at time zone 'Asia/Tashkent'))::int  as ч_макс,
       round(avg(extract(hour from collected_at at time zone 'Asia/Tashkent'))::numeric, 1) as ч_сред,
       count(*)                                                                as строк,
       coalesce(sum(amount) filter (where status = 'received'), 0)             as принято
  from collection group by source order by source"
```

**Откат правки времени** — из `audit_log`, а не восстановлением дампа:
в `before` лежит полная строка каждой из 247 записей
(`action = 'collection.time_corrected'`). Восстанавливать 70 таблиц ради отката
247 отметок времени — это откат всей базы, а не откат правки.
````
- [ ] **Step 3: Происхождение архива в справочнике данных.** `docs/DATA_SOURCES.md`, в раздел про инкассации (заведён T1) — абзац: где лежит архив (`/opt/backups/vendcash-archive-<дата>.sql.gz` на хосте прода), какой датой снят, чем снят (клиент `postgres:17-alpine`), и что в нём есть такого, чего нет в MYDON — GPS сборов (246 строк), `distance_from_machine`, `collection_history` (502), приёмщики (385), `machine_locations` (31). Отдельной строкой: перенос этого — **вне охвата среза** (новые колонки и новая витрина, R-I-9), архив существует ровно затем, чтобы решение «гасить донора» стало обратимым.
- [ ] **Step 4:** проверка глазами — в обоих файлах нет ни одной строки подключения, ни одного пароля и ни одного боевого IP; команды скопированы из этого плана дословно; `pnpm -s lint` (markdown в lint не входит, шаг — на случай, если правило появится).
- [ ] **Step 5:** `git commit -m "docs(deploy,data-sources): архив донора VendCash и рунбук разовых шагов среза (инкассации, R-I-7)" -- docs/DEPLOY.md docs/DATA_SOURCES.md`

---

### Task 5: Сторожа скриптов — дым против живого Postgres и сторож писателя (**после T2 и T3**)

**Files:** Modify `apps/core/src/collections/collections.test.ts` (набор «Инкассация: ключ идемпотентности», заведён T2), `.github/workflows/ci.yml` (шаг «Smoke (Core против настоящего postgres)», строка `SMOKE_SCRATCH=1 node tools/smoke-import.mjs` стр. 94). Create `tools/smoke-collections.mjs`.

**Interfaces (consumes):** `tools/smoke-import.mjs` — образец целиком: заставы `SMOKE_SCRATCH` / локальный хост / пустая база (`:308-322`), `безопасныйХост` (`:104`), `scratchПоИмени` (`:120`), `хост` (`:129`), `безСекретов` (`:139`), `прогон` (`:145`), `сверить` (`:164`), `убратьЗаСобой` (`:296`); разборная строка `ИТОГИ(json): ` из отчётов обоих скриптов среза.

**Interfaces (produces):** новых экспортов нет. Производятся две ГАРАНТИИ: (а) писатель `collection` в репозитории ровно один и он несёт ключ; (б) уникальный индекс по nullable-колонке, `on conflict do nothing` по нему, транзакционность правки и обе заставы повтора проверены НА СЕРВЕРЕ, а не на заглушке.

Что обязана делать реализация:
- **Сторож писателя — по исходнику, а не по поведению.** Четыре поведенческих теста `create()` уже написаны в T2 (§8 спеки относит их туда). Здесь добавляется единственное, чего они не видят: что второй писатель `collection` не появился незаметно. Сегодня писатель ровно один (`collections.service.ts:136`).
- **Зачем дым, если есть юнит-тесты:** заглушка drizzle не исполняет ни уникальный индекс по nullable-колонке, ни `on conflict do nothing` по нему, ни транзакционность правки — это проверяет только сервер (та же причина записана в `ci.yml:82-95`).
- **Дым убирает за собой только СВОИ строки** — по точным ключам фикстуры и по id события, которое своими глазами увидел появившимся.
- **Ни одно сообщение не печатает строку подключения** (в ней пароль): наружу идёт только `host`, вывод дочернего процесса чистится `безСекретов`.

- [ ] **Step 1: Тест RED — сторож писателя.**
```ts
// apps/core/src/collections/collections.test.ts — дописать в набор «Инкассация: ключ идемпотентности»
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

  it("писатель `collection` в Core ровно один — второй не имеет права появиться без ключа незаметно", () => {
    // Поведенческие тесты выше проверяют ЭТОТ путь. Они ничего не скажут про
    // новый сервис, который начнёт писать инкассации своим insert'ом мимо
    // clientKey — а именно так ключ идемпотентности и перестаёт работать.
    // Исходники читаются относительно dist: тесты пакета исполняются оттуда.
    const корень = path.resolve(__dirname, "..", "..", "src");
    const файлы: string[] = [];
    const обойти = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) обойти(p);
        else if (d.name.endsWith(".ts") && !d.name.endsWith(".test.ts")) файлы.push(p);
      }
    };
    обойти(корень);
    const писатели = файлы.filter((f) => /\binsert\(\s*collection\s*\)/.test(readFileSync(f, "utf8")));
    assert.deepEqual(
      писатели.map((f) => path.relative(корень, f)),
      ["collections/collections.service.ts"],
      "появился второй писатель collection — он обязан принимать clientKey и звать onConflictDoNothing",
    );
  });
```
> Если `apps/core` собирается так, что `src` рядом с `dist` недоступен (проверить `ls apps/core/dist`), сторож переезжает в `packages/db` тем же приёмом, что `migrations-chain.test.ts` (`path.resolve(__dirname, "..", "..", "..", "apps/core/src")`), а тело остаётся прежним. Утверждение обязано быть проверено ЧЕМ-ТО: без него ключ теряет силу молча.

- [ ] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED (сторож не существует). Проверить также, что список писателей действительно из одного файла: `grep -rn "insert(collection)" apps/core/src` → одна строка (`collections.service.ts:136`).
- [ ] **Step 3: Дымовой прогон — заставы и фикстура.** Создать `tools/smoke-collections.mjs` по образцу `smoke-import.mjs`. Докблок объясняет, что именно заглушка не исполняет и почему прогон отказывается работать не на scratch. Шапка:
```js
const СХЕМА = "vendcash_donor";
const КЛЮЧИ = path.join(КОРЕНЬ, "packages/db/dist/backfill-collection-keys.js");
const ВРЕМЯ = path.join(КОРЕНЬ, "packages/db/dist/fix-collection-time.js");

/** Ровно те ключи, которые может создать ЭТА фикстура, — по ним и убираем. */
const СВОИ_КЛЮЧИ = ["vendcash:collection:d1", "vendcash:collection:d2", "vendcash:collection:d3"];
/** Коды автоматов фикстуры: в разном регистре и один короткий на символ. */
const КОДЫ = { верхний: "AB01181F0000", короткий: "039ec91c000", обычный: "fa86d0060000" };
```
Заставы ДО первой записи — три, как у соседа:
```js
  if (process.env.SMOKE_SCRATCH !== "1" && !scratchПоИмени(DATABASE_URL)) throw new Error(...);
  if (!безопасныйХост(DATABASE_URL)) throw new Error(...);
  // Инкассации — денежный журнал владельца. Не «мало строк», а НИ ОДНОЙ:
  // прогон пишет и удаляет, и чужую инкассацию он трогать не имеет права.
  сверить("инкассаций в базе нет ни одной", await число(sql`select count(*) n from collection`), 0);
  сверить("отметок правки времени нет", await число(sql`select count(*) n from event where type = 'cash.collection_time_corrected'`), 0);
  сверить("записей аудита о правке нет", await число(sql`select count(*) n from audit_log where action = 'collection.time_corrected'`), 0);
```
- [ ] **Step 4: Дымовой прогон — сценарий.** Пять донорских строк и пять зеркальных, заведённых по правилу прошлого импорта (ВСЕ моменты прочитаны как ташкентские):

| Строка | Донор `source` | Код автомата | Что доказывает |
|---|---|---|---|
| `d1` / `m1` | `realtime` | `AB01181F0000` | нормализация регистра; строка ОБЯЗАНА сдвинуться |
| `d2` / `m2` | `realtime` | `039ec91c000` (11 симв.) | добивка нулём; строка ОБЯЗАНА сдвинуться |
| `d3` / `m3` | `manual_history`, статус `collected` | `fa86d0060000` | расхождение статуса (у нас `cancelled`) печатается, паре не мешает; строка НЕ трогается правкой времени |
| `d4`,`d5` / `m4`,`m5` | `manual_history`, одинаковый момент и сумма | `fa86d0060000` | неоднозначность: не пишем ни одной, печатаем обе |

Зеркальные строки: `realtime` → `source='import'`, `manual_history` → `manual_history`; `collected_at` = момент донора, прочитанный как ташкентский (`AT TIME ZONE 'Asia/Tashkent'`); `m3` — `amount IS NULL`, `status='collected'` (проверка «NULL остаётся NULL»). Автоматы заводятся карточками `entity` типа `machine` с `external_ref` в каноне (`ab01181f0000`, `039ec91c0000`, `fa86d0060000`).

Последовательность прогонов и проверок:
```js
  // 1. Правка времени ДО ключей обязана ОТКАЗАТЬ: происхождение не доказано.
  await обязанОтказать("правка времени без ключей отказывает кодом 3", () =>
    прогонОжидаяКод(ВРЕМЯ, ["--dry-run", "--expect=2"], 3));

  // 2. Примерка ключей: числа полные, база нетронута.
  const примерка = прогон(КЛЮЧИ, ["--dry-run"]);
  сверить("сопоставлено", примерка.сопоставлено, 3);
  сверить("к записи", примерка.кЗаписи, 3);
  сверить("неоднозначно — одна группа из двух строк с каждой стороны", примерка.неоднозначно.length, 1);
  сверить("расхождение статуса напечатано", примерка.расхождениеСтатуса.length, 1);
  сверить("примерка не записала ни одного ключа", await число(sql`select count(*) n from collection where client_key is not null`), 0);

  // 3. Запись, потом повтор: второй `--apply` обязан дать «записано 0».
  сверить("записано", прогон(КЛЮЧИ, ["--apply"]).записано, 3);
  сверить("повтор записывает ноль", прогон(КЛЮЧИ, ["--apply"]).записано, 0);
  сверить("неоднозначная пара осталась без ключа",
    await число(sql`select count(*) n from collection where client_key is null and source = 'manual_history'`), 2);

  // 4. Правка времени: примерка, запись, повтор.
  сверить("к правке", прогон(ВРЕМЯ, ["--dry-run", "--expect=2"]).кПравке, 2);
  const правка = прогон(ВРЕМЯ, ["--apply", "--expect=2"]);
  сверить("правлено", правка.правлено, 2);
  сверить("суммы до и после совпали", JSON.stringify(правка.суммыДо), JSON.stringify(правка.суммыПосле));
  сверить("сутки не поехали", JSON.stringify(правка.суткиДо), JSON.stringify(правка.суткиПосле));
  await обязанОтказать("повтор правки отказывает по отметке события", () =>
    прогонОжидаяКод(ВРЕМЯ, ["--apply", "--expect=2"], 3));

  // 5. Проверки по базе, а не по отчёту.
  сверить("сдвинулись ровно донорские realtime",
    await число(sql`select count(*) n from collection where source = 'import'
                     and collected_at = (timestamp '2026-01-30 11:40:42.626' at time zone 'Asia/Tashkent')`), 1);
  сверить("manual_history не тронут",
    await число(sql`select count(*) n from collection where source = 'manual_history'
                     and collected_at <> (timestamp '2026-01-30 12:46:00' at time zone 'Asia/Tashkent')`), 0);
  сверить("`amount IS NULL` осталось NULL",
    await число(sql`select count(*) n from collection where amount is null`), 1);
  сверить("записей аудита — по одной на строку",
    await число(sql`select count(*) n from audit_log where action = 'collection.time_corrected'`), 2);
  сверить("отметка события ровно одна",
    await число(sql`select count(*) n from event where type = 'cash.collection_time_corrected'`), 1);
```
Уборка: `drop schema if exists vendcash_donor cascade`; `delete from audit_log where action='collection.time_corrected' and target in (…свои id…)`; `delete from event where id in (…запомненные id…)`; `delete from collection where id in (…свои id…)`; `delete from entity where id in (…три свои карточки…)`. Ни одного `delete … where source = 'import'` — это ровно то оружие, от которого стоят заставы.
- [ ] **Step 5: CI.** В `.github/workflows/ci.yml`, шаг «Smoke (Core против настоящего postgres)», сразу после строки `SMOKE_SCRATCH=1 node tools/smoke-import.mjs` (`:94`):
```yaml
          # Дым инкассаций (срез «правда о пробеле»): заглушка drizzle не
          # исполняет ни уникальный индекс по nullable-колонке, ни `on conflict
          # do nothing` по нему, ни транзакционность разовой правки времени, ни
          # заставу «повторный прогон отказывает». Прогон заводит фикстурного
          # донора в схеме `vendcash_donor` той же базы и убирает за собой.
          # Идёт ДО smoke-core.mjs: тот о доноре знать не должен.
          SMOKE_SCRATCH=1 node tools/smoke-collections.mjs
```
- [ ] **Step 6: Локальная проверка дыма.**
```bash
createdb inkasssmoke_fw
export DATABASE_URL=postgres://localhost/inkasssmoke_fw
pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build
node packages/db/dist/migrate.js && node packages/db/dist/seed.js
SMOKE_SCRATCH=1 node tools/smoke-collections.mjs
dropdb inkasssmoke_fw
```
Ожидание: «Дымовой прогон инкассаций: ОК.», ни одной строки подключения в выводе, `select count(*) from collection` после прогона — 0.
- [ ] **Step 7: Проверка заставы.** Прогнать `node tools/smoke-collections.mjs` БЕЗ `SMOKE_SCRATCH=1` на базе с боевым именем (`postgres://localhost/mydon`) — обязан отказать до первой записи, назвав только `host`. Это единственная застава, которую не обходит SSH-туннель на `localhost:5432`.
- [ ] **Step 8:** `pnpm --filter core build && pnpm --filter core test` → GREEN; `pnpm -s lint && pnpm -s typecheck && pnpm -s test` целиком → GREEN.
- [ ] **Step 9: Аддендум спеки.** В `docs/superpowers/specs/2026-08-26-inkassacii-truth-design.md` — раздел `## 12. Аддендум (по факту реализации)` с четырьмя отклонениями из шапки этого плана: `ОКНО_СРАВНЕНИЯ` шире `ОКНО_СВЕРЕНО` на сутки (UTC-обрезка `gaps.service.ts:202`), флаг `--expect=<N>` у `fix-collection-time`, `docs/DEPLOY.md` целиком за T4, `ACTION_LABELS` вместо приватного словаря `describe`. Каждое — с причиной, а не просто фактом.
- [ ] **Step 10:** `git commit -m "test(core,tools,ci): дым инкассаций против живого Postgres и сторож единственного писателя (инкассации, R-I-2, R-I-4)" -- apps/core/src/collections/collections.test.ts tools/smoke-collections.mjs .github/workflows/ci.yml docs/superpowers/specs/2026-08-26-inkassacii-truth-design.md`

---

## Выкатка (спека §9)

> **Из задач плана прод НЕ пишется ни разу.** Записей в прод три, и все они — шаги ниже, которые делает ОПЕРАТОР руками: миграция (автодеплоем), `backfill-collection-keys --apply`, `fix-collection-time --apply`. Донор (VendCash) не пишется ни здесь, ни там: подключение открывается с `max: 1` и исполняет только SELECT.

**Предусловие:** ветка `fix/inkassacii-truth` от свежего `main`. После `git checkout main` ПЕРВОЙ командой — `git checkout -b`: фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты.

1. **Архив донора (T4) — ДО ВСЕГО ОСТАЛЬНОГО.** Четыре шага из `docs/DEPLOY.md`, раздел «Архив донора VendCash». Проверка `ls -lh`: пустой `.sql.gz` значит, что дамп упал, а пайп это скрыл. **Пока архива нет, гасить донора нельзя и трогать данные незачем.** Архив — единственный носитель GPS 246 сборов, `collection_history` (502) и приёмщиков (385).
2. **PR → CI зелёный** (lint · typecheck · build · test · миграции на живом Postgres · шаг `backfill-product-ids.js` без флагов · `smoke-import` · **`smoke-collections`** · `smoke-core` · `smoke-panel`) → adversarial-ревью → squash-мерж.
3. **Полный прогон перед PR:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`; отдельно `pnpm --filter @mydon/db db:generate` → «No schema changes» (снапшот миграции обязан быть уже в коммите); смоук на scratch-БД целиком: `createdb inkasssmoke_fw` → `migrate.js` → `seed.js` → `seed-vending.js` → `SMOKE_SCRATCH=1 node tools/smoke-collections.mjs` → `dropdb inkasssmoke_fw`.
4. **Деплой и сверка того, что выкачено ИМЕННО это.** `GET /health` → `commit` совпадает с коммитом мержа: каталог обновляется за секунды, образ собирается минуты. Миграция применяется автодеплоем; проверить, что колонка на месте:
   ```bash
   /opt/backups/db_access.sh query "select count(*) from information_schema.columns where table_name='collection' and column_name='client_key'"
   # → 1
   /opt/backups/db_access.sh query "select indexdef from pg_indexes where indexname='collection_client_key'"
   # → CREATE UNIQUE INDEX ...
   ```
5. **Снимок «до».** Сохранить в файлы ответы `GET /collections/reconcile?from=2025-06-01&to=2026-08-26` и `GET /gaps`, а также распределение часов (запрос из `docs/DEPLOY.md`). Без снимка «до» пост-проверка превращается в «кажется, похоже».
6. **Бэкап базы перед первой записью** (R-I-6): `/opt/backups/db_access.sh dump | gzip > /opt/backups/pre-inkass-timefix-$(date +%F).sql.gz`, проверить `ls -lh`. Отдельного дампа таблицы `collection` не делаем: у helper'а нет ключа `-t`, а откат 247 отметок времени идёт из `audit_log.before`, не из дампа.
7. **ЗАПИСЬ 1 — ключи.** Обе команды через `docker exec -i mydon-core`, обе с `</dev/null`, `VENDCASH_DATABASE_URL` — ровно на эти две команды и не в `.env`:
   ```bash
   docker exec -i -e VENDCASH_DATABASE_URL="$VENDCASH_URL" mydon-core \
     node packages/db/dist/backfill-collection-keys.js --dry-run </dev/null
   docker exec -i -e VENDCASH_DATABASE_URL="$VENDCASH_URL" mydon-core \
     node packages/db/dist/backfill-collection-keys.js --apply   </dev/null
   ```
   Ожидание примерки: **сопоставлено 374, к записи 374, без пары 12 + 12** (автомат с расходящимся кодом, R-I-8), **неоднозначно 0 либо 2**, **расхождение статуса — 1 строка** (30.06.2026). Любое другое число — **остановка выкатки**, а не флаг. Повторный `--apply` обязан дать «записано 0».
8. **ЗАПИСЬ 2 — время.** Только если шаг 7 оставил 0 строк `source='import'` без ключа — скрипт скажет это сам и откажется иначе:
   ```bash
   docker exec -i mydon-core node packages/db/dist/fix-collection-time.js --dry-run </dev/null
   docker exec -i mydon-core node packages/db/dist/fix-collection-time.js --apply   </dev/null
   ```
   Ожидание: **найдено 247, к правке 247**; часы до 4–14, после 9–19; суммы по статусам до и после совпадают до копейки; сутки до и после совпадают. Третий прогон обязан ОТКАЗАТЬ кодом 3 по отметке события — это и есть проверка защиты от двойного сдвига.
9. **Пост-проверка (только чтение).**
   * распределение часов (запрос из `docs/DEPLOY.md`): `import` 9–19, `manual_history` 10–20 **не тронут**;
   * `GET /collections/reconcile?from=2025-06-01&to=2026-08-26` против снимка «до»: количество строк по статусам не изменилось, принято — те же **264 477 000 сум**, сходимость по «обычным» держит прежние −0,7 %; «ожидалось» у отдельных интервалов сдвигается в пределах **~0,1 %** (границы `LAG` уехали на пять часов, объём пятичасовой наличной выручки перетёк к соседу) — это объявлено ЗДЕСЬ, до правки, а не показано молча;
   * `GET /gaps`: окно 30.07.2025 – 30.01.2026 на месте, текст действия новый, в VendCash не зовёт; подпись границы окна могла уехать на сутки (UTC-обрезка, `gaps.service.ts:202`) — числа те же, а ветка «проверенного периода» это переживает (`ОКНО_СРАВНЕНИЯ`);
   * `GET /audit?action=collection.time_corrected` → **247** записей; `GET /events?type=cash.collection_time_corrected` → **1**, в payload `rows: 247` и `hours: 5`;
   * панель `/audit`: первый экран занят правкой времени — это разовое и **ожидаемое** (R-I-5), подпись по-русски («поправил время инкассации (перенос VendCash, +5 часов)»).
10. **Память и планы.** Отметить в `docs/DATA_SOURCES.md` фактическую дату архива донора (правка одной строки — это правка репозитория, а не прода; делается PR'ом). Два вопроса остаются за владельцем и срез не блокируют: код автомата `3be8c71f0000` / `3be8c71e0000` (12 строк живут без ключа, и это видно в отчёте бэкфилла) и судьба окна авг–дек 2025 — детектор 3 называет ОБА варианта и больше никуда не зовёт.

## Самопроверка плана

**Покрытие рулингов спеки:**

| Рулинг | Где закрыт | Чем проверен |
|---|---|---|
| R-I-1 окно не импортируем; `/gaps` и документация говорят правду | T1 (константы, `журнальноеДействие`, раздел `DATA_SOURCES.md`) | T1 «окно внутри проверенного диапазона… НЕ зовёт в VendCash» (`assert.ok(!/выгруз/i…)`), «окно за пределами — не утверждаем, что записей нет», «граница, уехавшая на сутки UTC-обрезкой, остаётся внутри», «дата сверки и границы — константы, а не стенные часы»; выкатка §9 (`GET /gaps` против снимка «до») |
| R-I-2 `client_key` — идентичность в ИСТОЧНИКЕ, а не подпись каждой строки | T2 (колонка + уникальный индекс, `create()` с `onConflictDoNothing`, ключ бота), T5 (сторож писателя) | `schema.test.ts` «есть `clientKey`, он nullable», «индекс УНИКАЛЬНЫЙ»; `collections.test.ts` «без ключа пишет NULL», «кладёт переданный ключ, а не выдумывает свой», «повтор возвращает ПЕРВУЮ строку», «повтор не пишет второй `audit_log`», «разные нажатия — две инкассации»; `staff.test.ts` «ключ `bot:collect:…`», «повтор внутри минуты — тот же ключ», «часы — параметр»; T5 сторож «писатель ровно один»; дым «повтор записывает ноль» на настоящем уникальном индексе |
| R-I-3 сопоставление по (код, момент, сумма); статус — сверяемое поле | T2 (`ключСопоставления`, `нормализоватьКод`, отчёт) | «момент донора читается как ташкентские настенные часы», «верхний регистр и код, короткий на символ, нормализуются», «…71f / …71e НЕ сшиваются», «`amount IS NULL` совпадает с `amount IS NULL`, а не с нулём», «расхождение статуса паре не мешает, но печатается», «две донорские строки с одним ключом — не пишем ни одной», «примерка не пишет и печатает то же число», «повторный `--apply` — записано 0», «пустая примерка говорит словами»; дым — те же числа против сервера |
| R-I-4 сдвиг только по доказанному множеству и только один раз | T3 (множество, четыре заставы, `--expect`), T5 (дым) | «правятся только строки с `source='import'` И ключом», «строка без ключа — отказ», «`manual_history` не трогается», «сдвиг берёт смещение из `tashkent-time`», «`received_at` вместе, `NULL` остаётся `NULL`», «суммы и статусы совпали», «сутки не меняются: 4–14 → 9–19», «найдено не столько — остановка», «отметка события останавливает», «записи аудита останавливают», «час больше 19 — отказ»; дым: правка ДО ключей отказывает кодом 3, повтор отказывает по отметке |
| R-I-5 след — `audit_log` построчно плюс одно событие; в ленте «Действия» нет | T3 (аудит, событие, подпись на витрине) | «на каждую правленую строку — запись аудита с полными `before`/`after`», «событие несёт число строк, границы и сам сдвиг в часах», «правка и отметка едут одной транзакцией»; `page.test.tsx` «подписано по-русски, а не кодом», «называет и причину, и величину», «прежние подписи на месте»; в диффе нет ни одной правки `apps/core/src/registry/actions.service.ts` — лента берёт только `source='realtime'` (`:203`), то есть перенесённые строки не видны там ни до, ни после, по построению |
| R-I-6 бэкап — полный дамп helper'ом, откат — из `audit_log` | T4 (раздел рунбука), выкатка §6 | текст рунбука называет причину (у `db_access.sh` нет `-t`, `:143-147`/`:169-173`) и путь отката; тест T3 «полные `before` и `after`» доказывает, что откатывать есть чем |
| R-I-7 архив донора — шаг рунбука, а не код | T4 (`docs/DEPLOY.md`), выкатка §1 | в диффе нет ни одного нового файла в `packages/db/src/` про архив; шаг стоит ПЕРВЫМ в чек-листе, проверяется `ls -lh`, дамп снимается образом `postgres:17-alpine` |
| R-I-8 коды `…71f` / `…71e` — решение владельца | T2 (нормализация без сшивания) | «коды, различающиеся символом, НЕ сшиваются»; «строки без пары уезжают в отчёт обеими сторонами, с кодом и моментом»; T3 «строка `source='import'` без ключа — отказ» — то есть до ответа владельца правка времени честно откажется; выкатка §7 объявляет «без пары 12 + 12» ожидаемым результатом |
| R-I-9 GPS, `collection_history`, приёмщики — вне охвата | T4 (абзац в `DATA_SOURCES.md`) | в диффе нет ни одной новой колонки: `git diff` по `packages/db/src/schema.ts` — только `clientKey` и его индекс; миграция — два оператора |
| §6 данные и миграции | T2 Step 7 | одна миграция (следующий свободный номер), оба оператора `IF NOT EXISTS`; колонка nullable и остаётся nullable; `audit_log` и `event` не меняются; новых настроек нет; оба скрипта зарегистрированы в `packages/db/package.json`; `db:generate` → «No schema changes» (выкатка §3); сторож цепочки `migrations-chain.test.ts` ловит столкновение номеров с П6/П7 на CI |
| §7 события и правила | T3 (событие), T5 (дым) | одно событие `cash.collection_time_corrected` с `{ rows, from, to, hours }`, читается `GET /events?type=` и служит заставой №2; событий бэкфилла НЕТ намеренно; в диффе нет правок `apps/core/src/rules/rules.ts` и `RULE_EVENT_TYPES` (правил по инкассациям в файле нет вовсе — `grep -c collection` → 0) |
| §4 общие ограничения (время, «сейчас», токен, троттлы, ноль ≠ хорошо) | Global Constraints; T1·T2·T3·T5 | смещение экспортируется из `tashkent-time.ts` и проверено тестом «второй копии быть не должно»; `now` — параметр у ключа бота (`staff.test.ts` «часы — параметр»), у события (`fix-collection-time.test.ts` «событие несёт… `occurredAt`») и у отчётов; новых роутов и троттлов нет, `POST /collections` остаётся под `ServiceTokenGuard`; «нечего писать» словами — тест «пустая примерка говорит словами»; строка подключения не печатается — дым проверяет `безСекретов` и `хост` |
| §8 тесты | T1·T2·T3·T5 | все перечисленные в §8 наборы выписаны: `gaps.service.test.ts` (4 + переименование `:167`), `schema.test.ts`, `migrations-chain.test.ts` (4), `collections.test.ts` (5 + сторож), `staff.test.ts` (3), `backfill-collection-keys.test.ts` (10), `script-flags.test.ts` (5), `fix-collection-time.test.ts` (13), `page.test.tsx` (3), `tools/smoke-collections.mjs` |
| §9 выкатка | Раздел «Выкатка» | десять шагов оператора в порядке спеки: архив → PR/CI → деплой и сверка колонки → снимок «до» → бэкап → ключи → время → пост-проверка → память; ни один из них не является шагом задачи |

**Сканирование на заглушки.** В плане нет `TBD`, нет «add validation», нет «аналогично Task N» и нет «см. выше» вместо кода: каждый тест и каждый фрагмент реализации выписан там, где он нужен. Четыре места, где план сознательно НЕ выписывает код целиком, названы явно и заглушками не являются: (а) полное тело `backfill-collection-keys.ts` — выписаны обе чистые функции (`нормализоватьКод`, `ключСопоставления`), запрос донора, запрос MYDON, предикат записи и формат отчёта, то есть всё, где можно ошибиться; склейка Map→пары механическая и полностью задана тестами; (б) полный SQL фикстуры дыма — таблица «пять строк» задаёт каждую строку и то, что она доказывает, а `INSERT`ы пишутся по ней однозначно (образец разметки — `завестиДонора()` в `smoke-import.mjs:214`); (в) стенд `стендDb` в тесте бэкфилла помечен как возможно хрупкий, и рядом назван проверенный запасной приём из `backfill-product-ids.test.ts:126-136` — утверждение, которое он проверяет, обязательно, а форма стенда нет; (г) точный номер миграции — он ЗАВИСИТ от того, что успеют занять П6/П7, и потому определяется командой в Step 7, а не числом в плане; сторож цепочки существует ровно для этого.

**Согласованность типов между задачами.** `TASHKENT_OFFSET_MS` и `tashkentMinute` объявлены ровно один раз — `packages/shared/src/tashkent-time.ts` (T2); `fix-collection-time.ts` (T3) и `staff.ts` (T2) их ИМПОРТИРУЮТ, своей копии смещения не заводит никто, и это утверждает тест «смещение экспортировано и равно ровно пяти часам» вместе со сверкой против `tashkentDay`. `ПРЕФИКС_КЛЮЧА` объявлен один раз (`backfill-collection-keys.ts`, T2) и импортируется в `fix-collection-time.ts` (T3) и в его тест: второй литерал `"vendcash:collection:"` в репозитории означал бы, что множество правки и множество бэкфилла могут разойтись молча. `РазборФлагов` живёт в `script-flags.ts`; `разобратьАргументы` в `backfill-product-ids.ts` после T2 — обёртка, СОХРАНЯЮЩАЯ прежнюю форму результата (`{ ok, dryRun, режим }` без `числа`), потому что три существующих теста сверяют объект целиком через `assert.deepEqual` — это контракт, а не деталь. `DonorReader` в `backfill-collection-keys.ts` — СВОЙ интерфейс, не тот, что в `import-stock-history.ts:81`: у них разные доноры и разные строки, а общий тип свёл бы две несвязанные базы в одно имя. `BackfillKeysReport` и `FixTimeReport` — внутренние формы скриптов, по HTTP не отдаются и в `@mydon/shared` не едут. `CreateCollectionInput.clientKey` (Core) и `clientKey` в `CreateCollectionDto` (контроллер) — одно поле в двух слоях, как и у остальных полей DTO; третьего объявления нет, панель `POST /collections` не зовёт вовсе. `ACTION_LABELS` (T3) — новый экспорт `page.tsx`, единственный потребитель — его же `describe` и тест; словарь не дублируется ни в Core, ни в боте.

**Матрица пересечений файлов (кто с кем не может идти параллельно):**

| Файл | T1 | T2 | T3 | T4 | T5 |
|---|---|---|---|---|---|
| `apps/core/src/gaps/gaps.service.ts` (+test) | ✔ | | | | |
| `docs/DATA_SOURCES.md` | ✔ | | | ✔ | |
| `packages/shared/src/tashkent-time.ts` (+test) | | ✔ | | | |
| `packages/db/src/schema.ts` · `schema.test.ts` · `drizzle/` | | ✔ | | | |
| `packages/db/src/{migrations-chain,script-flags,backfill-*}.ts` (+tests) | | ✔ | | | |
| `packages/db/package.json` | | ✔ | ✔ | | |
| `apps/core/src/collections/collections.{service,controller}.ts` | | ✔ | | | |
| `apps/core/src/collections/collections.test.ts` | | ✔ | | | ✔ |
| `apps/bot/src/{core-client,staff}.ts` (+test) · `.env.example` | | ✔ | | | |
| `packages/db/src/fix-collection-time.ts` (+test) | | | ✔ | | |
| `apps/cc/src/app/audit/page.tsx` (+test) | | | ✔ | | |
| `docs/DEPLOY.md` | | | | ✔ | |
| `tools/smoke-collections.mjs` · `.github/workflows/ci.yml` | | | | | ✔ |
| `docs/superpowers/specs/…-inkassacii-truth-design.md` | | | | | ✔ |

Три пересечения — и все три СТРОГО последовательные, то есть параллельным волнам не мешают: `packages/db/package.json` (T2 → T3), `apps/core/src/collections/collections.test.ts` (T2 → T5), `docs/DATA_SOURCES.md` (T1 → T4). **Волна A: T1 ∥ T2** (ни одного общего файла). **Волна B: T3 ∥ T4** (ни одного общего файла; T3 требует T2, T4 требует T1). **Волна C: T5** (требует T2 и T3).

**Известные риски исполнения.** (1) Номер миграции — единственное место, где план не может назвать значение заранее; исполнителю велено СМОТРЕТЬ дерево, а не верить числу 0072, и сторож цепочки красит CI при столкновении. (2) `.onConflictDoNothing` ломает существующую заглушку `collections.test.ts` — правка заглушки выписана целиком в T2 Step 4, и она обязана пережить и обычную вставку (`audit_log`), и вставку с конфликтом. (3) Ключ бота меняет сигнатуру `handleStaffCallback` на пять параметров: пятый ОБЯЗАН иметь умолчание, иначе покраснеют четыре чужих тестовых файла (`coffee-visit-robustness.test.ts`, `staff-refill.test.ts` и соседи) и `apps/bot/src/index.ts:945`. (4) T3 и T5 трогают денежный журнал только на scratch; любой прогон дыма против базы с непустой `collection` обязан отказать — если он вдруг прошёл, застава сломана, и это важнее самого дыма. (5) Отчёт `fix-collection-time` печатает суммы «до» и «после»: их расхождение — не предупреждение, а ошибка реализации; поймать её обязан тест «суммы и статусы до и после совпадают», а не глаза оператора на проде. (6) Общий worktree с Codex: перед правкой дерева сверять `mtime` чужих файлов и коммитить только своими путями (`git commit -- …`); `git add -A` утащит чужое.
