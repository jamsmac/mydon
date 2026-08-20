# Перестройка рабочего места VendHub — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Навигация направления 10 → 8 вкладок по финальной структуре владельца, дашборд как экран показателей предприятия с картой внизу, объединённая вкладка «Обслуживание».

**Architecture:** Три последовательных PR (навигация → дашборд → Обслуживание). Данные и миграции не трогаются; расчётная логика выносится чистыми функциями в `packages/shared` под node:test; страница `apps/cc/src/app/domain/[domain]/page.tsx` остаётся оркестратором, панели переиспользуются.

**Tech Stack:** Next.js App Router (apps/cc), NestJS+Drizzle (apps/core), node:test в packages/shared и apps/bot.

**Spec:** `docs/superpowers/specs/2026-08-20-vendhub-workspace-redesign-design.md`

## Global Constraints

- TypeScript strict, без `any`; UI по-русски, код по-английски (комментарии по-русски — стиль репо).
- Часовой пояс Asia/Tashkent во всех датных расчётах; голая дата = сутки по Ташкенту.
- Мёрж в main = автодеплой на прод; каждый PR перед мёржем: `pnpm -s build` (11/11), `pnpm -s test` (21/21), скриншот локалки против прод-ядра (туннель `http://127.0.0.1:3001`, токен из `apps/cc/.env.local`).
- Тесты бота гоняются по `dist`: перед `pnpm --filter bot test` обязателен `pnpm --filter bot build` (см. память проекта).
- Внутренние ключи вкладок не переименовываются — только подписи и место; старые адреса редиректят.
- Финальный порядок вкладок (слово владельца, дословно): Дашборд · Обслуживание · Задачи · Отчёты · SMM · CRM · HR · Настройки.
- Ветка `feat/workspace-redesign` уже существует (на ней спека); PR1 делается на ней, PR2/PR3 — ветками от свежего main.

---

## PR 1 — Навигация

### Task 1: Конфиг групп — Настройки поглощают Каталог и Справочники

**Files:**
- Modify: `apps/cc/src/lib/domain-nav.ts` (VENDHUB_GROUPS, ~строки 25–65)
- Test: `packages/shared/` не трогается; проверка — tsc + рендер

**Interfaces:**
- Produces: группа `{ key: "settings", label: "Настройки", leaves: [...] }`, в листьях ПЕРВЫМ `{ label: "Профиль", type: "own_company" }`, затем все листья бывшего «Каталога» + НОВЫЙ лист `{ label: "Автоматы", type: "machine" }` + все листья бывших «Справочников». Группы `catalog` и `reference` из VENDHUB_GROUPS удаляются. Группа `reports` остаётся как есть.

- [ ] **Step 1: Правка VENDHUB_GROUPS**

В `apps/cc/src/lib/domain-nav.ts` заменить три группы VendHub (catalog, reference, reports) на две (settings, reports):

```ts
export const VENDHUB_GROUPS: NavGroup[] = [
  {
    key: "settings",
    label: "Настройки",
    // Финальная структура владельца (20.08.2026): всё реестровое хозяйство —
    // внутри Настроек. Профиль направления первым; реестр аппаратов — здесь же
    // (оперативный взгляд на парк остаётся на дашборде и в Обслуживании).
    leaves: [
      { label: "Профиль", type: "own_company" },
      { label: "Товары", type: "product" },
      { label: "Компоненты", type: "component" },
      { label: "Ингредиенты", type: "ingredient" },
      { label: "Контрагенты", type: "contractor" },
      { label: "Автоматы", type: "machine" },
      { label: "Рецепты", type: "recipe" },
      { label: "Расходники (тара)", type: "consumable" },
      { label: "Склады", type: "warehouse" },
      { label: "Приход", type: "purchase" },
      { label: "Остатки в автоматах", type: "machine_stock" },
      { label: "Классификатор", type: "classifier" },
      { label: "НДС", type: "vat" },
      { label: "ИКПУ", type: "ikpu" },
      { label: "Упаковка", type: "package" },
      { label: "Штрих-коды", type: "barcode" },
    ],
  },
  {
    key: "reports",
    label: "Отчёты",
    leaves: [
      { label: "По источникам", type: "sources" },
      { label: "Журнал продаж", type: "sale" },
      { label: "Расход сырья", type: "consumption" },
      { label: "Инкассация", type: "collection" },
      { label: "Сроки годности", type: null },
      { label: "Себестоимость", type: null },
    ],
  },
];
```

