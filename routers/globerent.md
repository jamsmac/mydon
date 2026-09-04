# Роутер · GLOBERENT — дистрибуция погрузчиков HELI

> Роутер = список, куда смотреть. Не пересказывает содержимое файлов. Обновляется, когда
> появляется новый агент, экран, документ или источник данных направления.

**Домен в коде:** `globerent` (`packages/shared/src/index.ts` → `DOMAINS`, `DOMAIN_LABELS`).
**Бизнес:** импорт HELI из Китая → таможня → склад → продажа/аренда; сервис после продажи.
**Донор:** PROMACH — ERP дилера спецтехники, переносится модуль за модулем → `docs/PROMACH_TRANSFER.md`.

## Агенты (`apps/agents/agents/<name>/`)

| Агент | Статус | Тир | Навыки | Cron (Tashkent) | Исполнение |
|---|---|---|---|---|---|
| `globerent-ceo` | paused | T1 | business-brief | 18:00 ежедневно | паспорт без кода |
| `globerent-sales` | paused | T1 | hunt-leads · qualify-lead · draft-quote | будни 09:00 | паспорт без кода; денежная математика КП — `apps/agents/src/quote.ts` (считает код, не модель) |
| `globerent-service` | paused | T1 | triage-service · draft-service-reply · service-dispatch | будни 09:30 | паспорт без кода |
| `market-analyst` | paused | T1 | scan-tenders · scan-fx · scan-prices · scan-uz-market · scan-global · scan-strategy · deep-research · read-sources | ежедн./еженед./ежемес./квартал/год | только `read-sources` исполняется (`web-read.ts`) |
| `mydon-finance` | active | T1 | watch-receivables · draft-reminder | Пн 09:00 | `watch-receivables` исполняется; приоритет — концентрация дебиторки OLMA |

Мониторы вне навыков: `apps/agents/src/globerent-monitor.ts`.

## Экраны CC (`apps/cc/src/app/`)

- Рабочее место `/domain/globerent` — вкладки (`lib/domain-nav.ts`, `GLOBERENT_GROUPS`):
  **Каталог** (Модели · Техника · Контрагенты · Объекты) · **Документы** (Договоры · Счета) ·
  **Справочники** (Растаможка · Таможенные посты · Моя компания).
- Сквозные экраны с данными GLOBERENT: `/contracts`, `/contracts/[id]`, `/kp` (генератор КП → docx,
  `/kp/download`), `/preorders`, `/units`, `/finance`, `/registry`, `/card/[id]` (карточка 360).
- Компоненты: `components/globerent-books.tsx`, `contract-forms.tsx`, `customs-rates.tsx` (эталон
  формы), `finance-forms.tsx`, `finance-panel.tsx`, `contractor-card-360.tsx`, `payments-view.tsx`.

## Данные и источники

- Core-модули: `apps/core/src/{contracts, kp, preorders, units, finance, registry, registry-import, catalog, people}`.
- Таблицы (`packages/db/src/schema.ts`): `gr_contract`, `contract_act`, `gr_import_contract`,
  `globerent_unit`, `gr_preorder`, `unit_reserve`, `tnved_rate`, `brv_value`, `fx_rate`, `money_flow`, `document`.
- Импорт и обслуживание реестра: `tools/import-globerent-registry.mjs`, `tools/relink-globerent-contracts.mjs`,
  `tools/unlink-foreign-contracts.mjs`; сырьё — `data/globerent/`.
- Коннекторы: `packages/connectors/src/didox.ts` (электронные счета-фактуры, `tools/fetch-didox.mjs`);
  курсы ЦБ (cbu.uz → `fx_rate`, навык `scan-fx`). Планировалось: Multikassa, Zadarma (звонки → `call-analyst`).
- Финансовая модель: `docs/FINANCE_GLOBERENT.md`.

## Референсы (читать по задаче)

- `docs/PROMACH_TRANSFER.md` — карта переноса ERP донора, статус по модулям.
- `docs/FINANCE_GLOBERENT.md` — финсвод, дебиторка, правила.
- `docs/DATA_SOURCES.md` — источники данных (раздел GLOBERENT).
- `docs/REGISTRY_CLEANUP.md`, `docs/LEGACY_DATA.md` — чистка и наследие реестра.
- Коммиты аудита 01–02.09: правдивые данные реестра/техники/договоров (#250), финсвод.
- Навыки-паспорта: `apps/agents/agents/{globerent-sales,globerent-service,market-analyst,mydon-finance,globerent-ceo}/skills/*.md`.

## Открытые вопросы

- 4 из 5 агентов направления на паузе и без кода — оживление через `executor: llm` (план ARMS, волна S).
- Zadarma/звонки → `call-analyst` (`analyze-call`) — коннектора в репо нет.
