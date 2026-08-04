# Финансовый контур GLOBERENT — перенос из PROMACH

**Донор:** PROMACH (Dealer Management System владельца, `github.com/jamsmac/promach`) —
ERP импорта и продаж спецтехники. Перенесены **модель данных и денежная
математика**, не стек: Fastify/сырой SQL донора в MYDON не приезжают
(решение из `PROMACH_анализ_и_интеграция_globerent_finans.md`, Часть B).

## Что перенесено и откуда

| Из PROMACH | Куда в MYDON |
|---|---|
| Модель платежа `warehouse_payments` (direction, category, method, is_official, currency+rate+amount_uzs, дата, контрагент, doc_no) | Колонки `money_flow` (`packages/db`, миграция 0034) |
| График платежей со сроками (`prepayment_due_date`/`balance_due_date` + флаги) | `money_flow.due_date` + `paid_at`, статусы planned → actual |
| Курс на дату операции (миграция 083 донора: исторические суммы не «плавают») | `money_flow.rate`/`amount_uzs` фиксируются при записи |
| Сервис курсов `exchange-rates.ts` (кеш → фолбэк → ручной override) | Таблица `fx_rate` с историей; ручной ввод — основной путь, источник ЦБ РУз можно добавить позже |
| «К сроку ≤ 7 дней» (`notifications.ts`) | `dueSoon()` в `apps/core/src/finance/finance.math.ts` |
| Агинг просрочки | Корзины 0–30 / 31–60 / 61–90 / 90+ / без срока (`aging()`) |
| Термометр концентрации (правило OLMA ≥60% из mydon-agent-os) | `concentration()`, порог `CONCENTRATION_ALARM = 0.6` |
| by_category / by_month из finance dashboard | `byMonth()` + категории записи |

## Что исправлено при переносе (критические отличия от донора)

1. **Валюты не складываются.** Донор делал `SUM(amount)` поверх USD и UZS.
   Здесь каждая корзина — суммы ПО ВАЛЮТАМ; сводить разрешено только в сум
   и только по курсу записи. Запись без курса не выдумывается — считается
   отдельно («неприведённая») и показывается счётчиком.
2. **Деньги под тестами.** У донора ~473 эндпоинта и 3 тест-файла. Вся
   математика здесь — чистые функции + golden-тесты
   (`finance.math.test.ts`), валидация ввода — тоже (`finance.service.test.ts`).
3. **Отмена не теряет след.** `status='cancelled'` остаётся строкой и
   исключён из сводов реестра и брифинга (иначе отменённая запись считалась
   бы просрочкой).

## Границы

- Ввод денег — **только через панель** (вкладка «Финансы» `/domain/globerent`),
  мутации Core закрыты `SERVICE_TOKEN`. Это money-домен: агенты сюда не пишут.
- MYDON — наблюдающий слой (свод, тревоги, ввод фактов), не транзакционная ERP.
  Полный платёжный workflow PROMACH (подтверждение заводом и т.п.) не переносится,
  пока GLOBERENT не перерастёт текущий контур.

## API Core

- `GET /finance/summary/:domain` — агинг (дебиторка/кредиторка), к сроку ≤7,
  концентрация, кэш-флоу 12 мес, курсы.
- `GET /finance/flows/:domain?status=&direction=&limit=` — лента записей.
- `POST /finance/flows` — завести обязательство (planned) или платёж (actual).
- `PATCH /finance/flows/:id/pay` · `PATCH /finance/flows/:id/cancel`.
- `GET /finance/fx` · `PUT /finance/fx` — курсы валют к суму (история хранится).
- `GET /finance/counterparties/:domain` — кандидаты привязки (контрагенты реестра).