Комментарий над блоком: почему справочники не отдельная вкладка (вкладка = деятельность; реестры — настройки направления).

- [ ] **Step 2: tsc**

Run: `pnpm -s --filter cc exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/cc/src/lib/domain-nav.ts
git commit -m "feat(cc): Настройки поглощают Каталог и Справочники; лист «Автоматы» в реестрах"
```

### Task 2: topTabs — восьмёрка владельца + редиректы старых адресов

**Files:**
- Modify: `apps/cc/src/app/domain/[domain]/page.tsx` (topTabs ~291–315; блоки activeGroup 466–468, 966, 1209)

**Interfaces:**
- Consumes: группы из Task 1 (settings, reports через `groups.map`).
- Produces: activeGroup-ключи `service` (новый, PR1 — временная сборка старых панелей), `smm`, `crm`, `hr`, редирект-карта `TAB_REDIRECTS`.

- [ ] **Step 1: Редиректы до рендера**

В начале компонента страницы (после вычисления `activeGroup`, до первого использования) добавить:

```ts
// Старые адреса вкладок живут в закладках и в сообщениях бота — они обязаны
// приводить в новые места, а не в пустую вкладку.
const TAB_REDIRECTS: Record<string, string> = {
  vending: "settings:machine",
  supply: "service",
  coffee: "service",
  collect: "service",
  team: "hr",
  catalog: "settings",
  reference: "settings",
};
const redirectTo = TAB_REDIRECTS[activeGroup];
if (redirectTo && domain === "vendhub") {
  redirect(`/domain/${domain}?tab=${redirectTo}`);
}
```

`redirect` импортировать из `next/navigation`. ВАЖНО: редирект `catalog`/`reference` — только по ключу группы; адрес вида `catalog:product` приходит как `tab=catalog:product` — разобрать активный ключ так, как это уже делает страница (grep `activeGroup =` и `activeLeaf`), и редиректить с сохранением листа: `settings:${activeLeaf}` когда лист есть.

- [ ] **Step 2: Новый состав topTabs**

Заменить блок vendhub-вкладок в topTabs:

```ts
...(domain === "vendhub"
  ? [
      { key: "service", label: "Обслуживание" },
      { key: "tasks", label: "Задачи" },
    ]
  : []),
...groups.map((g) => ({ key: g.key, label: g.label })), // reports затем settings? см. ниже
...(domain === "vendhub"
  ? [
      { key: "smm", label: "SMM" },
      { key: "crm", label: "CRM" },
      { key: "hr", label: "HR" },
    ]
  : []),
```

Точный порядок собрать вручную массивом, НЕ полагаясь на groups-порядок: `Дашборд(overview) · Обслуживание(service) · Задачи(tasks) · Отчёты(reports) · SMM · CRM · HR · Настройки(settings)`. Существующая вкладка задач — найти её ключ в topTabs (в хвосте, `tasks`) и НЕ дублировать: переставить. Вкладки `vending/supply/coffee/collect/team` из массива убрать.

- [ ] **Step 3: Рендер новых activeGroup**

- `service` (временно, до PR3): рендерить последовательно три существующие панели с якорями-заголовками:

```tsx
{activeGroup === "service" && (
  <>
    <div className="sect"><div className="sect-h"><h3 className="h2">Кофе-бункеры</h3></div>
      <CoffeePanel defaultOwnerRef={defaultOwner?.id ?? null} /></div>
    <div className="sect"><div className="sect-h"><h3 className="h2">Пополнение снека</h3></div>
      <VendingSupplyPanel /></div>
    <div className="sect"><div className="sect-h"><h3 className="h2">Инкассация</h3></div>
      <CollectionsView /></div>
  </>
)}
```

