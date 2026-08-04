# Перенос PROMACH → MYDON/GLOBERENT — карта и статус

**Донор:** PROMACH (`github.com/jamsmac/promach`) — ERP дилера спецтехники
(~90 000 строк, 473 эндпоинта, 125 миграций). GLOBERENT — тот же бизнес
(импорт HELI из Китая → таможня → склад → продажа), поэтому переносится
ВСЯ система (решение владельца 2026-08-04), модуль за модулем.

**Метод:** разведка (10 параллельных спецификаций по коду донора + сверка
полноты) → перенос модели и математики в стек MYDON (NestJS/Drizzle/Next),
формулы и статусные машины — дословно, каждая — под golden-тестами.
Решения сверки: один тип `contractor` с ролями (у донора 3 таблицы),
одно имя `equipment_model` (у донора 4), единый словарь категорий денег,
связи только по FK — никогда по строке имени, валюты не складываются.

## Статус модулей

| Модуль донора | Статус | Где в MYDON |
|---|---|---|
| Финансы (warehouse_payments, график, курсы, агинг) | ✅ перенесён | money_flow + fx_rate, apps/core/src/finance, вкладка «Финансы» (docs/FINANCE_GLOBERENT.md) |
| Клиенты (clients, contacts, ИНН-unique) | ✅ ядро | entity contractor + роли, ux_entity_contractor_inn, 409 duplicate_inn, форма в CC |
| Справочники растаможки (tnved_codes, brv) | ✅ перенесён | tnved_rate + brv_value, apps/core/src/catalog, вкладка «Справочники → Растаможка» |
| Каталог моделей (vehicle_catalog) | ✅ каркас | entity equipment_model, вкладка «Каталог → Модели»; дерево групп/анкета — позже |
| UZS-договоры (contracts, payments, acts) | ✅ перенесён | таблицы contract/contract_act, money_flow.contract_id, apps/core/src/contracts, вкладка «Документы → Договоры» + /contracts/[id]; спецификация: scratchpad SPEC_UZS_CONTRACTS.md |
| Калькулятор v3 (calculator-engine, excel ground-truth) | ✅ перенесён | packages/shared/src/globerent/calc.ts (43 golden-теста, паритет с Excel до копейки), вкладка «Калькулятор» |
| Склад техники (warehouse, 17 статусов, VIN, резервы, стадии продажи) | ✅ перенесён | globerent_unit + unit_reserve, shared/globerent/unit-status (матрица под тестами), apps/core/src/units, вкладка «Склад» |
| Импортные контракты (график оплат, материализация, массовые ГТД, monotonic lifecycle) | ✅ перенесён | gr_import_contract, apps/core/src/imports, shared/import-lifecycle (баг донора с рангом paying исправлен + тест), вкладка «Импорт» + /imports/[id]. Контур односторонний: менеджер отмечает за завод |
| DOCX-генерация договора | ✅ перенесён | contract-docx.ts (builder донора 1:1, 13 разделов; SELLER-хардкод → карточка own_company, «TAS MOTORS» и НДС — параметры), GET /contracts/:id/docx + кнопка в карточке. 16 тестов |
| Предзаказы (preorders, 8 статусов ALLOWED_TRANSITIONS) | ✅ перенесён | gr_preorder + shared/preorder-status (матрица дословно, скипы донора живы), секция «Предзаказы» на вкладке «Импорт». order требует контракт, отмена — причину |
| КП (kp-templates classic) | ✅ рендерер | apps/core/src/kp/kp-classic.ts (хардкоды → параметры, 14 тестов). UI-обвязка (кнопка из калькулятора) и шаблон modern — следующий шаг |
| КП-шаблоны (kp-templates DOCX) | ⏳ после договоров | серверная генерация |
| Себестоимость единицы (recalc по платежам) | ✅ перенесён | money_flow.unit_id + cogsBreakdown (4 корзины донора, суммы в сум. эквиваленте, «неприведённые» — счётчиком), GET /units/:id/cost, себестоимость и маржа в списке склада; при закрытии сделки — автокомиссия выбранным методом (planned money_flow + событие unit.sale_closed с причиной, если посчитать нечем) |
| Комиссии менеджеров | ✅ все три метода | shared/globerent/commission.ts: margin_rate (Math.round(margin×rate)/100 по месяцу выдачи), tiers (полуоткрытые [from,to), персональный бьёт общий, seed 0.5–3.5%), flat_bonus (% от ФАКТ-прибыли). Действующий метод — тумблер «Системы» GR_COMMISSION_METHOD (+ ставка GR_COMMISSION_RATE_PCT); дефолт flat_bonus — самое свежее решение владельца донору (2026-05-17). Начисление в money_flow подключается вместе с COGS единицы |
| Монитор инвариантов pipeline | ⏳ со складом | как агент MYDON |
| Рекламации (claims) | ⏸ отложен | половина ценности — чат с заводом через портал; пока task+document |
| Supplier Portal (4.2К строк) | ⏸ отложен | HELI в систему не логинится; контур делаем односторонним |
| HR-пакет, СКУД | ⏸ отложен | MYDON владелец-центричен, person уже есть; ставка комиссии — attrs |
| dashboard.ts, notifications-polling, telegram.ts клиентский, auth/, ved legacy | ✖ не переносится | закрыто оболочкой MYDON (CC, бот, RBAC, audit_log); notifications разобрать на правила для бота |

## Исправленные при переносе баги донора

1. `SUM(amount)` поверх разных валют (дашборд, оплаченность договора,
   lifecycle closed) → суммы по валютам, сведение только в сум по курсу записи.
2. Статусы договора без guard'ов (`cancelled → closed` проходил) → явная
   матрица переходов + тесты.
3. Автономер договора считал фронт (`max+1` — гонка) → сервер в транзакции.
4. Параметры оплаты/пени/рассрочки жили в state формы → `contract.doc_params`.
5. Hard DELETE договора с CASCADE платежей → статус `cancelled`, деньги
   не теряют основание.
6. Комиссия агента записывалась и нигде не жила → planned-обязательство
   в финконтуре.
7. Деньги без тестов (3 тест-файла на 473 эндпоинта) → вся математика
   в чистых функциях под golden-тестами (contract-calc 9, calc 43, finance 25,
   статусные машины 15).

## Развёртывание

Каждый этап — аддитивные миграции drizzle (`pnpm --filter @mydon/db db:migrate`).
Данные из донора НЕ переливаются автоматически (решение владельца 2026-07-28:
старую базу не грузим) — карточки заводятся через сбор страниц и руками.
