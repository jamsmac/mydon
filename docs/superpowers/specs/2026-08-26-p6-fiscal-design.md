# Срез П6 «Фискальный блок товаров, журналы, „Мои записи“» — дизайн (7 задач)

Дата: 2026-08-26. Worktree `~/Developer/mydon-p6`, ветка `feat/p6-fiscal` от
`origin/main` **b3b595d** («Хвосты снек-контура», #217). Задача владельца — #18
плана поглощения (`docs/PLAN_STOCK_ABSORPTION.md:352-361`).

Опись (SELECT-only, ничего не правилось):
`.superpowers/sdd/2026-08-26-sloy-p6-fiscal/inventory.md`.
Рулинги контроллера R-P6-1…R-P6-4:
`.superpowers/sdd/2026-08-26-sloy-p6-fiscal/progress.md`.

**Зависимостей от невлитых веток нет.** Последняя миграция в `main` — **0071**
(`packages/db/drizzle/0071_stock_count_retention_idx.sql`, журнал
`packages/db/drizzle/meta/_journal.json`, idx 71), новая в этом срезе — **0072**.

## 1. Цель

Один вопрос на задачу — и на каждый сегодня нет ответа:

| # | Вопрос владельца | Почему ответа нет |
|---|---|---|
| 1 | «Где у снек-товара ИКПУ?» | `vending_product` (52 карточки, 109 алиасов) не имеет НИ ОДНОГО фискального поля (`packages/db/src/schema.ts:1371-1410`); фискальные данные лежат в `entity(type='product').attrs` — другая таблица, другой контур |
| 2 | «Как проверить, что код не огрызок?» | `IKPU_DIGITS = 17` и `fiscalGaps()` (`packages/shared/src/sources.ts:187`, `:219`) читают только `attrs`; штрих-код, МХИК, маркировку и ОКЕИ-единицу не проверяет никто |
| 3 | «Кто и когда правил фискальные поля?» | правок нет вовсе; ближайший аналог `vending.product.set_rules` пишет в `audit_log` before/after по ТРЁМ ключам правил закупа (`apps/core/src/vending/vending.service.ts:2150-2180`) |
| 4 | «Что стоит в карточке — прямо здесь, в чате?» | фискальных команд у бота нет ни одной; из товарных есть только «цена …», «блок …», «не закупать …» (`apps/bot/src/product-rules.ts:27`, `apps/bot/src/handler.ts:259`) |
| 5 | «Перенеси ИКПУ из mydon-stock» | донор держит 44 кода на 62 товара, из них **24 категорийных**; перенос «как есть» даёт вид заполненности при непроходимом чеке |
| 6 | «Оператор ошибся в заправке — как отменить?» | в `apps/core/src/vending/vending.controller.ts` нет НИ ОДНОГО `@Delete`: `POST /vending/refills` (`:656`), `POST /vending/stock` (`:601`), `POST /vending/cash` (`:627`) — только запись |
| 7 | «Покажи мои последние записи» | бот показывает **только последнюю** запись автора и только по кофе (`apps/bot/src/coffee-fix.ts:40`); по снеку — ничего |

## 2. Инвентаризация (проверено в рабочем дереве `feat/p6-fiscal`)

### Сторона MYDON — что переиспользуется

| Факт | Где |
|---|---|
| `vending_product`: `name UNIQUE`, `category`, `purchasePrice`, `salePrice`, `packSize`, `excludedFromPurchase`, `fixedPurchaseQty`, `isActive` — **фискальных полей ноль** | `packages/db/src/schema.ts:1371-1410` |
| `vending_alias` (`alias UNIQUE` → `productId`, `source`) | `packages/db/src/schema.ts:1421-1431` |
| `normalizeProductName` (trim → lower → `ё→е` → сжатие пробелов → запятая между цифрами в точку) | `packages/shared/src/vending-calc.ts:49` |
| `productIndex(products, aliases)` → `{ canon, id, explain }`; **имя карточки главнее алиаса** (R-FW-S3), спор возвращается как `conflict` | `packages/shared/src/stock-history.ts:353`, тип `CanonAnswer` `:315` |
| `entity(type='product')` — карточка реестра, значения в `attrs JSONB` | `packages/db/src/schema.ts:64-97` |
| `FISCAL_FIELDS = ["ИКПУ", "упаковка", "НДС"]`, `IKPU_DIGITS = 17` (со ссылкой на обоих доноров), `fiscalGaps(attrs)` различает «нет» и «неверно» | `packages/shared/src/sources.ts:121`, `:187`, `:219` |
| Витрина «Фискальная готовность» по `attrs` + `штрихкод` | `apps/cc/src/components/product-card-sections.tsx:38-45` |
| Кольцо полноты карточки реестра («ИКПУ не заполнен — без него нет чека») | `apps/cc/src/components/product-card-360.tsx:52`, `:63` |
| `isIncomplete(e)` списка товаров реестра | `apps/cc/src/components/products-book.tsx:19-24` |
| Ключи `attrs` живут в коде дословно: `ИКПУ`, `упаковка`, `НДС`, `штрихкод` | `packages/shared/src/sources.ts:121`, `apps/cc/src/components/product-card-sections.tsx:42`, `apps/cc/src/lib/labels.ts:59` |
| `GET /vending/products` → `products()` → `VendingProductRow` | `apps/core/src/vending/vending.controller.ts:548`, сервис `vending.service.ts:2092`, тип `:510` |
| Зеркало типа в панели (второй и последний экземпляр — бот копии НЕ держит) | `apps/cc/src/lib/core.ts:206` |
| Образец «единого писателя» поля товара: `setProductRules` — before/after, событие и `audit_log` в ОДНОЙ транзакции | `apps/core/src/vending/vending.service.ts:2120`, событие `:2172`, аудит `:2177` |
| DTO-образец `SetProductRulesDto` (class-validator, «нечего менять» → 400) | `apps/core/src/vending/vending.controller.ts:243-260`, роут `:554` |
| Общий писатель журнала `AuditService.record(entry)` (свой хендл БД, вне транзакции вызывающего) | `apps/core/src/audit/audit.service.ts:25` |
| Схема `audit_log`: `actorKind`/`actorRef`/`action`/`target`/`before`/`after`/`ts` | `packages/db/src/schema.ts:1271-1284` |
| Мутации закрыты глобальным `ServiceTokenGuard` (GET/HEAD/OPTIONS — мимо, fail-closed) | `apps/core/src/common/service-token.guard.ts:35-70`, регистрация `apps/core/src/app.module.ts:83` |
| Сторож именованных лимитеров `burst`/`sustained` («default» ThrottlerGuard не читает) | `apps/core/src/vending/vending.controller.test.ts:15` |
| Конвенция мутирующих форм CC (`onSubmit` + `FormData` + server action + `router.refresh()`, поля сохраняют ввод) | `CLAUDE.md:57-67`, эталон `apps/cc/src/components/customs-rates.tsx:17-33` |
| Карточка снека в панели («Правила закупа»): список + форма правки | `apps/cc/src/components/product-rules-panel.tsx:26`, лист `product-rules-view.tsx:9` |
| Server action правил закупа | `apps/cc/src/app/vending/actions.ts:38` |
| Заливка: `RefillService.create` — идемпотентна по `clientKey`, списывает склад, пишет `audit_log` и событие в одной транзакции | `apps/core/src/vending/refill.service.ts:62`, аудит `:134`, событие `:147` |
| `vending_refill`: `clientKey` уникален, CHECK `qty > 0`, `source`, `createdBy`, `personId` | `packages/db/src/schema.ts:1700-1740` (`uniqueIndex` `:1737`, `check` `:1738`) |
| Инвентаризация склада: `ingestStock(payload, actor = "owner")` — вся пачка в одной транзакции, ОДИН `countedAt` на ввод | `apps/core/src/vending/vending.service.ts:1394`, строки истории `:1467` |
| `vending_stock_count`: `dt`, `productName`, `productId`, `qty numeric`, `source`, `extId`, `countedAt`, `personId`, `note`; частичный уникальный `own_key (source, counted_at, product_name)` | `packages/db/src/schema.ts:1580-1614` (`own_key` `:1604`) |
| Касса закупа: `recordCashSession(receivedAmount, categories, createdBy = "owner")` — одна строка | `apps/core/src/vending/vending.service.ts:2925`, чтение `:2945` |
| `vending_cash_session`: `receivedAmount`, `categories jsonb`, `totalSpent`, `remainder`, `createdBy` — **колонки `source` нет** | `packages/db/src/schema.ts:1827-1837` |
| Лента «Действия» собирается ЧТЕНИЕМ доменных таблиц, а не из `audit_log` | `apps/core/src/registry/actions.service.ts:20-33`, снек-заправки `:120-131`, подпись `:262-268` |
| `ActionRow.kind` — закрытый союз; `personIdOf("person:<uuid>")` | `apps/core/src/registry/actions.service.ts:36-56`, `:70` |
| Матрица прав: 6 ролей, 12 прав, `owner: [...PERMISSIONS]`, `can(roles, perm)` | `packages/shared/src/roles.ts:15-104` (право `system.admin` `:52`, `owner` `:96`, `can` `:100`) |
| `person.roles text[] NOT NULL DEFAULT '{}'` (легаси `role` — свободный текст, ботом не читается) | `packages/db/src/schema.ts:141-168` |
| Меню бота фильтруется тем же `can`; пункт «↩️ Ошибся — исправить» | `apps/bot/src/menu.ts:144`, `menuFor` `:152` |
| Образец двухшаговой отмены в боте: показать запись → две кнопки в РАЗНЫХ рядах → строгий разбор `callback_data` | `apps/bot/src/coffee-fix.ts:31-58` |
| Кофейное удаление: `onlyIfCreatedBy` + снимок строки в `audit_log.before`, **лимита 24 ч нет** | `apps/core/src/coffee/coffee.service.ts:706-757` |
| Реестр правил + `RULE_EVENT_TYPES` (без записи тип не попадёт в `/rules/pending` — урок N5) | `apps/core/src/rules/rules.ts:405-434`, `:527`, `:601` |
| Настройки: `ConfigSpec {key,label,kind,fallback,help,validate}`, `inRange`, чтение `readIntSetting` | `apps/core/src/system/config-spec.ts:15-27`, `:63`, `apps/core/src/system/settings.ts:40` |
| Флаги разового скрипта БЕЛЫМ СПИСКОМ + строка режима, которая не врёт | `packages/db/src/backfill-product-ids.ts:346-386` (`ЗНАЕМ_ФЛАГИ` `:346`, `разобратьАргументы` `:369`) |
| Карта решения `raw → канон (источник)` только в примерке, потолок печати 50 | `packages/db/src/backfill-product-ids.ts:332-343` |
| Донорское подключение `sqlDonor(url, schema)`, `STOCK_DATABASE_URL` + `STOCK_SCHEMA`, отдельный код возврата **2** на «донор не подключён» | `packages/db/src/import-stock-history.ts:471`, `:660-684` |
| Разборная строка `ИТОГИ(json): …` в отчёте разового скрипта | `packages/db/src/import-stock-history.ts:644-652` |
| Застава смоука: `SMOKE_SCRATCH=1` либо имя базы со словом `smoke`, до первой записи, без строки подключения в сообщении | `tools/smoke-core.mjs:67-81`, `tools/smoke-import.mjs:312` |
| Рунбук разового переноса (`--dry-run` → числа → `--apply`, `</dev/null` обязателен) | `docs/DEPLOY.md:99-124` |
| Мотив среза записан у нас же: «нет ИКПУ, упаковки и ставки НДС — чек не собирается, хотя деньги получены»; «заполнено, но неверно» — самое опасное состояние | `docs/DATA_SOURCES.md:214-241` |
| Источник фискальных значений реестра — каталог Multikassa (лист «Данные»/«Вывод цен») | `packages/db/src/seed-vending.ts:39-44` |

### Сторона донора (`mydon-stock`, только SELECT — числа из описи, замер 26.08)

| Факт | Где в доноре |
|---|---|
| Валидация: **регэкспов нет**, «только цифры + длина из множества», пусто законно; МХИК — тем же правилом, что ИКПУ | `app/cards.py:12-24` |
| `_digits_ok(ikpu, {17})` · `_digits_ok(mxik, {17})` · `_digits_ok(barcode, {8, 12, 13})`; тексты «ИКПУ должен быть 17 цифр или пусто» и т. д. | там же |
| Пустое поле НДС ставку НЕ затирает (`COALESCE($10, vat_rate)`) | `app/cards.py:52-79` |
| Словари: `vat` 12/0/15 · `package` ОКЕИ 796/166/112/736/778/356/111 · `marking` 0/1 · `ikpu` 31 код (10 подписаны «(категория)») · `mxik` заведён пустым | `app/refs_model.py:10-37`, загрузка карточки `app/cards.py:27-36` |
| Данные: ИКПУ 44/62 (все ровно 17 цифр, **24 категорийных**, 20 SKU) · МХИК 0 · EAN 0 · `name_uz` 0 · упаковка 44×`796` · НДС 62×`12` · маркировка 27×TRUE | опись §1.2 |
| `audit_log` и `deletions_log` донора построены и содержат **0 строк** | опись §1.5 |
| Живой EAV донора — одно поле «Блок, шт», 10 значений | опись §1.7 |
| «✏️ Мои записи»: UNION по пяти таблицам, `created_by = $1`, `ORDER BY created_at DESC LIMIT 15`, два шага подтверждения, отказы «Можно удалять только свои записи» и «Записи старше 24 часов удаляет администратор» | `app/bot.py:28`, `:1663-1687`, `:1750`, `:1775` |

### Мост имён донор → MYDON (опись §3)

* резолвится **40 из 62** строк: `products.name` = имя карточки 7, = алиас 19;
  `products.ourvend_name` = имя карточки 7, = алиас 7;
* не резолвится 22: 14 слитых дублей донора (`… [слит→N]`, все `active=false`),
  2 служебные, **6 живых напитков** под другой формулировкой (Flash Bubble Gum /
  Flash / Flash Mojito / Laimon Berries / Laimon Mango / Lit Energy Mango) — им
  нужны ручные алиасы; отдельно **Moxito Mango CAN 0.45**, чья карточка MYDON
  называется `Moxito Fresh Mango CAN 0,5` — **объём не сходится**;
* из 44 строк с ИКПУ резолвятся **37** → **37 разных карточек** из 52,
  коллизий «две донорские строки на одну карточку» **ноль**;
* ИКПУ есть с обеих сторон у **8** карточек: совпал **1**, разошлись **7** —
  в 5 случаях донор грубее (категория против SKU), 1 настоящий конфликт двух
  SKU (`Lit Energy Blueberry CAN 0,45`: наш `02202003001086002` против
  донорского `02202003001086003`), 1 дефект на нашей стороне
  (`Coca-Cola ZeroS CAN 0.25`: `2202002001010032` — **16 цифр**, потерян
  ведущий ноль; `fiscalGaps` уже помечает его как «должно быть 17 цифр, а тут 16»);
* донор закрывает **29** карточек, которых реестр не знает вовсе (в основном
  снеки), из них **11 с SKU-кодом**, 18 — с категорийным.

### Три дыры, найденные при сверке кода (расширяют охват задачи 7)

1. **`vending_stock_count.person_id` у ботовых пересчётов пуст.** DTO поле
   имеет, и его докблок говорит прямо: «Панель и бот его сегодня НЕ шлют… тогда
   в истории `person_id = NULL`… Проводка бота — отдельный срез»
   (`apps/core/src/vending/vending.controller.ts:113-123`). Клиент бота
   `setVendingStock(items)` автора не передаёт
   (`apps/bot/src/core-client.ts:487-495`).
2. **`vending_cash_session.created_by` у ботовых касс — всегда `"owner"`.**
   `recordVendingCash(...)` не шлёт `createdBy`
   (`apps/bot/src/core-client.ts:501-514`), сервис подставляет умолчание
   (`apps/core/src/vending/vending.service.ts:2928`).
3. **У снек-заправок автор есть**: мастер бота шлёт `personId`, и лента
   «Действия» на него уже опирается
   (`apps/core/src/registry/actions.service.ts:124`, `:262-268`).

Без пунктов 1 и 2 экран «Мои записи» пуст по построению для двух видов из трёх.
Проводка автора входит в задачу 7 — это две строки в клиенте бота, но без них
весь экран заглушка (урок «Фикстуры прячут масштаб»).

## 3. Рулинги

R-P6-1…R-P6-4 приняты контроллером и здесь не переоткрываются; ниже — их
развёртка до кода плюс решения, которых они не покрывают.

### R-P6-5 Шесть типизированных колонок в `vending_product`, `entity.attrs` не трогаем

**Решение.** Миграция 0072 добавляет в `vending_product`: `ikpu`, `mxik`,
`vat_pct`, `barcode`, `package_code`, `marked`. Единственный писатель —
`ProductFiscalService`. `entity(type='product').attrs` **остаётся как есть**:
`fiscalGaps(attrs)` (`sources.ts:219`), «Фискальная готовность»
(`product-card-sections.tsx:38`), кольцо полноты (`product-card-360.tsx:52`) и
`isIncomplete` (`products-book.tsx:19`) продолжают обслуживать карточки реестра.
Новая типизированная витрина живёт в карточке снека и `attrs` не читает.
`name_uz` не заводим (R-P6-4).

**Почему.** Донорские данные ложатся на канон `vending_product`: резолв идёт
через `vending_alias` и `normalizeProductName`, и 37 из 44 донорских строк с
ИКПУ находят карточку ПРАЙСА, а не карточку реестра. Реестр же несёт кофейный
контур: `Espresso/Latte/…` с `08476001003000000` и семизначной «упаковкой»
(`packages/db/src/seed-vending.ts:39-44`). Сложить их в одну таблицу значит
либо потерять кофе, либо смешать две разные величины упаковки (R-P6-7).

**Чем платим, если ошиблись.** Два места хранения фискальных полей — это два
ответа на вопрос «есть ли ИКПУ у Snickers». Платим тем, что до появления
настоящего потребителя чека (его в монорепо нет: `packages/connectors/src` не
содержит ни строки, читающей ИКПУ; `stock_batch.ikpu`,
`packages/db/src/schema.ts:496`, — снимок строки документа, а не поле карточки)
фискальная готовность видна на двух экранах. Обратный выбор — тащить донорские
значения в `entity` через `vending_alias` → канон → карточку по имени — добавил
бы третий резолвер имён туда, где сегодня его нет вовсе.

### R-P6-6 CHECK в SQL — структура, словарь — в коде

**Решение.** В миграции 0072 стоят СТРУКТУРНЫЕ ограничения: 17 цифр у
`ikpu`/`mxik`, 8/12/13 цифр у `barcode`, 3 цифры у `package_code`,
`vat_pct BETWEEN 0 AND 100`. Допустимые ЗНАЧЕНИЯ (`12/0/15`, семь кодов ОКЕИ,
маркировка `0/1`) живут константами в `packages/shared/src/fiscal.ts` и
проверяются DTO (`@IsIn`) и формой (`<select>`) — не CHECK'ом и не второй
справочной таблицей.

**Почему.** Длина кода — свойство формата, оно не меняется; набор ставок НДС —
норма, которую меняют законом, и в день изменения не должно требоваться
миграции. Второй справочный механизм (`dictionaries`/`dictionary_entries`
донора) запрещён решением 2026-08-22
(`docs/decisions/2026-08-22-navigaciya-i-gamma.md:106`): «62 записи, 0 правок за
25 дней, три из пяти — тень полей карточки товара»; R-P6-4 это подтверждает.
CHECK'и живут в SQL-файле, а не в drizzle-схеме, — та же причина, что записана
у `fixedPurchaseQty` и `packSize` (`packages/db/src/schema.ts:1400-1408`):
`check()` в схеме заставил бы генератор выпустить ещё одну миграцию ради
ограничения, которое 0072 уже ставит, и снапшот разошёлся бы с файлом.

**Чем платим, если ошиблись.** Закрытый набор ставок в CHECK потребовал бы
миграции в день изменения закона, и до неё касса не приняла бы ни одной правки.
Открытый набор только в коде теоретически позволяет записать `vat_pct = 7` мимо
DTO — но писатель ровно один и он под токеном, и это цена, которую платим
осознанно.

### R-P6-7 `package_code` — это ОКЕИ, и только ОКЕИ

**Решение.** `package_code` хранит **код ОКЕИ** (`796` «штука» по умолчанию,
семь значений словаря донора). Семизначные значения `entity.attrs["упаковка"]`
(`1218841`, `1503411`, `1166116`, `1254788`…) — это **идентификатор упаковки
каталога Multikassa/Tasnif**, ДРУГАЯ величина, и скрипт переноса их в
`package_code` не пишет НИКОГДА. Они остаются в `entity.attrs` до появления
настоящего потребителя чека.

**Почему.** Опись §2.1 показывает обе величины рядом: у донора `package_code` у
всех 44 заполненных строк равен `796`, у реестра «упаковка» — семизначный
идентификатор. Это не разные написания одного, это разные измерения: единица
измерения против ключа каталога.

**Чем платим, если ошиблись.** Сложив их в одну колонку, получаем поле, где
`796` и `1218841` значат разное, а выглядят одинаково, — то самое «заполнено,
но неверно», которое `docs/DATA_SOURCES.md:234` называет самым опасным. Цена
честного разделения: пока каталожный идентификатор Multikassa кому-то нужен, за
ним придётся ходить в `entity.attrs` — но сегодня он нужен ровно нулю
потребителей.

### R-P6-8 НДС `12` по умолчанию — перенос донорского умолчания, а не решение о карточке

**Решение.** `vat_pct integer NOT NULL DEFAULT 12`: миграция проставляет 12 всем
52 существующим карточкам. Скрипт переноса эту колонку **не трогает вообще** —
донор не несёт ни одного отклонения (62/62 = `12`).

**Почему.** Это дословный перенос донорского `vat_rate NUMERIC NOT NULL DEFAULT
12` и его же поведения: пустое поле формы ставку НЕ затирает (`COALESCE($10,
vat_rate)`, `cards.py:52-79`). Нулевая ставка в Узбекистане записывается ЯВНО —
ровно то различие, которое `fiscalGaps` (`sources.ts:246-249`) уже проводит:
«НДС 0 — законное значение, пустое — не выясняли».

**Чем платим, если ошиблись.** Карточка льготной позиции будет молча носить
12 % — переплата, видимая в самом чеке, а не недоплата государству. Обратный
выбор (nullable без умолчания) дал бы 52 карточки со статусом «ставка не
выяснена» в первый же день и погасил бы чип фискальной готовности у всех разом,
хотя ни одна из них не изменилась.

### R-P6-9 Категорийный ИКПУ отличается по СПРАВОЧНИКУ ДОНОРА, суффикс — только сверка

**Решение.** SKU-уровневым считается код, который в собственном справочнике
донора (`dictionary_entries` словаря с `key='ikpu'`) подписан БЕЗ слова
«(категория)». Суффикс `000000` — независимая сверка: если два признака
расходятся ЛИБО кода нет в справочнике донора вовсе, строка **печатается и не
пишется**. Категорийные коды не переносятся (R-P6-2).

**Почему.** «Так их называет сам справочник донора» — это слово владельца, а не
наша догадка о классификаторе, которым мы не владеем:
`02202002001000000 → «Газнапитки (категория)»`,
`01806001001000000 → «Шоколадные батончики (категория)»`. Правило по суффиксу —
утверждение о структуре ИКПУ, которое мы проверить не можем; правило по
справочнику — цитата.

**Чем платим, если ошиблись.** Доверившись только суффиксу, мы либо запишем код,
который владелец пометил категорийным, либо откажем законному SKU, случайно
оканчивающемуся нулями. Доверившись только справочнику, пропустим код, которого
в справочнике нет, — поэтому такие строки уходят в отчёт, а не в базу: 24
категорийных кода из 44 это больше половины, и цена ошибки здесь не «одна
карточка», а «половина переноса».

### R-P6-10 Сторно у ленты-дельты и у снимка — разные, и это намеренно

**Решение.** Три вида снек-записей отменяются тремя разными формами сторно:

| вид | таблица | путь записи | что значит «отменить» |
|---|---|---|---|
| `refill` — заправка автомата | `vending_refill` | `POST /vending/refills` (`vending.controller.ts:656`) → `RefillService.create` (`refill.service.ts:62`) | **ДЕЛЬТА.** Сторно-строка с `qty = −qty` оригинала + возврат количества на склад тем же upsert'ом |
| `stock_count` — пересчёт склада | `vending_stock_count` | `POST /vending/stock` (`vending.controller.ts:601`) → `ingestStock` (`vending.service.ts:1394`) | **СНИМОК.** Сторно-строка = МЕТКА отмены (`qty` копируется), обе строки уходят из чтений |
| `cash` — закупка (касса закупа) | `vending_cash_session` | `POST /vending/cash` (`vending.controller.ts:627`) → `recordCashSession` (`vending.service.ts:2925`) | **ДЕНЬГИ.** Сторно-строка с противознаком по трём суммам и по каждой статье |

**Почему.** Заливка — перемещение «склад → автомат», её величина имеет смысл, и
противознак закрывает её арифметически: все существующие читатели, суммирующие
`vending_refill.qty` (усушка, лента «Действия», отчёты), дают ноль **без единой
правки** — в этом весь смысл сторно против удаления. Инвентаризация —
абсолютное измерение «на дату D было N»; «−19 штук» на складе никто не считал, и
противознак здесь был бы выдуманным фактом. Касса — снимок похода на базар, но
снимок ЧИСЛОВОЙ, и её противознак так же честно сходится в сумме журнала.

**Чем платим, если ошиблись.** Одна форма на три ленты означала бы либо
удаление строк (запрещено R-P6-3), либо отрицательный остаток в истории
пересчётов, который кто-нибудь потом просуммирует. Цена трёх форм — три ветки в
одном сервисе и три теста; она объясняется одной строкой докблока, а выдуманный
факт в истории — нет.

**Отдельно — чего сторно инвентаризации НЕ делает.** Оно не возвращает прежний
остаток в `vending_stock`: та таблица перезаписная (`vending.service.ts:1420`),
и к моменту отмены её уже переписали заправки. Бот обязан сказать это словами:
«Пересчёт отменён и убран из истории. Текущий остаток склада он больше не
задаёт — если остаток неверен, посчитай заново».

### R-P6-11 Единица отмены инвентаризации — ВВОД, а не позиция

**Решение.** «Мои записи» показывают один пересчёт как ОДНУ строку —
`(source='own', countedAt, personId)` с числом позиций; отмена сторнирует все
строки этого ввода одной транзакцией. Ключ кнопки — `id` первой строки ввода;
Core разворачивает его в группу по `(source, countedAt, personId)`.

**Почему.** `ingestStock` пишет всю пачку с ОДНИМ `countedAt`
(`vending.service.ts:1395`, `:1468`) — это и есть естественный ключ ввода, он
уже стоит в частичном уникальном индексе `own_key (source, counted_at,
product_name)` (`schema.ts:1604`). Позиционная отмена дала бы 20 строк одного
пересчёта в списке из 15 и вытеснила бы оттуда всё остальное.

**Чем платим, если ошиблись.** Владелец, ошибшийся в ОДНОЙ позиции из двадцати,
отменяет весь ввод и вводит заново. Это дешевле экрана, где двадцать одинаковых
строк «Кола 12» отличаются только невидимым uuid.

### R-P6-12 Окно 24 ч считается по `created_at`, а «без лимита» — это право `system.admin`

**Решение.** Автор отменяет свою запись в пределах `SNACK_CANCEL_WINDOW_HOURS`
(настройка, умолчание 24) от **`created_at`** — момента ВВОДА, а не
`performed_at`/`counted_at`. Без лимита отменяет тот, у кого есть право
`system.admin` (`packages/shared/src/roles.ts:52`), то есть роль `owner`
(`:96` — `owner: [...PERMISSIONS]`). Роли `admin` в матрице нет, и заводить её
не будем.

**Почему.** Заправка, отмеченная задним числом за прошлую неделю, введена пять
минут назад — по `performed_at` она была бы неотменяемой уже в момент создания.
Слово «admin» из плана — про право, а не про роль: седьмая роль ради одного
правила рассинхронизировала бы бота и Core, которые сегодня читают ОДНУ матрицу
(`menu.ts:31`, `roles.ts:100`).

**Чем платим, если ошиблись.** Лимит 24 ч — новое ограничение для полевых, а не
перенос работающей практики: у донора он написан, но **ни разу не сработал**
(один пользователь-админ, `deletions_log` пуст), а у кофе лимита нет и жалоб не
было (`coffee.service.ts:706-757`). Поэтому он вынесен в настройку с русским
`help`, а не зашит числом: если он начнёт мешать, это правка в панели, а не
выкатка.

### R-P6-13 Отмену видно там, где её ищут: заправку — в «Действиях», все три — в `/audit`

**Решение.** Лента «Действия» получает новый вид `vending_refill_cancelled`:
выборка снек-заправок (`actions.service.ts:120-131`) добирает колонку `source`,
подпись (`:262-268`) ветвится на `source === 'storno'`. Пересчёты склада и кассы
закупа в ленту НЕ добавляются. След всех трёх отмен — `audit_log` before/after
(виден на `/audit`, `apps/cc/src/app/audit/page.tsx`) и событие
`vending.record_cancelled` с правилом в брифинг.

**Почему.** Лента строится ЧТЕНИЕМ доменных таблиц, а не из событий, — это
записано в её собственном докблоке (`actions.service.ts:22-26`). Значит
сторно-строка заправки попадёт туда САМА, и если ничего не менять, владелец
увидит «🍫 Заправка автомата 2508160376: Snickers ×-6» — заправку на минус шесть.
Ветка подписи здесь не улучшение, а обязательство. Пересчётов и касс в ленте не
было никогда: её контракт — «полевые действия сотрудников», а инвентаризация
склада и поход на базар сегодня вводятся текстовой командой владельца, а не
мастером сотрудника.

**Чем платим, если ошиблись.** Отмена пересчёта и кассы видна только в журнале
аудита и в брифинге, а не на экране «кто что сделал». Добавление двух новых
видов в ленту — это два новых запроса в утренний `Promise.all` ради событий,
которых по построению единицы в месяц; такой обмен не окупается.

### R-P6-14 Перенос пишет ТРИ поля и никогда не затирает непустое

**Решение.** `import-fiscal.ts` пишет только `ikpu`, `barcode`, `marked` — и
только туда, где у нас пусто (`ikpu IS NULL`, `barcode IS NULL`,
`marked = false`). `vat_pct` и `package_code` не трогает (R-P6-8: миграция уже
проставила умолчания, донор отклонений не несёт). `mxik` не трогает (данных ноль
с обеих сторон, R-P6-3). `pack_size` **не трогает** — только печатает 9
сопоставленных пар донорского «Блок, шт» с нашими значениями (5 из 9
расходятся) для решения владельца.

**Почему.** Приоритет по R-P6-2: MYDON `entity.attrs` важнее донора, донор
грубее в 5 из 7 известных пересечений. `marked = false` неотличимо от «не
выясняли», поэтому скрипт умеет только поднимать флаг (`false → true`, 27
донорских строк) и никогда не опускает. А `pack_size` — живое ПРАВИЛО ЗАКУПА,
которое владелец правит из бота командой «блок <товар> <N>»
(`product-rules.ts:27` → `setProductRules`): перезаписать его числами донора
значит молча изменить количество в следующем закупе.

**Чем платим, если ошиблись.** Девять чисел «Блок, шт» владелец переносит руками
(или не переносит). Обратный выбор — перезапись — стоил бы закупа не по той
кратности, и заметили бы это на складе, а не в отчёте.

## 4. Общие ограничения (действуют на все семь задач)

* TypeScript strict, без `any`.
* Русский в UI, тестах и документации; идентификаторы — английские.
  Экспортируемые имена общего слоя — латиницей.
* Время — только `packages/shared/src/tashkent-time.ts`; `now` приходит
  **параметром** в `ProductFiscalService.update` и `RecordCancelService.cancel`,
  стенных часов внутри сервисов нет.
* Настройки — только через `apps/core/src/system/config-spec.ts` (`CONFIG_SPECS`,
  поля `key/label/kind/fallback/help/validate`) с русским `help`; чтение —
  `readIntSetting` (`apps/core/src/system/settings.ts:40`); база важнее env.
* `@Throttle` — только именованные лимитеры `burst`/`sustained` (сторож
  `apps/core/src/vending/vending.controller.test.ts:15`); `default` не читается.
  В этом срезе новых лимитеров нет: единственный новый GET
  (`/vending/my-records`) отдаёт 15 строк по индексу и укладывается в общий
  потолок, а второе число, которое надо держать в синхроне, здесь не нужно.
* Мутации — под глобальным `ServiceTokenGuard` (`app.module.ts:83`); чтения
  открыты внутри сети (изменение этого — П8 пп. 3–5, не здесь).
* Ноль ≠ «всё хорошо»: пустая выборка рендерится третьим состоянием, а не
  зелёной галкой. «Нет ИКПУ» и «ИКПУ из 16 цифр» показываются раздельно.
* Деньги — «N сум», проценты — «N %» (с пробелом), минус — U+2212. Числа
  снек-листов — без U+00A0 (`count()`/`amount()`, `apps/cc/src/lib/format.ts`).
* Документация (`docs/DATA_SOURCES.md`, `docs/DEPLOY.md`) правится ВНУТРИ той
  задачи, которой она нужна, а не отдельным коммитом в конце.
* Записей в прод — **ровно две плановые** (§9): миграция 0072 автодеплоем и
  разовый `import-fiscal.js --apply` после чистой примерки.
* В доноре не удаляется и не меняется ничего: только SELECT.
* Докблок объясняет ПОЧЕМУ и обязан оставаться правдой.

## 5. Дизайн по компонентам

Порядок = порядок выполнения. Задачи 1–2 — фундамент, 3–5 стоят на них, 6 и 7
независимы друг от друга.

### Задача 1 — Миграция 0072 и схема (M, R-P6-5, R-P6-6, R-P6-10)

**`packages/db/drizzle/0072_product_fiscal_and_storno.sql`** (пишется руками, как
0066/0068/0069; `IF NOT EXISTS` везде — защитный паттерн 0067/0069/0070):

```sql
-- П6: фискальный блок карточки снека (R-P6-1/R-P6-5) и сторно снек-записей
-- (R-P6-3/R-P6-10). Идемпотентно; дефолты безопасны для 52 живых строк прайса.

-- 1. Фискальные поля прайса. CHECK'и СТРУКТУРНЫЕ (длина и цифры); набор
--    значений (12/0/15, семь кодов ОКЕИ) живёт в @mydon/shared — R-P6-6.
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "ikpu" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "mxik" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "vat_pct" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "barcode" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "package_code" text DEFAULT '796' NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "marked" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_ikpu_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_ikpu_check"
  CHECK ("ikpu" IS NULL OR "ikpu" ~ '^[0-9]{17}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_mxik_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_mxik_check"
  CHECK ("mxik" IS NULL OR "mxik" ~ '^[0-9]{17}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_barcode_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_barcode_check"
  CHECK ("barcode" IS NULL OR "barcode" ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13})$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_package_code_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_package_code_check"
  CHECK ("package_code" ~ '^[0-9]{3}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_vat_pct_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_vat_pct_check"
  CHECK ("vat_pct" >= 0 AND "vat_pct" <= 100);--> statement-breakpoint

-- 2. Сторно заправок. qty — ДЕЛЬТА, поэтому противознак; старый CHECK
--    «qty > 0» его бы отверг. Ослабляем РОВНО на источник 'storno':
--    обычная заправка на минус по-прежнему невозможна.
ALTER TABLE "vending_refill" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_refill"("id");--> statement-breakpoint
ALTER TABLE "vending_refill" DROP CONSTRAINT IF EXISTS "vending_refill_qty_positive";--> statement-breakpoint
ALTER TABLE "vending_refill" ADD CONSTRAINT "vending_refill_qty_positive"
  CHECK (("source" = 'storno' AND "qty" < 0) OR ("source" <> 'storno' AND "qty" > 0));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vending_refill_reverses_idx"
  ON "vending_refill" USING btree ("reverses_id") WHERE "reverses_id" IS NOT NULL;--> statement-breakpoint

-- 3. Сторно пересчётов. qty — СНИМОК, противознака нет, строка это метка.
--    Идемпотентность своим частичным уникальным: own_key её не покрывает
--    (он ограничен source='own').
ALTER TABLE "vending_stock_count" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_stock_count"("id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_stock_count_storno_key"
  ON "vending_stock_count" USING btree ("reverses_id") WHERE "source" = 'storno';--> statement-breakpoint

-- 4. Сторно касс закупа. Колонки source у таблицы не было вовсе.
ALTER TABLE "vending_cash_session" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_cash_session" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_cash_session"("id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_cash_session_storno_key"
  ON "vending_cash_session" USING btree ("reverses_id") WHERE "source" = 'storno';
```

**`packages/db/src/schema.ts`** — колонки и индексы заводятся в drizzle-схеме
(без них `select` их не увидит), CHECK'и — нет:

* `vendingProduct` (`:1371`) получает шесть полей с докблоками; у `packageCode`
  докблок обязан сказать «ОКЕИ, НЕ идентификатор каталога Multikassa (R-P6-7)»,
  у `vatPct` — «умолчание перенесено от донора, это не решение о карточке
  (R-P6-8)», у `marked` — «`false` значит и „не требуется“, и „не выясняли“ —
  различить нечем»;
* `vendingRefill` (`:1700`): `reversesId` + частичный индекс; **`check(...)` со
  строки `:1738` УБИРАЕТСЯ** и заменяется комментарием «CHECK живёт в SQL
  0072» — тот же приём и та же причина, что у `fixedPurchaseQty` (`:1400-1408`);
* `vendingStockCount` (`:1580`): `reversesId` + частичный уникальный;
* `vendingCashSession` (`:1827`): `source`, `reversesId` + частичный уникальный.

После правки — `pnpm --filter @mydon/db db:generate` для снапшота
(`packages/db/drizzle/meta/`), плюс сторожевой тест схемы, как у 0069/0070.

### Задача 2 — `packages/shared/src/fiscal.ts` (S, R-P6-6, R-P6-9)

Новый модуль; реэкспорт добавляется в `packages/shared/src/index.ts` рядом с
`export * from "./sources";` (`:50`). Правило длины ИКПУ НЕ дублируется — берём
`IKPU_DIGITS` из `sources.ts:187`.

```ts
/** Фискальный блок карточки снека — типизированный, в отличие от entity.attrs. */
export interface ProductFiscal {
  /** ИКПУ, 17 цифр. null — код не выясняли (это НЕ «чек не соберётся», это «не знаем»). */
  ikpu: string | null;
  /** МХИК, 17 цифр. Правило донора (`validate_fiscal`), не проверенная нами норма — R-P6-3. */
  mxik: string | null;
  /** Ставка НДС, целые проценты. 0 законен, пустого не бывает — R-P6-8. */
  vatPct: number;
  /** EAN: 8, 12 или 13 цифр. null — не выясняли. */
  barcode: string | null;
  /** Код ОКЕИ. НЕ идентификатор упаковки каталога Multikassa — R-P6-7. */
  packageCode: string;
  /** Требует маркировки (КИЗ). false = «не требуется» И «не выясняли». */
  marked: boolean;
}

/** Патч: undefined — не трогать, null — очистить (только у nullable-полей). */
export type ProductFiscalPatch = {
  [K in keyof ProductFiscal]?: ProductFiscal[K] | (null extends ProductFiscal[K] ? null : never);
};

export const FISCAL_DEFAULTS = { vatPct: 12, packageCode: "796", marked: false } as const;

/** Длины штрих-кода — множество, как у донора (`_digits_ok(barcode, {8, 12, 13})`). */
export const BARCODE_DIGITS: readonly number[] = [8, 12, 13];

export interface DictEntry { code: string; label: string }

/** Ставки НДС (словарь `vat` донора: 12 стандарт, 0 нулевая, 15 специальная). */
export const VAT_RATES: readonly DictEntry[];
/** ОКЕИ (словарь `package` донора, семь значений; 796 «Штука» — умолчание). */
export const PACKAGE_CODES: readonly DictEntry[];
/** Маркировка (словарь `marking` донора: 0 «Не требуется», 1 «Требуется (КИЗ)»). */
export const MARKING: readonly DictEntry[];

/** Что именно плохо в поле — тем же языком, что `FiscalGap` в sources.ts. */
export interface FiscalFlaw { field: keyof ProductFiscal; flaw: "нет" | "неверно"; why: string }

/** Проверка ПАТЧА перед записью: русские тексты, годятся и Core, и форме. */
export function validateFiscalPatch(patch: ProductFiscalPatch): string[];

/** Что мешает выбить чек по УЖЕ СОХРАНЁННОЙ карточке. Пусто — соберётся. */
export function fiscalFlaws(fiscal: ProductFiscal): FiscalFlaw[];

/** Чек соберётся: есть ИКПУ верной длины и код упаковки. */
export function fiscalReady(fiscal: ProductFiscal): boolean;

/** Нормализация ввода: пробелы/NBSP/узкий пробел/дефисы вырезаются, "" → null. */
export function normalizeFiscalInput(raw: string | null | undefined): string | null;

/** Категорийный ли код ПО СПРАВОЧНИКУ ДОНОРА; суффикс `000000` — сверка (R-P6-9). */
export function classifyIkpu(
  code: string,
  dict: ReadonlyMap<string, string>,
): { kind: "sku" } | { kind: "category" } | { kind: "unknown"; why: string };
```

Тексты ошибок — дословно донорские, потому что владелец их уже читает в панели
`mydon-stock` (`app/cards.py:16-24`): «ИКПУ должен быть 17 цифр или пусто»,
«МХИК должен быть 17 цифр или пусто», «Штрихкод должен быть 8/12/13 цифр или
пусто». Новые, которых у донора нет: «Код упаковки — 3 цифры ОКЕИ», «Ставка НДС
— одно из: 12, 0, 15».

`classifyIkpu` возвращает `unknown` в двух случаях: кода нет в справочнике
донора; справочник и суффикс `000000` расходятся. Оба — в отчёт, не в базу.

### Задача 3 — Core: единый писатель и чтение фискального блока (M, R-P6-5)

**`apps/core/src/vending/product-fiscal.service.ts`** (новый):

```ts
export type FiscalUpdateResult =
  | { ok: true; product: string; before: ProductFiscal; after: ProductFiscal;
      readyBefore: boolean; readyAfter: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid"; errors: string[] };

@Injectable()
export class ProductFiscalService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * ЕДИНСТВЕННЫЙ писатель фискальных полей карточки снека.
   *
   * before/after в audit_log — ВЕСЬ блок из шести полей, а не тронутые ключи:
   * запись «поменяли ИКПУ» без соседних полей не отвечает на вопрос «а чек по
   * ней собирался?» — ровно разрыв, названный в описи §4.2.
   *
   * `now` параметром: проверка `updatedAt` не должна зависеть от стенных часов.
   */
  async update(
    productId: string,
    patch: ProductFiscalPatch,
    actor: string,
    now: Date,
  ): Promise<FiscalUpdateResult>;
}
```

Поведение:

* пустой патч → `BadRequestException("нечего менять: укажи хотя бы одно поле")`
  (образец `setProductRules`, `vending.service.ts:2123`: пустой патч — почти
  наверняка потерянное поле формы, а не намерение);
* `validateFiscalPatch` → `{ ok: false, reason: "invalid", errors }`, не 500;
* запись, событие и аудит — в **одной транзакции**, как у правил закупа:

```ts
await this.db.transaction(async (tx) => {
  await tx.update(vendingProduct).set({ ...set, updatedAt: now }).where(eq(vendingProduct.id, productId));
  await tx.insert(event).values({
    source: "owner",
    type: "vending.product_fiscal_changed",
    payload: { product: row.name, before, after, readyBefore, readyAfter, actor },
  });
  await tx.insert(auditLog).values({
    actorKind: "human",
    actorRef: actor,
    action: "vending.product.set_fiscal",
    target: productId,
    before,
    after,
  });
});
```

`tx.insert(auditLog)`, а не `AuditService.record` (`audit.service.ts:25`): у
сервиса свой хендл БД, и его запись пережила бы откат транзакции — журнал
показывал бы правку, которой в карточке нет. Тот же выбор уже сделан в
`refill.service.ts:134` и `vending.service.ts:2177`.

**`apps/core/src/vending/vending.controller.ts`** — DTO и роут по образцу
`product-rules` (`:243`, `:554`):

```ts
export class SetProductFiscalDto {
  @IsUUID()
  productId!: string;

  /** "" → null (сброс). Гашение пустой строки — тот же приём, что у StockCountsDto. */
  @IsOptional() @Transform(({ value }) => (String(value ?? "").trim() === "" ? null : value))
  @IsString() @Matches(/^\d{17}$/, { message: "ИКПУ должен быть 17 цифр или пусто" })
  ikpu?: string | null;

  @IsOptional() @Transform(/* то же гашение */)
  @IsString() @Matches(/^\d{17}$/, { message: "МХИК должен быть 17 цифр или пусто" })
  mxik?: string | null;

  @IsOptional() @Transform(/* то же гашение */)
  @IsString() @Matches(/^(\d{8}|\d{12}|\d{13})$/, { message: "Штрихкод должен быть 8/12/13 цифр или пусто" })
  barcode?: string | null;

  @IsOptional() @IsInt() @IsIn(VAT_RATES.map((r) => Number(r.code)))
  vatPct?: number;

  @IsOptional() @IsString() @IsIn(PACKAGE_CODES.map((p) => p.code))
  packageCode?: string;

  @IsOptional() @IsIn([true, false])
  marked?: boolean;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

@Post("product-fiscal")
setProductFiscal(@Body() dto: SetProductFiscalDto) {
  const { productId, actor, ...patch } = dto;
  return this.productFiscal.update(productId, patch, actor ?? "panel", new Date());
}
```

Адресация по `productId`, а не по имени (в отличие от `product-price` и
`product-rules`): фискальный блок правится только из карточки панели, которая
уже держит `row.id`; резолв по алиасу добавил бы путь, где спорное имя молча
уводит 17-значный код на чужую карточку — `productIndex.explain` для этого и
возвращает `conflict` (`stock-history.ts:315`).

**Чтение.** `VendingProductRow` (`vending.service.ts:510` и зеркало
`apps/cc/src/lib/core.ts:206`) получает ОДНО новое поле `fiscal: ProductFiscal`,
где сам `ProductFiscal` импортируется из `@mydon/shared` обеими сторонами —
шесть полей описаны ровно один раз, зеркала растут на строку каждое.
`products()` (`vending.service.ts:2092`) добирает шесть колонок в `select` и
собирает из них `fiscal`. Полный перенос `VendingProductRow` в `@mydon/shared` —
вне охвата (§10).

**Событие и правило** (`apps/core/src/rules/rules.ts`, блок «Снек-автоматы»):

```ts
{
  // Только ПЕРЕСЕЧЕНИЕ границы «чек соберётся»: 52 карточки × 6 полей рутинной
  // правки залили бы брифинг, а ценность несёт ровно смена состояния.
  id: "vending.product_fiscal_changed",
  eventType: "vending.product_fiscal_changed",
  urgency: "briefing",
  when: (c) => c.payload.readyBefore !== c.payload.readyAfter,
  format: (c) =>
    c.payload.readyAfter === true
      ? `🧾 Чек соберётся: ${str(c.payload.product)} — фискальные поля заполнены`
      : `🧾 Чек больше не соберётся: ${str(c.payload.product)} — проверь фискальные поля`,
}
```

Запись в реестр обязательна: `RULE_EVENT_TYPES` (`rules.ts:601`) фильтрует
`/rules/pending`, и без неё тип туда не попадёт никогда (урок N5, `:527`).

### Задача 4 — CC: секция «Фискальные данные» в карточке снека (M, R-P6-5)

Дом — карточка товара снека, то есть лист «Правила закупа»
(`apps/cc/src/components/product-rules-panel.tsx`): владелец уже открывает там
строку кнопкой «Править», и вторая карточка того же товара на соседнем листе
была бы вторым ответом на один вопрос.

**`apps/cc/src/components/product-fiscal-form.tsx`** (новый, client):

```ts
export function ProductFiscalForm({
  domain, row, onDone,
}: { domain: string; row: VendingProductRow; onDone: (saved?: string | null) => void }): JSX.Element
```

Ровно по конвенции `CLAUDE.md:57-67` и эталону `customs-rates.tsx:17-33`:
`onSubmit` + `event.preventDefault()` + `new FormData(event.currentTarget)` →
server action в `startTransition`; при `res.ok` — сброс ошибки, `onDone(...)`,
`router.refresh()`; при отказе — `setError(res.message)` и **поля сохраняют
ввод**. Никакого `<form action={fn}>`: React 19 сбрасывает неуправляемые поля
после экшена, и одна ошибка Core стоила бы владельцу всего 17-значного набора.

Поля: `ikpu`, `mxik`, `barcode` — `<input inputMode="numeric">` с `defaultValue`
из `row.fiscal`; `vatPct`, `packageCode`, `marked` — `<select>` по `VAT_RATES`,
`PACKAGE_CODES`, `MARKING` из `@mydon/shared`. Подписи русские, у ОКЕИ —
«Код упаковки (ОКЕИ)» с подсказкой «единица измерения, не идентификатор
каталога» (R-P6-7). Клиентская проверка — тем же `validateFiscalPatch`, что и в
Core: текст ошибки в обоих местах одинаковый, потому что функция одна.

**`apps/cc/src/app/vending/actions.ts`** — рядом с `saveVendingProductRules`
(`:38`):

```ts
export async function saveVendingProductFiscal(domain: string, form: FormData): Promise<ActionResult>
```

Пустое поле nullable-типа → `null` (сброс); пустой `<select>` невозможен по
построению. При `reason === "invalid"` сообщение — первая строка `errors`, чтобы
владелец видел ПРИЧИНУ, а не «Не получилось» (тот же урок, что в
`product-rules.ts` про причину отказа вместо общей шпаргалки).

**`product-rules-panel.tsx`** — строка списка получает чип фискальной готовности
из `fiscalReady(p.fiscal)` / `fiscalFlaws(p.fiscal)`: «чек соберётся» / «дыр: N»
(та же формулировка, что на карточке реестра,
`product-card-sections.tsx:38-45`); открытая правка показывает `RuleForm` и
`ProductFiscalForm` друг под другом одним блоком «карточка товара».

Витрины реестра (`product-card-sections.tsx`, `product-card-360.tsx`,
`products-book.tsx`) НЕ трогаются — они обслуживают кофейный контур (R-P6-5).

### Задача 5 — Бот: «карточка <товар>» (S, R-P6-5)

**`apps/bot/src/product-card.ts`** (новый, рядом с `product-rules.ts`):

```ts
/** Префикс без \b — он не срабатывает после кириллицы (то же, что в isRuleCommand). */
export function isProductCardTrigger(text: string): boolean {
  return /^карточка(\s|:|$)/i.test(text.trim());
}
export function parseProductCardCommand(text: string): string | null;
export function formatProductCard(row: VendingProductRow): string;
```

Вывод — одно сообщение: имя и категория, закупочная цена, эталон витрины, блок,
правила закупа, затем блок «Фискальные данные» (ИКПУ · МХИК · НДС · штрихкод ·
упаковка ОКЕИ · маркировка) и хвост из `fiscalFlaws` по строке на дыру. Пустое
поле печатается как «—», а не пропускается: «не выясняли» — это ответ.

Роутинг — в `apps/bot/src/handler.ts` рядом с `isRuleCommand` (`:259`), но
**раньше** него: «карточка …» ни с одним существующим префиксом не пересекается,
и уходить в `parseIntent` ей незачем. Чтение — `GET /vending/products` через
существующий клиент (`apps/bot/src/core-client.ts`), поиск строки по канону
`normalizeProductName`; не нашлось — сообщение «Товар «X» не найден в прайсе
вендинга. Имя должно совпадать с карточкой или алиасом» (дословно как
`product-rules.ts:145`). Токен не нужен: это GET.

**Правка фискальных полей из бота — ВНЕ ОХВАТА, и тривиальной части здесь нет.**
17-значный код, набранный на телефоне в подвале, — ровно тот ввод, который
производит состояние «заполнено, но неверно»; у цены есть гейт ±20 %
(`setProductPrice`, `vending.service.ts:2605+`), у ИКПУ гейта нет и быть не
может — второй такой же код неотличим от опечатки. Правка остаётся в панели, где
поле видно целиком и рядом стоит проверка.

### Задача 6 — Разовый перенос `packages/db/src/import-fiscal.ts` (M, R-P6-9, R-P6-14)

Скрипт по образцу `import-stock-history.ts` и `backfill-product-ids.ts`.

**Флаги.** Белый список ДО первого запроса, ровно два: `--dry-run`, `--apply`;
совмещение — отказ. **Без флагов — ПРИМЕРКА** (в отличие от
`backfill-product-ids.ts`, который без флагов ПИШЕТ, потому что его так зовёт
`.github/workflows/ci.yml:82`). Асимметрия называется в докблоке обоих файлов,
чтобы её никто не «выровнял»: этот скрипт CI не зовёт, он ходит в прод руками.
Строка режима печатается ПЕРЕД первым запросом и обязана не врать —
`разобратьАргументы` (`backfill-product-ids.ts:369`) переиспользуется как есть.

**Подключения.** MYDON — `DATABASE_URL` (нет → код 1). Донор —
`STOCK_DATABASE_URL` + `STOCK_SCHEMA` через `sqlDonor(...)`-подобный ридер
(`import-stock-history.ts:471`); нет → **код 2** («донор не подключён — это не
поломка скрипта, а не выданное окружение, и на проде это разные разговоры»). В
отчёт печатается только `new URL(url).host`, никогда полная строка с паролем.

**Донорский ридер** — два запроса, оба SELECT:

```sql
-- товары
select p.id, p.name, p.ourvend_name, p.ikpu_code, p.barcode, p.is_marked, p.active
  from <schema>.products p order by p.id;
-- справочник ИКПУ владельца: он и решает, категорийный код или SKU (R-P6-9)
select e.code, e.name
  from <schema>.dictionary_entries e
  join <schema>.dictionaries d on d.id = e.dict_id
 where d.key = 'ikpu';
```

**Резолв имён.** `productIndex(products, aliases)`
(`packages/shared/src/stock-history.ts:353`): сперва точное ИМЯ карточки, потом
алиас, спор (`explain → conflict`) — отказ со строкой в отчёте. Нормализация —
`normalizeProductName` (`ё→е`, запятая между цифрами сворачивается в точку).
Донорское имя пробуется в двух написаниях: `products.name`, затем
`products.ourvend_name` — тот же порядок, что в П8a (R-FW-P1).

**Источники и приоритет** (R-P6-2, R-P6-14):

| поле | 1-й источник | 2-й источник | пишем, если |
|---|---|---|---|
| `ikpu` | MYDON `entity(type='product').attrs["ИКПУ"]` | донор `products.ikpu_code`, **только SKU** | `vending_product.ikpu IS NULL` |
| `barcode` | MYDON `attrs["штрихкод"]` | — (у донора 0 из 62) | `barcode IS NULL` |
| `marked` | — | донор `is_marked = true` (27 строк) | текущее `marked = false` |
| `mxik` | — | — | никогда (0 строк с обеих сторон) |
| `vat_pct` | — | — | никогда (умолчание 12 поставила миграция) |
| `package_code` | — | — | никогда (ОКЕИ 796 поставила миграция; `attrs["упаковка"]` — другая величина, R-P6-7) |
| `pack_size` | — | — | никогда; 9 пар печатаются на решение владельца |

Карточка реестра сопоставляется с карточкой прайса тем же `productIndex` по
имени; ключи `attrs` берутся дословно те, что живут в коде сегодня (`ИКПУ`,
`штрихкод`).

**Что печатает примерка** (и что владелец обязан прочитать до `--apply`):

1. строка режима и хост цели;
2. счётчики источников: сколько карточек прайса получит `ikpu` из
   `entity.attrs`, сколько — из донорского SKU-кода, сколько получит `barcode`,
   сколько — `marked`;
3. **карта `raw → канон (источник)`** — потолок печати 50, дальше «… и ещё N»
   (дословно приём `картаРешения`, `backfill-product-ids.ts:332-343`);
4. **не пишем, разбирает владелец** — отдельными разделами с причиной:
   * `категорийный код` — донорские коды, подписанные «(категория)»;
   * `нет в справочнике донора` / `справочник и суффикс расходятся`
     (`classifyIkpu → unknown`);
   * `конфликт значений` — ИКПУ есть с обеих сторон и они разные (ожидание: 7
     строк, из них 5 «донор грубее», 1 — `Lit Energy Blueberry` SKU-vs-SKU);
   * `дефект длины` — наш `2202002001010032` у `Coca-Cola ZeroS CAN 0.25`, 16
     цифр: **CHECK 0072 его и не принял бы**, поэтому скрипт отбраковывает его
     сам и печатает, а не роняет транзакцию на ровном месте;
   * `спор имени` — `productIndex.explain → conflict`;
   * `не резолвится` — донорские строки без карточки (ожидание: 22, из них 14
     слитых дублей `… [слит→N]`, 2 служебные, 6 живых напитков под другой
     формулировкой + `Moxito Mango CAN 0.45`);
   * `pack_size: донор ≠ наш` — 9 сопоставленных пар, 5 расхождений;
5. разборная строка `ИТОГИ(json): {...}` — по ней сверяется выкатка (приём
   `import-stock-history.ts:644-652`).

**Идемпотентность.** Пишем только там, где у нас пусто; повторный `--apply`
обязан дать нули по всем счётчикам. Непустое значение НЕ затирается никогда — оно
уходит в раздел «конфликт значений» (R-P6-14). `marked` умеет только подниматься
(`false → true`) и никогда не опускается.

**Границы.** Одна транзакция на всю запись; при отказе — отчёт по уже сделанному
ПЕРЕД текстом ошибки (приём `ImportWriteFailure`,
`import-stock-history.ts:697`). В доноре — только SELECT.

### Задача 7 — Сторно снек-записей и «Мои записи» (M, R-P6-3, R-P6-10…R-P6-13)

**Проводка автора (без неё экран пуст).** `apps/bot/src/core-client.ts`:
`setVendingStock(items, personId?)` (`:487`) начинает слать `personId`,
`recordVendingCash(...)` (`:501`) — `createdBy: person:<id>`. Оба поля DTO уже
имеют (`vending.controller.ts:122`, `:167`), и докблок первого прямо говорит, что
проводка бота — «отдельный срез». Это он.

**`apps/core/src/vending/record-cancel.service.ts`** (новый):

```ts
export type CancelKind = "refill" | "stock_count" | "cash";

export interface CancelActor {
  /** Карточка сотрудника. Анонимного пути нет: единственный вызывающий — бот. */
  personId: string;
  /** Строка для audit_log.actorRef: «person:<uuid>» — формат personIdOf(). */
  ref: string;
}

export type CancelResult =
  | { ok: true; kind: CancelKind; stornoId: string; label: string; alreadyCancelled: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_yours" }
  | { ok: false; reason: "too_old"; hours: number };

@Injectable()
export class RecordCancelService {
  /**
   * Отмена снек-записи СТОРНИРУЮЩЕЙ строкой (R-P6-3). Жёсткого DELETE нет ни в
   * одной ветке: удалённой записи не видно ни в ленте, ни в отчёте, и «куда
   * делись шесть Snickers» становится вопросом без ответа.
   *
   * `now` параметром — окно 24 ч обязано проверяться тестом, а не стенными часами.
   */
  async cancel(kind: CancelKind, id: string, actor: CancelActor, now: Date): Promise<CancelResult>;
}
```

Правила доступа (R-P6-12) читаются В CORE, а не приходят снаружи: сервис берёт
`person.roles` по `actor.personId` и зовёт `can(roles, "system.admin")`
(`packages/shared/src/roles.ts:100`). Без этого права автор отменяет только СВОЮ
запись и только в пределах `readIntSetting(db, "SNACK_CANCEL_WINDOW_HOURS", 24)`
часов от `created_at`.

Три ветки внутри одной транзакции:

```ts
// refill — ДЕЛЬТА: противознак + возврат на склад
const [сторно] = await tx.insert(vendingRefill).values({
  ...original,
  id: undefined,
  qty: -original.qty,
  source: "storno",
  reversesId: original.id,
  // Идемпотентность БЕСПЛАТНО: уникальный vending_refill_client_key
  // (schema.ts:1737) ловит повторное нажатие, и склад второй раз не трогается.
  clientKey: `storno:${original.id}`,
  performedAt: now,
  createdBy: actor.ref,
}).onConflictDoNothing({ target: vendingRefill.clientKey }).returning();
if (!сторно) return { ok: true, alreadyCancelled: true, /* … */ };  // склад НЕ трогаем
await tx.insert(vendingStock).values(/* … */).onConflictDoUpdate({
  target: [vendingStock.productName],
  set: { quantity: sql`${vendingStock.quantity} + ${original.qty}`, updatedAt: now },
});
```

```ts
// stock_count — СНИМОК: метка, а не противознак; отменяется ВЕСЬ ввод (R-P6-11)
const группа = await tx.select().from(vendingStockCount).where(and(
  eq(vendingStockCount.source, "own"),
  eq(vendingStockCount.countedAt, original.countedAt),
  eq(vendingStockCount.personId, original.personId),
));
// на каждую строку — своя сторно-метка (qty копируется, note = «отмена»);
// уникальный vending_stock_count_storno_key (0072) делает повтор безвредным.
// vending_stock НЕ трогаем — R-P6-10.
```

```ts
// cash — ДЕНЬГИ: противознак по трём суммам и по каждой статье
await tx.insert(vendingCashSession).values({
  receivedAmount: (-Number(original.receivedAmount)).toFixed(2),
  totalSpent: (-Number(original.totalSpent)).toFixed(2),
  remainder: (-Number(original.remainder)).toFixed(2),
  categories: original.categories.map((c) => ({
    ...c,
    subtotal: -c.subtotal,
    lines: c.lines.map((l) => ({ ...l, amount: -l.amount })),
  })),
  source: "storno",
  reversesId: original.id,
  createdBy: actor.ref,
});
```

В той же транзакции — событие и аудит:

```ts
await tx.insert(event).values({
  source: "human",
  type: "vending.record_cancelled",
  payload: { kind, recordId: id, stornoId, label, author, cancelledBy: actor.ref },
});
await tx.insert(auditLog).values({
  actorKind: "human",
  actorRef: actor.ref,
  action: `vending.${kind}.cancel`,
  target: id,
  before: original,
  after: сторно,
});
```

Правило в `apps/core/src/rules/rules.ts` (блок «Снек-автоматы»):

```ts
{
  // Отмена — событие редкое по построению (единицы в месяц), поэтому без
  // `when`: владелец обязан узнать о каждой, но не ночью.
  id: "vending.record_cancelled",
  eventType: "vending.record_cancelled",
  urgency: "briefing",
  format: (c) =>
    `↩️ Отмена записи (${str(c.payload.kind)}): ${str(c.payload.label)} — отменил ${str(c.payload.cancelledBy)}`,
}
```

**Контроллер** (`vending.controller.ts`, под глобальным `ServiceTokenGuard`):

```ts
export class CancelRecordDto {
  @IsUUID() personId!: string;
}

@Post("refills/:id/cancel")      cancelRefill(@Param("id") id: string, @Body() dto: CancelRecordDto)
@Post("stock-counts/:id/cancel") cancelStockCount(@Param("id") id: string, @Body() dto: CancelRecordDto)
@Post("cash/:id/cancel")         cancelCash(@Param("id") id: string, @Body() dto: CancelRecordDto)

/** Последние записи автора по всем трём видам — экран «Мои записи» бота. */
@Get("my-records")
myRecords(@Query() dto: MyRecordsDto)  // person: uuid (обяз.), limit: 1..15, дефолт 15
```

`MY_RECORDS_LIMIT = 15` — число донора (`bot.py:1663-1687`,
`ORDER BY created_at DESC LIMIT 15`). Пересчёты складываются в одну строку на
ввод (R-P6-11); уже отменённые записи в список НЕ попадают. Чтение
`stockCounts()` (`vending.service.ts:1658`) получает тот же фильтр: строка не
показывается, если на неё есть сторно, и сама сторно-метка не показывается.

**`apps/bot/src/my-records.ts`** (новый), по образцу `coffee-fix.ts`:

```ts
export function isMyRecordsTrigger(text: string): boolean {
  return /^мои\s+записи/i.test(text.trim());
}
export type MyRecordsCallback = { kind: "cancel"; entry: CancelKind; id: string } | { kind: "keep" };
/** Строгий разбор: данные кнопки приходят снаружи, доверять им нельзя. */
export function parseMyRecordsCallback(data: string): MyRecordsCallback | null; // ^mr:c:([rsk]):([0-9a-f-]{36})$
export async function startMyRecords(person: PersonRow, deps): Promise<StaffReply>;
export async function askCancel(cb, person, deps): Promise<StaffReply>;          // шаг 1: показать запись целиком
export async function handleMyRecordsCallback(cb, person, deps): Promise<{ answer: string; message?: string }>;
```

Две кнопки подтверждения — в РАЗНЫХ рядах (`coffee-fix.ts:52-57`: «промах пальцем
на морозе ценой в удалённую запись»). Тексты отказов человеческие и разные:
«Отменять можно только свои записи», «Записи старше N часов отменяет владелец»
(число — из настройки, не из строки), «Эта запись уже отменена». Успех для
пересчёта дополнительно несёт предупреждение из R-P6-10 про `vending_stock`.

Пункт меню — `apps/bot/src/menu.ts`, рядом с «↩️ Ошибся — исправить» (`:144`):
`{ id: "mine", label: "✏️ Мои записи", perm: "tasks.own", ready: true, match: isMyRecordsTrigger }`.
Значок «✏️» — донорский (`bot.py:28`) и в меню не занят; правило «один эмодзи на
пункт» соблюдено (докблок `menu.ts:130-138`).

**Кофейный контур не сливается.** «↩️ Ошибся — исправить» остаётся своим пунктом:
у кофе контракт — DELETE со снимком (`coffee.service.ts:706-757`), у снека —
сторно; один экран на пять таблиц с двумя разными контрактами объяснить
сотруднику нечем.

**Лента «Действия»** (`apps/core/src/registry/actions.service.ts`, R-P6-13):
выборка снек-заправок (`:120-131`) добирает `source`; союз `ActionRow.kind`
(`:39-52`) получает `"vending_refill_cancelled"`; подпись (`:262-268`) ветвится:

```ts
r.source === "storno"
  ? `↩️ Отмена заправки автомата ${r.serial}: ${r.product} ×${Math.abs(r.qty)}`
  : `🍫 Заправка автомата ${r.serial}: ${r.product} ×${r.qty}`
```

Панель и бот читают ленту готовой строкой — больше править нечего.

**Списка «Мои записи» в панели НЕТ, и он не нужен.** Владелец в панели видит
`/audit` (там `vending.*.cancel` с полным before/after) и «Действия»; экран «мои
записи» решает задачу полевого сотрудника с телефоном, у которого панели нет.
Второй экран того же на большом мониторе — вторая реализация правил доступа.

## 6. Данные и миграции

* **Миграция 0072** `0072_product_fiscal_and_storno.sql` — единственная в срезе,
  текст в §5 (задача 1). Применяется автодеплоем.
* **Затрагиваемые таблицы:** `vending_product` (+6 колонок, +5 CHECK),
  `vending_refill` (+1 колонка, +1 индекс, переопределён CHECK `qty`),
  `vending_stock_count` (+1 колонка, +1 частичный уникальный),
  `vending_cash_session` (+2 колонки, +1 частичный уникальный).
* **Новых таблиц нет.** `deletions_log` не заводим (R-P6-3): `audit_log.before`
  уже хранит строку целиком, а вид «журнал удалений» — это фильтр
  `action LIKE '%.cancel'` на существующем `/audit`. Справочных таблиц
  (`dictionaries`/`dictionary_entries`) не заводим (R-P6-4, R-P6-6).
* **Новая настройка** (`apps/core/src/system/config-spec.ts`):
  `SNACK_CANCEL_WINDOW_HOURS`, `kind: "number"`, `fallback: "24"`,
  `validate: inRange(1, 720)`, русский `help`: «Сколько часов автор может сам
  отменить свою запись (заправку, пересчёт, кассу). Владелец отменяет без
  лимита. 24 ч — правило донора mydon-stock, у нас оно новое: если мешает —
  поднимай, а не обходи». В ключ кеша отчётов не входит — на отчёты не влияет.
* **Записей в прод — две плановые:** миграция 0072 и один прогон
  `import-fiscal.js --apply` после чистой примерки (§9). Больше ничего.

## 7. События и правила

| событие | кто пишет | правило | срочность |
|---|---|---|---|
| `vending.product_fiscal_changed` | `ProductFiscalService.update` (в транзакции) | новое, `when: readyBefore !== readyAfter` | брифинг |
| `vending.record_cancelled` | `RecordCancelService.cancel` (в транзакции) | новое, без `when` | брифинг |

* Оба типа **обязаны** попасть в `RULES` (`apps/core/src/rules/rules.ts`), иначе
  `RULE_EVENT_TYPES` (`:601`) их не подберёт и `/rules/pending` не покажет
  никогда — урок N5 (`:527`).
* Существующие правила снек-контура не трогаются: `vending.shrinkage_alert`
  (`rules.ts:411`), `vending.refill_detected` (`:421`),
  `ourvend.sync_failed_streak` (`:437`) и остальные.
* События пишутся В ТОЙ ЖЕ транзакции, что и данные (образец
  `refill.service.ts:147`): событие снаружи пережило бы откат, и владелец увидел
  бы отмену, которой в журнале нет.
* Новых уведомлений «немедленно» в срезе нет: ни правка карточки, ни отмена
  записи не стоят ночного звонка.

## 8. Тесты

Стиль по пакетам: Core — `node:test` + `assert`, стабы БД в самом файле; панель
— `vitest` + Testing Library; бот — `node:test`; shared —
`packages/shared/src/*.test.ts`. Имена тестов — русские.

### Задача 1 (миграция и схема)

`packages/db/src/schema.test.ts` (дополнить либо завести сторож, как у 0069/0070):
* «в `vending_product` заведены шесть фискальных колонок, и `vat_pct` не nullable»;
* «CHECK `qty` у заправки живёт в SQL 0072, а не в drizzle-схеме» — сторож по
  исходнику `schema.ts`: строки `check("vending_refill_qty_positive"` там нет;
* «сторно-индексы частичные: `reverses_id` уникален только при `source='storno'`».

### Задача 2 (`fiscal.ts`)

`packages/shared/src/fiscal.test.ts` (новый):
* «ИКПУ из 17 цифр принят, из 16 — отвергнут текстом донора»;
* «пусто законно и для ИКПУ, и для МХИК, и для штрихкода»;
* «штрихкод: 8, 12 и 13 цифр приняты, 10 — отвергнут»;
* «пробелы, NBSP, узкий пробел и дефисы в коде разделителями не считаются»;
* «МХИК проверяется тем же правилом, что ИКПУ, — правило донора, не норма»;
* «ставка 0 законна и дырой не считается; пустого `vatPct` не бывает»;
* «`packageCode` вне словаря ОКЕИ отвергнут — 1218841 это не единица (R-P6-7)»;
* «`fiscalReady` требует ИКПУ и код упаковки; маркировка на чек не влияет»;
* «`classifyIkpu`: код, подписанный «(категория)», — категорийный»;
* «`classifyIkpu`: кода нет в справочнике донора → `unknown`, а не догадка»;
* «`classifyIkpu`: справочник говорит SKU, а суффикс `000000` — расхождение → `unknown`».

### Задача 3 (Core)

`apps/core/src/vending/product-fiscal.service.test.ts` (новый):
* «пустой патч — отказ 400, а не молчаливое „ок“»;
* «before/after в аудите — ВЕСЬ блок из шести полей, а не тронутые ключи»;
* «`action` = `vending.product.set_fiscal`, `target` = id карточки»;
* «событие и аудит уходят в ТОЙ ЖЕ транзакции, что и update»;
* «`readyBefore`/`readyAfter` считаются по блоку ДО и ПОСЛЕ правки»;
* «пустая строка в ИКПУ очищает поле, отсутствие ключа — не трогает»;
* «`now` берётся из параметра: `updatedAt` равен переданному моменту»;
* «неизвестный `productId` — `not_found`, а не 500».

`apps/core/src/vending/vending.controller.test.ts` (дополнить):
* «`SetProductFiscalDto`: 16 цифр отвергнуты сообщением донора»;
* «`vatPct` вне набора 12/0/15 отвергнут»;
* «`packageCode` вне словаря ОКЕИ отвергнут»;
* «пустая строка гасится в `null` до сервиса».

`apps/core/src/rules/rules.test.ts` (дополнить):
* «`vending.product_fiscal_changed` молчит, пока готовность не изменилась»;
* «переход „не собирался → соберётся“ даёт заметку в брифинг, и обратный тоже»;
* «оба новых типа попали в `RULE_EVENT_TYPES`».

### Задача 4 (панель)

`apps/cc/src/components/product-fiscal-form.test.tsx` (новый, по образцу
`customs-rates.test.tsx`):
* «отказ Core — введённые 17 цифр остались в поле» (конвенция `CLAUDE.md:57-67`);
* «удачное сохранение зовёт `router.refresh()` и закрывает форму»;
* «ставка НДС и упаковка — `<select>` со словарём, а не свободный ввод»;
* «сообщение об ошибке приходит русским текстом Core, а не „Не получилось“»;
* «пустое поле ИКПУ уходит как сброс, а не как строка „“».

`apps/cc/src/components/product-rules-panel.test.tsx` (дополнить):
* «строка товара показывает чип „чек соберётся“ / „дыр: N“»;
* «правка открывает обе формы — правила и фискальные данные — одним блоком».

`apps/cc/src/lib/core-types.test.ts` (дополнить):
* «`VendingProductRow` панели и Core несут ОДИН И ТОТ ЖЕ `ProductFiscal` из
  shared» — компиляторная сверка, приём П5b.

### Задача 5 (бот)

`apps/bot/src/product-card.test.ts` (новый):
* «„карточка Snickers 50gr“ разобрана, „что закупать“ — нет»;
* «карточка печатает фискальный блок и список дыр»;
* «пустое поле печатается как „—“, а не пропускается»;
* «имя не из прайса — подсказка про карточку и алиас, а не „не получилось“».

### Задача 6 (перенос)

`packages/db/src/import-fiscal.test.ts` (новый):
* «`--dry-run` не пишет ни одной строки»;
* «`--apply` и `--dry-run` вместе — отказ до первого запроса»;
* «`--dryrun` (опечатка) — отказ, а не молчаливая запись»;
* «без флагов — ПРИМЕРКА (в отличие от бэкфилла, который пишет)»;
* «нет `STOCK_DATABASE_URL` — код возврата 2, а не 1»;
* «категорийный код донора не пишется и попадает в отчёт с причиной»;
* «код, которого нет в справочнике донора, не пишется»;
* «непустое значение на нашей стороне не затирается — уходит в „конфликт“»;
* «16-значный код нашей стороны отбракован и напечатан, транзакция цела»;
* «повторный `--apply` даёт нули по всем счётчикам»;
* «`marked` только поднимается: `true → false` не пишется никогда»;
* «`pack_size`, `vat_pct` и `package_code` не пишутся ни при каких данных»;
* «`attrs["упаковка"]` (семизначная) в `package_code` не попадает (R-P6-7)»;
* «спор имени (`explain → conflict`) — отказ со строкой, а не выбор наугад»;
* «карта решения печатается только в примерке, потолок 50 строк».

### Задача 7 (сторно и «Мои записи»)

`apps/core/src/vending/record-cancel.service.test.ts` (новый):
* «сторно заправки — строка с `qty` противознаком, склад вернулся»;
* «повторная отмена заправки безвредна: `clientKey` тот же, склад не тронут»;
* «сторно пересчёта — метка, а не минус: `qty` копируется»;
* «отмена пересчёта берёт ВЕСЬ ввод по `(source, countedAt, personId)`»;
* «отмена пересчёта НЕ трогает `vending_stock`»;
* «сторно кассы — противознак по трём суммам и по каждой статье»;
* «автор в пределах окна — можно; за окном — `too_old` с числом часов»;
* «окно считается по `created_at`, а не по `performed_at`»;
* «чужая запись — `not_yours`»;
* «право `system.admin` снимает и „своё“, и лимит времени»;
* «жёсткого DELETE нет ни в одной ветке — оригинал на месте»;
* «`audit_log` получил `before` оригинала и `after` сторно»;
* «окно берётся из настройки, а не из константы»;
* «отменённая запись не возвращается ни в `my-records`, ни в `stock-counts`».

`apps/core/src/registry/actions.service.test.ts` (дополнить):
* «сторно-заправка подписана „Отмена заправки“, а не заправкой на минус»;
* «автор сторно-строки — тот, кто отменил, а не автор оригинала».

`apps/bot/src/my-records.test.ts` (новый):
* «список — не больше 15 строк, свежие сверху, по всем трём видам»;
* «пересчёт показан ОДНОЙ строкой с числом позиций, а не двадцатью»;
* «`callback_data` чужого формата отвергнут разбором»;
* «подтверждение — две кнопки в разных рядах»;
* «отказ „старше N часов“ называет число из настройки»;
* «успешная отмена пересчёта предупреждает про остаток склада»;
* «пустой список — третье состояние („записей пока нет“), а не „всё хорошо“».

`apps/bot/src/menu.test.ts` (дополнить):
* «пункт „✏️ Мои записи“ доступен любому подключённому (`tasks.own`)»;
* «пункт „↩️ Ошибся — исправить“ остался на месте — контуры не слиты».

`apps/bot/src/core-client.test.ts` (дополнить):
* «`setVendingStock` шлёт `personId`, `recordVendingCash` — `createdBy`»
  (без этого «Мои записи» пусты по построению).

### Дымовые

`tools/smoke-core.mjs` — весь файл уже за заставой `SMOKE_SCRATCH` (`:67-81`),
новых застав не нужно, ветка записи просто расширяется:
* фискальная правка: `POST /vending/product-fiscal` по фикстурной карточке →
  `GET /vending/products` показывает блок `fiscal`; повторный POST с 16 цифрами
  → 400 с русским текстом;
* сторно заправки: `POST /vending/refills` → `POST /vending/refills/:id/cancel`
  → сумма `qty` по автомату равна нулю, остаток склада вернулся; повторная
  отмена → `alreadyCancelled`;
* сторно пересчёта: `POST /vending/stock` →
  `POST /vending/stock-counts/:id/cancel` → `GET /vending/stock-counts` больше
  не показывает ни оригинал, ни метку;
* сторно кассы: `POST /vending/cash` → `POST /vending/cash/:id/cancel` →
  `GET /vending/cash` показывает обе строки, сумма журнала равна нулю;
* `GET /vending/my-records?person=<uuid>` → не больше 15 строк, отменённых нет.

`tools/smoke-import.mjs` не трогается. Отдельного смоука переноса не заводим: его
примерка безопасна по построению и гоняется руками на выкатке.

**Полный прогон перед PR:**
`pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`;
smoke на scratch-БД: `createdb → migrate.js → seed.js → seed-vending.js →
backfill-product-ids.js → smoke-import.mjs → smoke-core.mjs → smoke-panel.mjs → dropdb`.

## 9. Выкатка и чек-лист

1. Ветка `feat/p6-fiscal` от свежего `main`. Первой командой после переключения
   на `main` — создание ветки: фолбэк вида `|| git push` молча отправляет `main`
   в прод, а автодеплой ходит каждые 2 минуты.
2. PR → CI зелёный (lint, typecheck, build, test, smoke-цепочка) →
   adversarial-ревью → squash-мерж.
3. Дождаться деплоя и сверить, что выкачено ИМЕННО это: `GET /health` → `commit`
   совпадает с мержем (каталог обновляется за секунды, образ собирается минуты).
   **Плановая запись в прод №1** — миграцию 0072 применяет автодеплой; сверить,
   что 52 карточки прайса получили `vat_pct = 12` и `package_code = '796'`, а
   `ikpu` у всех `NULL`.
4. **Плановая запись в прод №2 — разовый перенос.** Сначала примерка, потом
   запись; обе через `docker exec -i` и обе с `</dev/null` в хвосте (без него
   остаток скрипта уходит в контейнер, и шаги после молча не выполняются,
   `docs/DEPLOY.md:121`):

   ```bash
   docker exec -i mydon-core node packages/db/dist/import-fiscal.js --dry-run </dev/null
   docker exec -i mydon-core node packages/db/dist/import-fiscal.js --apply   </dev/null
   ```

   Что читать в примерке ДО `--apply`:
   * строка режима говорит «ПРИМЕРКА» — если «ЗАПИСЬ», флаг набран неверно;
   * «конфликт значений» — ожидание **7 строк** (5 «донор грубее», 1
     `Lit Energy Blueberry` SKU-vs-SKU; восьмое пересечение совпало и в счёт не
     идёт);
   * «дефект длины» — ожидание **1 строка**: `Coca-Cola ZeroS CAN 0.25`,
     `2202002001010032`, 16 цифр;
   * «не резолвится» — ожидание **22 строки** (14 слитых дублей, 2 служебные,
     6 живых напитков + `Moxito Mango CAN 0.45`);
   * «категорийный код» — ожидание порядка **24 донорских строк** (10 разных
     кодов, подписанных «(категория)»);
   * `marked` — ожидание до **27** карточек;
   * `ikpu` — число из отчёта. Нижняя граница, которую можно назвать заранее:
     **не меньше 11** карточек, о которых реестр не знает вовсе и у которых
     донор несёт SKU-код. Верхняя граница донорского вклада — 20 SKU-строк;
     сколько из них резолвится, показывает примерка (опись этого числа не
     содержит — см. §11).
   * «`pack_size`: донор ≠ наш» — ожидание **9 пар, 5 расхождений**; скрипт их
     НЕ пишет.

   Расхождение с ожидаемым значит, что донор изменился после сверки 26.08, —
   решать это данными, а не флагом. Повторный `--apply` обязан дать нули по всем
   счётчикам: это и есть доказательство идемпотентности.
5. Проверка витрин:
   * `GET /vending/products` — у карточек есть блок `fiscal`;
   * панель «VendHub → Правила закупа» — чип «чек соберётся»/«дыр: N», правка
     фискального блока сохраняется, ошибка Core не стирает ввод;
   * бот: «карточка Snickers 50gr» → карточка с фискальным блоком;
   * бот: «мои записи» → список; отмена заправки → в «Действиях»
     (`/team/actions`) строка «↩️ Отмена заправки…», в `/audit` —
     `vending.refill.cancel` с before/after;
   * `/audit` с фильтром `action` = `vending.product.set_fiscal` — правки видны.
6. Действия ВЛАДЕЛЬЦА (кодом не делаются):
   * **6 алиасов напитков** — завести в `vending_alias`, чтобы донорские строки
     нашли карточку: `Flash Bubble Gum CAN 0.45` → `Flash Up Bubble Gum CAN 0,45`;
     `Flash CAN 0.45` → `Flash Up Energy CAN 0,45`;
     `Flash Mojito CAN 0.45` → `Flash Up Mojito Straw CAN 0,45`;
     `Laimon Berries CAN 0.33` → `Laimon Fresh Berries CAN 0,33`;
     `Laimon Mango CAN 0.33` → `Laimon Fresh Mango CAN 0,33`;
     `Lit Energy Mango CAN 0.45` → `Lit Energy Mango Coco CAN 0,45`.
     После них перенос можно прогнать повторно — он идемпотентен.
   * **`Moxito Mango CAN 0.45` ↔ `Moxito Fresh Mango CAN 0,5`** — объём не
     сходится (0,45 против 0,5). Это один товар или два? Кодом не решается.
   * **`Lit Energy Blueberry CAN 0,45`** — наш `02202003001086002` против
     донорского `02202003001086003`: оба SKU-уровня, верен один.
   * **`Coca-Cola ZeroS CAN 0.25`** — наш код `2202002001010032` короче на цифру;
     вернуть ведущий ноль (или взять код заново из Multikassa).
   * **9 значений «Блок, шт»** — сверить с нашим `pack_size` (5 расходятся) и
     поправить командой бота «блок <товар> <N>», если наши числа устарели.
   * **Роль `owner`** — если она до сих пор не проставлена ни у кого
     (`person.roles`; предупреждение плана, `docs/PLAN_STOCK_ABSORPTION.md:330-337`),
     отмена «без лимита» не сработает ни у кого, включая владельца.
7. Отложенная проверка: в первый же брифинг после правок посмотреть, что
   `vending.product_fiscal_changed` и `vending.record_cancelled` доходят
   заметками, а не копятся немыми строками в журнале событий.
8. Память и план: `docs/PLAN_STOCK_ABSORPTION.md` §П6 — отметить закрытыми
   фискальный блок, журналы и «Мои записи»; EAV-конструктор и гранулярные права
   закрыть решением R-P6-4 (потребности нет), а не оставлять открытыми.

## 10. Вне охвата

| Пункт | Почему |
|---|---|
| EAV-конструктор полей (`attribute_defs`/`attribute_values`) | R-P6-4 и опись §1.7: весь живой EAV донора — одно поле «Блок, шт» с 10 значениями, и его штатный аналог `vending_product.pack_size` уже работает |
| Гранулярные права и подписки на отчёты | R-P6-4: у донора один пользователь и все флаги TRUE; наш `roles.ts` (6 ролей, 12 прав, одна матрица на бот и Core) богаче |
| `name_uz` | R-P6-4: 0 из 62 у донора, 0 в MYDON, источника нет вообще — заводить заведомо пустое поле |
| Второй справочный механизм (`dictionaries`/`dictionary_entries`) | R-P6-4 и R-P6-6: решение 2026-08-22 уже свернуло пять фискальных справочников в один лист («62 записи, 0 правок за 25 дней») |
| `deletions_log` отдельной таблицей | R-P6-3: `audit_log.before` хранит строку целиком, витрина `/audit` их показывает; «журнал удалений» — фильтр `action LIKE '%.cancel'` |
| Approval-гейт на отмену денежных записей | R-P6-3: владелец — единственный пользователь, T3 добавил бы шаг между ним и его же ошибкой |
| Перенос категорийных ИКПУ (24 строки) | R-P6-2: ложное «заполнено» — состояние, названное самым опасным в `docs/DATA_SOURCES.md:234` |
| Данные МХИК | R-P6-3: их ноль с обеих сторон; колонка заводится, наполнять нечем |
| Перенос `pack_size` из EAV донора | R-P6-14: живое правило закупа владельца; 9 пар печатаются отчётом, решает он |
| Каталожный идентификатор упаковки Multikassa (`1218841`…) | R-P6-7: другая величина, чем ОКЕИ; потребителя нет, остаётся в `entity.attrs` |
| Правка фискальных полей из бота | Задача 5: 17-значный код без гейта — прямой путь к «заполнено, но неверно» |
| Отмена приёмки накладной (`POST /vending/orders/receive`) | пишет в четыре места сразу — статус накладной, `purchase`, `vending_stock`, наблюдения цен (`vending.service.ts:2470-2600`); её обратная операция это «раз-приёмка», а не сторно-строка, и это отдельная задача |
| Отмена строк таблицы `purchase` | П8a заморозил её как зеркало донора 1:1 по `(source, ext_id)`; отмена строки зеркала рассинхронизировала бы сверку |
| Пересчёты и кассы в ленте «Действия» | R-P6-13: лента читает доменные таблицы, её контракт — полевые действия сотрудников; два новых запроса в утренний `Promise.all` ради единиц событий в месяц не окупаются |
| Список «Мои записи» в панели | Задача 7: это задача полевого сотрудника с телефоном; в панели её решают `/audit` и «Действия» |
| Слияние «Мои записи» и кофейного «Ошибся — исправить» | разные контракты (сторно против DELETE) и разные таблицы; один экран на оба объяснить сотруднику нечем |
| Перенос `VendingProductRow` целиком в `@mydon/shared` | приём П5b/«Хвостов», применённый к другому типу; здесь достаточно того, что общими стали шесть фискальных полей (`ProductFiscal`), а зеркала выросли на строку каждое |
| Read-token для денежных GET | П8 пп. 3–5 вместе с гашением `STOCK_DATABASE_URL` — принято риском ранее |

## 11. Открытые вопросы

Нет. Все семь задач закрываются кодом и опираются на факты, проверенные в
рабочем дереве (`feat/p6-fiscal` = `origin/main` b3b595d) и в описи.

Решения, которые ждут ВЛАДЕЛЬЦА (6 алиасов, `Moxito Mango`, конфликт
`Lit Energy Blueberry`, дефект `Coca-Cola ZeroS`, 9 значений «Блок, шт»),
открытыми вопросами среза не являются: код для них готов, они перечислены шагом
6 выкатки, и ни один из них не блокирует мерж.

Одно число не выводится из описи и берётся ИЗ ОТЧЁТА примерки, а не назначается
заранее: **сколько именно карточек получит ИКПУ из донора**. Опись даёт границы
(20 SKU-строк у донора; 37 донорских строк с ИКПУ резолвятся в 37 карточек; 11
SKU-кодов закрывают карточки, о которых реестр не знает), но пересечение
«SKU ∧ резолвится» она не измеряла. Скрипт обязан его напечатать: выдумывать это
число в спецификации было бы ровно тем, что срез запрещает делать с данными.

## 12. Задачи

| # | Задача | Размер | Рулинги |
|---|---|---|---|
| 1 | Миграция 0072 и схема: шесть фискальных колонок, `reverses_id`/`source`, переопределённый CHECK `qty`, частичные уникальные | M | R-P6-5, R-P6-6, R-P6-10 |
| 2 | `packages/shared/src/fiscal.ts`: контракт `ProductFiscal`, словари, валидаторы, русские тексты, `classifyIkpu` | S | R-P6-6, R-P6-9 |
| 3 | Core: `ProductFiscalService` + `POST /vending/product-fiscal` + блок `fiscal` в ответе каталога + событие и правило | M | R-P6-5 |
| 4 | CC: секция «Фискальные данные» в карточке снека по конвенции мутирующих форм + чип готовности | M | R-P6-5 |
| 5 | Бот: «карточка <товар>» с фискальным блоком (правка — вне охвата) | S | R-P6-5 |
| 6 | `packages/db/src/import-fiscal.ts`: разовый идемпотентный перенос `--dry-run`/`--apply` | M | R-P6-9, R-P6-14 |
| 7 | Сторно снек-записей (`refill`/`stock_count`/`cash`) + «Мои записи» в боте + проводка автора + подпись в ленте «Действия» | M | R-P6-3, R-P6-10…R-P6-13 |

Ориентир: S ≈ полдня, M ≈ 1–1,5 дня. Итого ~7–9 дней.