- `hr`: перенести существующий рендер `activeGroup === "team"` (строка ~1209, блок «Команда направления») под `activeGroup === "hr"`, добавив над ним абзац: HR — люди и оценка работы; оценка объёмов — следующим этапом.
- `smm`, `crm` — честные пустые состояния по образцу `.empty` из этого же файла:

```tsx
{activeGroup === "smm" && (
  <div className="empty"><b>SMM — продвижение</b>
    Вебсайт, Instagram, TikTok и другие каналы направления. Деятельность объявлена
    в структуре; подключение — отдельным этапом со своей спекой.</div>
)}
{activeGroup === "crm" && (
  <div className="empty"><b>CRM — звонки и обращения</b>
    Приём обращений, анализ звонков. Деятельность объявлена в структуре;
    подключение — отдельным этапом.</div>
)}
```

- Старые рендер-ветки `vending/supply/coffee/collect/team` удалить (их содержимое переехало или переиспользовано).

- [ ] **Step 4: tsc + живой прогон**

Run: `pnpm -s --filter cc exec tsc --noEmit` → 0.
Run: `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/domain/vendhub?tab=service"` → 200; то же для `?tab=hr`, `?tab=settings:machine`, `?tab=smm`. Проверить редирект: `curl -s -o /dev/null -w "%{redirect_url}\n" "http://localhost:3000/domain/vendhub?tab=vending"` содержит `settings`.

- [ ] **Step 5: Commit**

```bash
git add apps/cc/src/app/domain/[domain]/page.tsx
git commit -m "feat(cc): вкладки VendHub — восьмёрка владельца, редиректы старых адресов"
```

### Task 3: PR1 — проверка и выкатка

- [ ] **Step 1:** `pnpm -s build` → 11/11; `pnpm -s test` → 21/21.
- [ ] **Step 2:** Скриншоты локалки: дашборд (вкладки в новом порядке), `?tab=settings` (Профиль первым, «Автоматы» в листьях), `?tab=service`, `?tab=hr`.
- [ ] **Step 3:** Push `feat/workspace-redesign`, PR «Навигация: восьмёрка владельца», в теле — таблица редиректов. Дождаться CI, мёрж squash, дождаться прод-коммита в `/health`, повторить curl-проверки шага 4 Task 2 против прода (через туннель — cc-прод недоступен напрямую, проверять GET страниц локальной сборкой против прод-ядра).

---

## PR 2 — Дашборд

Ветка: `feat/dashboard-redesign` от свежего main.

### Task 4: shared — «деньги в автоматах» чистой функцией

**Files:**
- Create: `packages/shared/src/cash-estimate.ts`
- Create: `packages/shared/src/cash-estimate.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CashSale { machineId: string; ts: string; amount: number; cash: boolean; }
export interface ReceivedCollection { machineId: string; receivedAt: string; }
export interface MachineCash { machineId: string; amount: number; since: string | null; }
export function cashInMachines(sales: readonly CashSale[], received: readonly ReceivedCollection[]): { total: number; perMachine: MachineCash[] };
```

Правило: по каждому автомату берётся ПОСЛЕДНЯЯ принятая инкассация; суммируются наличные продажи строго ПОСЛЕ неё; автомат без инкассаций — окно от первой продажи (`since: null`). Не-cash продажи не считаются.

- [ ] **Step 1: Тест (падает)**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cashInMachines } from "./cash-estimate";

describe("Деньги в автоматах", () => {
  it("считает наличные после последней принятой инкассации", () => {
    const r = cashInMachines(
      [
        { machineId: "m1", ts: "2026-08-01T10:00:00+05:00", amount: 10000, cash: true },
        { machineId: "m1", ts: "2026-08-10T10:00:00+05:00", amount: 15000, cash: true },
        { machineId: "m1", ts: "2026-08-11T10:00:00+05:00", amount: 9000, cash: false },
      ],
      [{ machineId: "m1", receivedAt: "2026-08-05T00:00:00+05:00" }],
    );
    assert.equal(r.total, 15000);
    assert.equal(r.perMachine[0].since, "2026-08-05T00:00:00+05:00");
  });
  it("без инкассаций — окно от первой продажи, since null", () => {
    const r = cashInMachines(
      [{ machineId: "m2", ts: "2026-08-01T10:00:00+05:00", amount: 5000, cash: true }],
      [],
    );
    assert.equal(r.total, 5000);
    assert.equal(r.perMachine[0].since, null);
  });
  it("несколько инкассаций — берётся последняя", () => {
    const r = cashInMachines(
      [{ machineId: "m1", ts: "2026-08-10T00:00:00+05:00", amount: 7000, cash: true }],
      [
        { machineId: "m1", receivedAt: "2026-08-01T00:00:00+05:00" },
        { machineId: "m1", receivedAt: "2026-08-09T00:00:00+05:00" },
      ],
    );
    assert.equal(r.total, 7000);
  });
});
```

- [ ] **Step 2:** `pnpm -s --filter @mydon/shared build && cd packages/shared && pnpm -s test` → FAIL (модуля нет).
- [ ] **Step 3: Реализация**

```ts
export function cashInMachines(
  sales: readonly CashSale[],
  received: readonly ReceivedCollection[],
): { total: number; perMachine: MachineCash[] } {
  const посл = new Map<string, string>();
  for (const c of received) {
    const прежняя = посл.get(c.machineId);
    if (!прежняя || c.receivedAt > прежняя) посл.set(c.machineId, c.receivedAt);
  }
  const сумма = new Map<string, number>();
  for (const s of sales) {
    if (!s.cash) continue;
    const с = посл.get(s.machineId);
    if (с && s.ts <= с) continue;
    сумма.set(s.machineId, (сумма.get(s.machineId) ?? 0) + s.amount);
  }
  const perMachine = [...сумма.entries()]
    .map(([machineId, amount]) => ({ machineId, amount, since: посл.get(machineId) ?? null }))
    .sort((a, b) => b.amount - a.amount);
  return { total: perMachine.reduce((t, m) => t + m.amount, 0), perMachine };
}
```

Экспорт добавить в `packages/shared/src/index.ts` рядом с `export * from "./coffee-order";`.

- [ ] **Step 4:** build+test shared → PASS. Полный `pnpm -s test` — прочие пакеты не задеты.
- [ ] **Step 5: Commit** `feat(shared): наличные в автоматах после последней принятой инкассации`.

### Task 5: core — эндпоинт cash-estimate и дни в кофейной сводке

**Files:**
- Modify: `apps/core/src/collections/collections.service.ts` (+метод `cashEstimate`)
- Modify: `apps/core/src/collections/collections.controller.ts` (+`GET /collections/cash-estimate`, поставить ВЫШЕ маршрута `:id`, как `pending` в entities)
- Modify: `apps/core/src/coffee/coffee-orders.service.ts` (`summary`: +`поДням`)

**Interfaces:**
- Produces: `GET /collections/cash-estimate` → `{ всего: number; поАвтоматам: { machineId: string; имя: string | null; сумма: number; с: string | null }[] }`; `summary().поДням: { день: string; чашек: number; выручка: number }[]` (день — `YYYY-MM-DD` по Ташкенту).

- [ ] **Step 1: cashEstimate в сервисе**

```ts
/** Оценка наличных в автоматах: продажи cash после последней ПРИНЯТОЙ инкассации. */
async cashEstimate(): Promise<{ всего: number; поАвтоматам: { machineId: string; имя: string | null; сумма: number; с: string | null }[] }> {
  const принятые = await this.db
    .select({ machineId: collection.machineId, receivedAt: collection.receivedAt })
    .from(collection)
    .where(sql`${collection.receivedAt} is not null`);
  const кофе = await this.db
    .select({ machineId: coffeeOrder.machineId, ts: coffeeOrder.ts, amount: coffeeOrder.amount, res: coffeeOrder.orderResource })
    .from(coffeeOrder)
    .where(and(eq(coffeeOrder.countable, true), sql`${coffeeOrder.machineId} is not null`));
  const снек = await this.db
    .select({ machineId: sale.machineId, dt: sale.dt, amount: sale.amount })
    .from(sale)
    .where(sql`${sale.machineId} is not null`);
  const cashRes = new Set(["cash", "cash0", "cash payment", "credit"]);
  const продажи = [
    ...кофе.map((r) => ({ machineId: r.machineId as string, ts: (r.ts as Date).toISOString(), amount: Number(r.amount), cash: cashRes.has(String(r.res ?? "").toLowerCase()) })),
    // Снек: платёжного канала в источнике нет — считаем наличными и честно
    // помечаем «≈» на витрине.
    ...снек.map((r) => ({ machineId: r.machineId as string, ts: `${r.dt}T23:59:59+05:00`, amount: Number(r.amount), cash: true })),
  ];
  const метки = принятые.map((c) => ({ machineId: c.machineId, receivedAt: (c.receivedAt as Date).toISOString() }));
  const итог = cashInMachines(продажи, метки);
  const имена = new Map((await this.db.select({ id: entity.id, name: entity.name }).from(entity)).map((e) => [e.id, e.name]));
  return { всего: Math.round(итог.total), поАвтоматам: итог.perMachine.map((m) => ({ machineId: m.machineId, имя: имена.get(m.machineId) ?? null, сумма: Math.round(m.amount), с: m.since })) };
}
```

Импорты: `cashInMachines` из `@mydon/shared`; `coffeeOrder`, `sale` из `@mydon/db`. Контроллер:

```ts
@Get("cash-estimate")
cashEstimate() {
  return this.collections.cashEstimate();
}
```

- [ ] **Step 2: поДням в coffee summary**

В `coffee-orders.service.ts` рядом с `поМесяцам` добавить запрос (тот же паттерн, `'YYYY-MM-DD'`, тот же `где`) и поле в возвращаемом типе/объекте:

```ts
const поДням = await this.db
  .select({
    день: sql<string>`to_char(${coffeeOrder.ts} at time zone 'Asia/Tashkent', 'YYYY-MM-DD')`,
    чашек: sql<number>`count(*)::int`,
    выручка: sql<number>`coalesce(sum(${coffeeOrder.amount}), 0)::float8`,
  })
  .from(coffeeOrder)
  .where(где)
  .groupBy(sql`to_char(${coffeeOrder.ts} at time zone 'Asia/Tashkent', 'YYYY-MM-DD')`)
  .orderBy(sql`to_char(${coffeeOrder.ts} at time zone 'Asia/Tashkent', 'YYYY-MM-DD')`);
```

- [ ] **Step 3:** `pnpm -s --filter core exec tsc --noEmit` → 0. Живо: `curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:3001/collections/cash-estimate` (после деплоя PR) — на локали проверить только tsc; живую проверку сделать в Task 7 после выкатки.
- [ ] **Step 4: Commit** `feat(core): оценка наличных в автоматах; дневная сводка кофе`.

### Task 6: Дашборд — перекомпоновка overview

**Files:**
- Modify: `apps/cc/src/app/domain/[domain]/page.tsx` (overview-блок: секции между шапкой и концом overview; сейчас: KPI-долги, тревога, карта ~500–560, кофе/снек 705–760, «Что заведено» ниже)
- Modify: `apps/cc/src/lib/core.ts` (+`cashEstimate`, тип `поДням` в `coffeeOrdersSummary`)

**Interfaces:**
- Consumes: `core.coffeeOrdersSummary` (с `поДням`), `core.salesSummary`, `core.machineCards`, `core.collectionsSummary`, `core.supplySummary`, `core.contractorsAll`, новый `core.cashEstimate: () => get<{ всего: number; поАвтоматам: {...}[] }>("/collections/cash-estimate")`.

Порядок секций (по канвасу, артборд «Дашборд — новая компоновка»):

1. **Предприятие**: Выручка·30д (кофе `всего.выручка` + снек `days30.amount`), Валовая маржа (константы пока НЕ считаются на лету: взять из живого расчёта карточек нельзя дёшево — вывести «кофе 59% · снек 28%» из сводного эндпоинта НЕТ; решение: маржу считать в cc из уже загружаемых данных было бы дорого — в этом PR плитка показывает выручку-состав, а маржа — «по последним закупочным» из `/stock/consumption`? НЕТ: спец-правка — плитка «Валовая маржа» в этом PR подписывается «считается по карточкам» и берёт числа из статичной сводки `coffeeOrdersSummary` НЕ содержит маржу. РЕШЕНИЕ (фиксирую): в этом PR плитка №2 — «Средний чек кофе» (`всего.среднийЧек`), маржа переезжает в отчёт «Себестоимость» следующим этапом. Канвас остаётся целью, спека помечается.), Деньги в автоматах ≈ (`cashEstimate.всего`), Требует внимания (пустые спирали `vendingDeficit.length` + `неВыдано` + открытые задачи; число = сумма; расшифровка в футе).
2. **Быстрые действия** — существующие ссылки `+ Пополнение автоматов`, `+ Инкассация`, `+ Ремонт / выезд` перенести из подвала под KPI, добавить `+ Задача` (ссылка на `?tab=tasks`).
3. **Контуры кофе/снек** — существующие блоки (не переписывать, переместить и сжать до 2+2 виджетов по канвасу).
4. **Деньги и партнёры**: Закупки·30д (`supplySummary.purchases30.total`, подпись «по журналу прихода»), Поставщики (счёт contractorsAll с vendhub-направлением + имя крупнейшего по `attrs["оборот по реестру"]`), Инкассация·30д (`collectionsSummary`), Топ товара (`поТоварам[0]` кофе).
5. **Парк**: из `machineCards`: in_service (по kind: кофе/снек в футе), warehouse, repair, «Выработка чаш/авт» = `всего.чашек / число торговавших` (`поАвтоматам.length`). Каждая плитка — `<Link href={...settings:machine}>`.
6. **График** — объединить `salesDaily` и `поДням` кофе в один ряд по дате (просуммировать в cc; отсутствующий день = 0).
7. **Карта** — обернуть существующий блок карты в `<details className="sect">` c `<summary>` по образцу «История» из `location-panel.tsx` и перенести В КОНЕЦ overview.

- [ ] **Step 1:** client-методы в `core.ts` (cashEstimate + поДням в типе).
- [ ] **Step 2:** перекомпоновка секций (много перемещений — делать по одной секции, после каждой `tsc`).
- [ ] **Step 3:** tsc → 0; `curl -s "http://localhost:3000/domain/vendhub" | grep -o "Предприятие\|Деньги и партнёры\|Парк"` — все три найдены; скриншот всей страницы.
- [ ] **Step 4: Commit** `feat(cc): дашборд — показатели предприятия, действия под цифрами, карта внизу`.

### Task 7: PR2 — проверка и выкатка

- [ ] `pnpm -s build`, `pnpm -s test`, скриншоты (верх дашборда, секция Парк, свёрнутая карта), PR «Дашборд предприятия», CI, мёрж, `/health`, живой `curl /collections/cash-estimate` через туннель, спека: пометить решение «маржа → отчёт Себестоимость следующим этапом».

---

## PR 3 — Обслуживание

Ветка: `feat/service-tab` от свежего main.

### Task 8: shared — слияние ленты полевых событий

**Files:**
- Create: `packages/shared/src/service-feed.ts`
- Create: `packages/shared/src/service-feed.test.ts`

**Interfaces:**
- Produces:

```ts
export type ServiceFeedKind = "coffee" | "snack" | "cash";
export interface ServiceFeedItem { kind: ServiceFeedKind; ts: string; место: string; текст: string; кто: string | null; }
export function mergeServiceFeed(items: readonly ServiceFeedItem[][], limit?: number): ServiceFeedItem[];
```

`mergeServiceFeed` сливает готовые массивы, сортирует по `ts` убыв., режет по limit (умолчание 50). Форматирование строк («бункер 7 · Кофе · залито 1 628 г») делают адаптеры в cc — по одному на источник, чистые функции ТОЖЕ в этом файле:

```ts
export function coffeeRefillToFeed(r: { locationName: string; position: number; ingredientName: string | null; filledWeight: number; createdAt: string; createdBy: string | null }): ServiceFeedItem;
export function collectionToFeed(c: { machineName: string | null; collectedAt: string; amount: number | null; operatorName: string | null }): ServiceFeedItem;
export function vendingRefillToFeed(v: { machineName: string | null; createdAt: string; positions: number; units: number; createdBy: string | null }): ServiceFeedItem;
```

- [ ] **Step 1: Тесты** — сортировка/лимит; каждый адаптер: формат текста, kind, null-имена → «—». Пример:

```ts
it("сливает и сортирует по времени убыванием", () => {
  const a = [{ kind: "coffee" as const, ts: "2026-08-20T09:00:00+05:00", место: "KIUT", текст: "…", кто: null }];
  const b = [{ kind: "cash" as const, ts: "2026-08-20T10:00:00+05:00", место: "SKLAD 1C", текст: "…", кто: "Рустам" }];
  const r = mergeServiceFeed([a, b]);
  assert.equal(r[0].kind, "cash");
});
```

- [ ] **Step 2:** FAIL → реализация → PASS → экспорт в index.ts → Commit `feat(shared): лента полевых событий обслуживания`.

### Task 9: Вкладка «Обслуживание» целиком

**Files:**
- Create: `apps/cc/src/components/service-tab.tsx`
- Modify: `apps/cc/src/app/domain/[domain]/page.tsx` (ветка `service`: заменить временную сборку из Task 2 на `<ServiceTab …/>`; данные best-effort в try/catch по образцу соседей)

**Interfaces:**
- Consumes: `core.coffeeFillStatus`, `core.recentRefills`-аналог (grep в `core.ts`: метод списка `GET /coffee/refill/recent`; если клиента нет — добавить `coffeeRefillsRecent: (limit=20) => get(...)` рядом с coffeeFillStatus), `core.vendingDeficit`, `core.collections({days:"30"})`, `GET /vending/refills` (клиент `vendingRefillList` — добавить, если нет), адаптеры из Task 8.
- Produces: серверный компонент `ServiceTab({ kpi, feed, actions })` — принимает уже загруженные данные; сам ничего не фетчит (паттерн страницы).

Состав по канвасу (артборд «Обслуживание»): мини-KPI (залито сегодня — счёт refill за сегодня по Ташкенту; точек ждёт визита — `coffeeFillStatus` со `status === "underfill"`, уникальные точки; пустые спирали — `vendingDeficit.length`; деньги не сняты — дата последней ПРИНЯТОЙ инкассации из `collections`), три действия-ссылки (кофе → существующая форма кофе-панели, снек → vending-панель, инкассация → CollectionsView; в этом PR — те же панели, раскрытые по клику якорями `#coffee/#snack/#cash` внутри вкладки), лента `mergeServiceFeed` с фильтром-чипами (client-компонент с useState по образцу `card-tabs.tsx`), внизу — ссылки «нумерация бункеров и наборов» → `?tab=settings:package` (или лист справочника, где они осядут).

- [ ] **Step 1:** клиент-методы (если отсутствуют) → tsc.
- [ ] **Step 2:** `ServiceTab` разметка + фильтр ленты.
- [ ] **Step 3:** данные в page.tsx (try/catch, провал одного источника не роняет вкладку и не обнуляет чужие блоки — правило из памяти).
- [ ] **Step 4:** tsc; `curl "http://localhost:3000/domain/vendhub?tab=service" | grep -o "Залито сегодня\|История"`; скриншот.
- [ ] **Step 5: Commit** `feat(cc): Обслуживание — KPI, действия, единая лента истории`.

### Task 10: Задачи-витрина

**Files:**
- Modify: `apps/cc/src/app/domain/[domain]/page.tsx` (ветка `tasks`)

Мини-KPI над существующим списком задач: открыто (`openTasks.length`), просрочено (`core.tasksOverdue`? grep клиента; есть `GET /tasks/overdue`), свободных (задачи без owner — фильтр по загруженному списку), закрыто за неделю (фильтр по `status done` + `updatedAt` за 7 дней, если поле есть в типе — иначе плитку не показывать, НЕ выдумывать). Чип источника: если в типе Task есть поле происхождения (grep `createdFrom|origin|source` в типе Task в `core.ts`) — показать; если нет — чип НЕ делать, в PR-описании зафиксировать «источник задачи появится со срезом F».

- [ ] tsc → curl → скриншот → Commit `feat(cc): задачи — мини-KPI на вкладке`.


### Task 10b: Образец листа «как Автоматы» — обёртка ListShell

Закрывает §4 спеки (эталон каждого листа-реестра). Входит в PR3.

**Files:**
- Create: `apps/cc/src/components/list-shell.tsx`
- Modify: `apps/cc/src/app/domain/[domain]/page.tsx` (generic-ветка книги, ~1082, и рендер ProductsBook/ContractorsBook — обернуть)

**Interfaces:**
- Produces: серверный компонент

```tsx
export function ListShell({ kpi, action, searchQ, chips, children }: {
  kpi: { label: string; value: string; hot?: boolean }[];
  action?: ReactNode;          // «+ Запись» (существующий NewEntityForm)
  searchQ: string;             // текущий ?q= — поиск уже есть у ProductsBook, переиспользовать его форму
  chips?: ReactNode;           // фильтры листа, если у книги есть
  children: ReactNode;         // сама книга
}): JSX.Element;
```

Обёртка даёт один вид всем листам: ряд мини-KPI (`.tiles`-плитки: «Всего записей», «Не утверждено» — счёт по `approvedAt == null`, у листа контрагентов — «Оборот суммарно»), строка действия+поиска, чипы, книга. Generic-книга получает поиск по `?q=` (фильтр `leafItems` по подстроке имени — сервером, как это уже делает ProductsBook; grep его реализацию `q` и повторить).

- [ ] **Step 1:** компонент ListShell (разметка по артборду «Образец листа»).
- [ ] **Step 2:** generic-ветка: ListShell + серверный фильтр по `?q=`.
- [ ] **Step 3:** ProductsBook и ContractorsBook обернуть (их собственный поиск/сортировка не дублируются — chips/search передаются их же элементами).
- [ ] **Step 4:** tsc; curl `?tab=settings:machine` и `?tab=settings:contractor` — заголовки KPI видны; скриншот.
- [ ] **Step 5: Commit** `feat(cc): единый образец листа — показатели, поиск, фильтры`.

### Task 11: PR3 — проверка и выкатка

- [ ] `pnpm -s build` + `pnpm -s test`; состязательное ревью диффа (как в PR #176/#177 — Workflow с измерениями: корректность данных ленты, регресс панелей, UI-остатки); фиксы; PR «Обслуживание»; CI; мёрж; `/health`; живые curl-проверки; финальные скриншоты всех трёх экранов; обновить память проекта (статус: редизайн внедрён).

---

## Self-check перед каждым PR

1. `pnpm -s build` — 11/11.
2. `pnpm -s test` — 21/21 (боту предшествует build).
3. tsc по трём пакетам отдельно, если менялись.
4. Живые curl-проверки страниц локалки против прод-ядра.
5. Ни одного нового значения в `attrs` без записи в `MANAGED_ATTR_KEYS`/`MANAGED_KEYS` (урок из памяти) — в этом плане в attrs не пишем вовсе.
