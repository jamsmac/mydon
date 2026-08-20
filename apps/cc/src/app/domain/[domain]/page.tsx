import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DOMAINS, DOMAIN_LABELS, contractorInDirection, dueLabel, type Domain } from "@mydon/shared";
import {
  core,
  CoreUnavailable,
  type BrvValue,
  type Entity,
  type FinanceCounterparty,
  type FinanceFlow,
  type FinanceSummary,
  type GrContract,
  type GrImport,
  type GrPreorder,
  type GrUnit,
  type Obligations,
  type Person,
  type Task,
  type TnvedRate,
} from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { groupsFor, isTableBackedLeaf } from "../../../lib/domain-nav";
import { NewEntityForm } from "../../../components/entity-new";
import { CollectionsView } from "../../../components/collections-view";
import { SalesView } from "../../../components/sales-view";
import { ConsumptionView } from "../../../components/consumption-view";
import { ProductsBook } from "../../../components/products-book";
import { MachineStockView, PurchasesView } from "../../../components/supply-views";
import { MapPanel } from "../../../components/map-panel";
import { MiniBars } from "../../../components/mini-bars";
import { QuickActions } from "../../../components/quick-actions";
import { SourcesView } from "../../../components/sources-view";
import { ReportsOverview } from "../../../components/reports-overview";
import { VendingSupplyPanel } from "../../../components/vending-panel";
import { CoffeePanel } from "../../../components/coffee-panel";
import {
  ContractorsBook,
  ContractsBook,
  EquipmentBook,
  InvoicesBook,
} from "../../../components/globerent-books";
import { FinancePanel } from "../../../components/finance-panel";
import { CustomsRatesPanel } from "../../../components/customs-rates";
import { NewContractForm } from "../../../components/contract-forms";
import { CalcPanel } from "../../../components/calc-panel";
import { UnitsPanel } from "../../../components/units-panel";
import { ImportsPanel } from "../../../components/imports-panel";
import { PreordersSection } from "../../../components/preorders-section";
import { fmtDay } from "../../../lib/globerent";
import { contractEnd, contractStats, endLabel, type ContractStats } from "../../../lib/globerent";
import { typeOne } from "../../../lib/labels";
import { hasMoney, money, moneyByCurrency, plural, when } from "../../../lib/format";

export const dynamic = "force-dynamic";

function isDomain(v: string): v is Domain {
  return (DOMAINS as readonly string[]).includes(v);
}

/**
 * Рабочее место направления — как в ПО владельца (VHM24) и его command-center:
 * Дашборд первым, дальше группы-вкладки с подвкладками (Каталог → Товары,
 * Аппараты…; Справочники; Отчёты) плюс Команда и Задачи. Структура групп
 * перенесена из готового проекта, не придумана заново.
 */
export default async function DomainPage({
  params,
  searchParams,
}: {
  params: Promise<{ domain: string }>;
  // Вкладка «Источники» держит своё состояние в адресе (фильтры по колонкам
  // f0, f1…), поэтому параметры принимаем целиком, а не перечислением.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { domain } = await params;
  const raw = await searchParams;
  const sp: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (typeof v === "string") sp[key] = v;
  }
  const { tab, q, cat, inc } = sp;
  if (!isDomain(domain)) notFound();

  const groups = groupsFor(domain);
  const active = tab ?? "overview";
  const [activeGroup, activeLeaf] = active.includes(":") ? active.split(":") : [active, null];

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
  const redirectBase = TAB_REDIRECTS[activeGroup];
  if (redirectBase && domain === "vendhub") {
    // catalog/reference были группами с подвкладками — сохраняем лист при
    // переезде в settings; остальные (vending/supply/…) были плоскими
    // операционными вкладками, у них листа не было.
    const redirectTo =
      (activeGroup === "catalog" || activeGroup === "reference") && activeLeaf
        ? `settings:${activeLeaf}`
        : redirectBase;
    redirect(`/domain/${domain}?tab=${redirectTo}`);
  }

  const isOverview = activeGroup === "overview";

  // Реестр направления и метки вкладок (команда, задачи) нужны на любой вкладке —
  // их тянем всегда. Реестр — сердце страницы: его провал показываем как «Core лёг».
  let entities: Entity[];
  let people: Person[] = [];
  let tasks: Task[] = [];
  let contractors: Entity[] = [];
  let contractorsLoaded = false;
  try {
    entities = await core.entitiesOf(domain);
    try {
      [people, tasks] = await Promise.all([core.people(), core.tasks({ domain })]);
    } catch {
      // команда и задачи — не повод ронять страницу направления
    }
    try {
      // Контрагенты живут одной карточкой на юрлицо и потому не помещаются в
      // выборку по организации: поставщик VendHub может лежать в GLOBERENT,
      // куда попал при выгрузке документов. Берём всех и отбираем по признаку
      // направления — тем же, что считает цифру на подвкладке.
      contractors = (await core.contractorsAll()).filter((e) => contractorInDirection(e, domain));
      contractorsLoaded = true;
    } catch {
      // реестр контрагентов — не повод ронять страницу направления
    }
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  // Ленивая загрузка (Фаза 2): обязательства нужны ТОЛЬКО дашборду. На других
  // вкладках их не тянем — переключение вкладки больше не запрашивает данные
  // всех разделов сразу. Провал здесь не роняет страницу: дашборд покажет нули.
  let obligations: Obligations = {
    domain,
    totals: [],
    overdue: [],
    overdueTotal: 0,
    overdueTruncated: false,
  };
  if (isOverview) {
    try {
      obligations = await core.obligations(domain);
    } catch {
      // Core ответил на реестр, но не на обязательства — показываем нули.
    }
  }

  const ourPeople = people.filter((p) => p.domain === domain);
  const machines = entities.filter((e) => e.type === "machine");
  // Тип автомата — только из заполненного поля. Пустое — «не указан»,
  // а не «снеки» (находка ревизии 2026-07-30).
  const catOf = (e: Entity) => (e.attrs ?? {})["категория"];
  const coffeeMachines = machines.filter((e) => Number(catOf(e)) === 10).length;
  const unknownMachines = machines.filter((e) => {
    const c = catOf(e);
    return c === undefined || c === null || c === "";
  }).length;
  const noCoords = machines.filter((e) => {
    const a = e.attrs ?? {};
    return !a["широта"] || !a["долгота"];
  });
  const snackMachines = machines.length - coffeeMachines - unknownMachines;
  const defaultOwner = ourPeople.find((p) => p.active === "yes" && p.tgChatId) ?? ourPeople[0] ?? null;

  // Инкассация нужна и МЕТКЕ вкладки (счётчик «ждут приёма»), поэтому тянется
  // всегда для vendhub — это один дешёвый запрос.
  let collSummary: { pending: number; receivedCount: number; receivedSum: number } | null = null;
  if (domain === "vendhub") {
    try {
      collSummary = await core.collectionsSummary(30);
    } catch {
      collSummary = null;
    }
  }

  // Ленивая загрузка (Фаза 2): сводки продаж и склада — только для плиток
  // дашборда. На других вкладках vendhub их не тянем.
  let salesSummary: Awaited<ReturnType<typeof core.salesSummary>> | null = null;
  let coffeeOrders: Awaited<ReturnType<typeof core.coffeeOrdersSummary>> | null = null;
  let coffeeOrdersStatus: Awaited<ReturnType<typeof core.coffeeOrdersStatus>> | null = null;
  let supplySummary: Awaited<ReturnType<typeof core.supplySummary>> | null = null;
  // Кофе-бункеры на дашборде: алерты и расход за 30 дней. Провал любого
  // запроса не роняет дашборд — секция просто не показывается.
  let coffeeAlerts: number | null = null;
  let coffeeConsumption: Awaited<ReturnType<typeof core.coffeeContainerConsumption>> | null = null;
  let salesDaily: Awaited<ReturnType<typeof core.salesDaily>> | null = null;
  if (domain === "vendhub" && isOverview) {
    const isoDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    let coffeeFill: Awaited<ReturnType<typeof core.coffeeFillStatus>> | null = null;
    let coffeeWash: Awaited<ReturnType<typeof core.coffeeWashScheduleStatus>> | null = null;
    [salesSummary, supplySummary, coffeeFill, coffeeWash, coffeeConsumption, salesDaily] = await Promise.all([
      core.salesSummary().catch(() => null),
      core.supplySummary().catch(() => null),
      core.coffeeFillStatus().catch(() => null),
      core.coffeeWashScheduleStatus().catch(() => null),
      core.coffeeContainerConsumption(isoDate(fromDate), isoDate(new Date())).catch(() => null),
      core.salesDaily(30).catch(() => null),
    ]);
    if (coffeeFill !== null || coffeeWash !== null) {
      coffeeAlerts =
        (coffeeFill ?? []).filter((r) => r.status === "underfill").length +
        (coffeeWash ?? []).filter((r) => r.status === "overdue").length;
    }
  }
  const openTasks = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  // Задачи по контурам (слово владельца: смотреть и вместе, и по отдельности).
  // Эвристика по заголовку — задачи создаются с говорящими названиями
  // («Чистка кофемолок», «Пополнение автоматов»), точного тега контура нет.
  const isCoffeeTask = (t: Task) => /кофе|бункер|мойк|кофемолк|заливк/i.test(t.title);
  const coffeeTasks = openTasks.filter(isCoffeeTask).length;
  const snackTasks = openTasks.filter((t) => !isCoffeeTask(t) && /пополнен|инкасс|закуп|автомат|снек/i.test(t.title)).length;

  // Расход кофе по неделям (для мини-графика): пары группируются по понедельнику
  // недели даты возврата. Пары без посчитанного расхода в график не попадают.
  const coffeeWeeklyBars = (() => {
    if (coffeeConsumption === null) return [];
    const byWeek = new Map<string, number>();
    for (const r of coffeeConsumption.rows) {
      if (r.consumedGrams === null) continue;
      const d = new Date(`${r.returnDate}T00:00:00`);
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const key = monday.toLocaleDateString("en-CA");
      byWeek.set(key, (byWeek.get(key) ?? 0) + r.consumedGrams);
    }
    return [...byWeek.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, grams]) => ({
        label: `${k.slice(8)}.${k.slice(5, 7)}`,
        value: grams,
        title: `неделя с ${k}: ${(grams / 1000).toFixed(1)} кг`,
      }));
  })();
  if (domain === "vendhub") {
    // Тридцать календарных суток по Ташкенту, а не 720 часов от «сейчас»:
    // скользящее окно смещало бы границу внутрь чужого дня, и утренняя
    // сводка расходилась бы с вечерней без единой новой продажи.
    const с = new Date(Date.now() - 30 * 24 * 3600 * 1000).toLocaleDateString("en-CA", {
      timeZone: "Asia/Tashkent",
    });
    [coffeeOrders, coffeeOrdersStatus] = await Promise.all([
      core.coffeeOrdersSummary(с).catch(() => null),
      core.coffeeOrdersStatus().catch(() => null),
    ]);
  }
  const byType = entities.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});
  // Контрагенты считаются по своему признаку направления, а не по организации:
  // иначе цифра на подвкладке разошлась бы со списком под ней. Цифру
  // перезаписываем ТОЛЬКО когда реестр действительно прочитан: провал запроса
  // не должен превращать 226 контрагентов GLOBERENT в ноль на вкладке.
  if (contractorsLoaded) byType["contractor"] = contractors.length;

  // GLOBERENT: раскладка договоров по срокам — тот же 14-дневный горизонт и то же
  // строковое сравнение дат, что в брифинге Core, чтобы панель и бот сходились в цифре.
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  let grContracts: ContractStats | null = null;
  if (domain === "globerent") {
    const horizonDate = new Date();
    horizonDate.setDate(horizonDate.getDate() + 14);
    grContracts = contractStats(
      entities.filter((e) => e.type === "contract"),
      todayKey,
      horizonDate.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" }),
    );
  }

  // Финансовый контур GLOBERENT (перенос PROMACH): свод нужен вкладке «Финансы»
  // целиком, а дашборду — сигналом (к сроку ≤ 7 дней, просрочка, термометр).
  // Провал запроса не роняет страницу: секция честно скажет, что данных нет.
  const isFinanceTab = activeGroup === "finance";
  let finSummary: FinanceSummary | null = null;
  let finFlows: FinanceFlow[] = [];
  let finCounterparties: FinanceCounterparty[] = [];
  let finUnits: { id: string; label: string }[] = [];
  if (domain === "globerent" && (isFinanceTab || isOverview)) {
    finSummary = await core.financeSummary(domain).catch(() => null);
    if (isFinanceTab) {
      let unitRows: GrUnit[] = [];
      [finFlows, finCounterparties, unitRows] = await Promise.all([
        core.financeFlows(domain, { limit: "100" }).catch(() => [] as FinanceFlow[]),
        core.financeCounterparties(domain).catch(() => [] as FinanceCounterparty[]),
        core.units(domain).catch(() => [] as GrUnit[]),
      ]);
      finUnits = unitRows.map((u) => ({ id: u.id, label: `${u.code} · ${u.name}` }));
    }
  }

  // «Должны» — только открытые обязательства: оплаченное (actual) и отменённое
  // долгом не является (ловилось при переносе финконтура PROMACH).
  const isOpenObligation = (t: { status: string }) => t.status !== "actual" && t.status !== "cancelled";
  const owedToUs = obligations.totals.filter((t) => t.direction === "in" && isOpenObligation(t));
  const owedByUs = obligations.totals.filter((t) => t.direction === "out" && isOpenObligation(t));

  const href = (t: string) => `/domain/${domain}?tab=${encodeURIComponent(t)}`;

  // ── верхний ряд вкладок ────────────────────────────────────────────────────
  const teamLabel = `Команда${ourPeople.length > 0 ? ` ${ourPeople.length}` : ""}`;
  const tasksLabel = `Задачи${openTasks.length > 0 ? ` ${openTasks.length}` : ""}`;
  const topTabs =
    domain === "vendhub"
      ? // Восьмёрка владельца (слово владельца, 20.08.2026) — порядок задан явно,
        // не через groups-порядок (settings/reports там идут иначе). «Задачи» и
        // подписи «Отчёты»/«Настройки» переиспользуют существующие ключи —
        // только переставлены, не задублированы.
        [
          { key: "overview", label: "Дашборд" },
          { key: "service", label: "Обслуживание" },
          { key: "tasks", label: tasksLabel },
          { key: "reports", label: groups.find((g) => g.key === "reports")?.label ?? "Отчёты" },
          { key: "smm", label: "SMM" },
          { key: "crm", label: "CRM" },
          { key: "hr", label: `HR${ourPeople.length > 0 ? ` ${ourPeople.length}` : ""}` },
          { key: "settings", label: groups.find((g) => g.key === "settings")?.label ?? "Настройки" },
        ]
      : [
          { key: "overview", label: "Дашборд" },
          // Живые контуры GLOBERENT (перенос PROMACH): склад, импорт, финансы, калькулятор.
          ...(domain === "globerent"
            ? [
                { key: "units", label: "Склад" },
                { key: "imports", label: "Импорт" },
                { key: "finance", label: "Финансы" },
                { key: "calc", label: "Калькулятор" },
              ]
            : []),
          ...groups.map((g) => ({ key: g.key, label: g.label })),
          { key: "team", label: teamLabel },
          { key: "tasks", label: tasksLabel },
        ];

  const group = groups.find((g) => g.key === activeGroup);
  // Внутри группы по умолчанию открыта первая подвкладка с данными.
  const leaf =
    group?.leaves.find((l) => l.type === activeLeaf) ??
    // Витрина по источникам — вид отчётов по умолчанию (там, где она есть).
    group?.leaves.find((l) => l.type === "sources") ??
    group?.leaves.find((l) => l.type !== null && (byType[l.type] ?? 0) > 0) ??
    // Иначе первый живой отчёт — Инкассация.
    group?.leaves.find((l) => l.type === "collection") ??
    group?.leaves[0];
  const leafItems =
    group && leaf?.type
      ? (leaf.type === "contractor" && contractorsLoaded
          ? contractors
          : entities.filter((e) => e.type === leaf.type)
        ).sort((a, b) => a.name.localeCompare(b.name, "ru"))
      : [];

  // Справочник растаможки (ставки ТН ВЭД + БРВ) — живые таблицы Core, не реестр.
  let tnved: TnvedRate[] = [];
  let brv: BrvValue[] = [];
  if (group && leaf?.type === "customs_rates") {
    [tnved, brv] = await Promise.all([
      core.tnvedRates().catch(() => [] as TnvedRate[]),
      core.brvValues().catch(() => [] as BrvValue[]),
    ]);
  }

  // Живые UZS-договоры (перенос PROMACH) — поверх собранных карточек реестра.
  let liveContracts: GrContract[] = [];
  let contractClients: FinanceCounterparty[] = [];
  if (domain === "globerent" && group && leaf?.type === "contract") {
    [liveContracts, contractClients] = await Promise.all([
      core.contracts(domain).catch(() => [] as GrContract[]),
      core.financeCounterparties(domain).catch(() => [] as FinanceCounterparty[]),
    ]);
  }

  // Калькулятор цены: ставки, БРВ и курс — входы движка (сам расчёт в браузере).
  let calcRates: TnvedRate[] = [];
  let calcBrv: BrvValue[] = [];
  let calcFx: Awaited<ReturnType<typeof core.fxRates>> = [];
  if (domain === "globerent" && activeGroup === "calc") {
    [calcRates, calcBrv, calcFx] = await Promise.all([
      core.tnvedRates().catch(() => [] as TnvedRate[]),
      core.brvValues().catch(() => [] as BrvValue[]),
      core.fxRates().catch(() => []),
    ]);
  }

  // Склад техники: конвейер единиц (перенос warehouse_vehicles PROMACH).
  let units: GrUnit[] = [];
  let unitsSummary: { key: string; label: string; n: number }[] = [];
  let unitClients: FinanceCounterparty[] = [];
  if (domain === "globerent" && activeGroup === "units") {
    [units, unitsSummary, unitClients] = await Promise.all([
      core.units(domain).catch(() => [] as GrUnit[]),
      core.unitsSummary(domain).catch(() => []),
      core.financeCounterparties(domain).catch(() => [] as FinanceCounterparty[]),
    ]);
  }

  // Импортные контракты и предзаказы (перенос PROMACH).
  let importsList: GrImport[] = [];
  let importSuppliers: FinanceCounterparty[] = [];
  let preorders: GrPreorder[] = [];
  if (domain === "globerent" && activeGroup === "imports") {
    [importsList, importSuppliers, preorders] = await Promise.all([
      core.imports(domain).catch(() => [] as GrImport[]),
      core.financeCounterparties(domain).catch(() => [] as FinanceCounterparty[]),
      core.preorders(domain).catch(() => [] as GrPreorder[]),
    ]);
  }

  // Хлебные крошки и чип маршрута (расположение из обложки): где я и как это
  // адресуется. Счётчик из подписи вкладки для крошки убираем — «Задачи 6» → «Задачи».
  const activeTab = topTabs.find((t) => t.key === activeGroup);
  const crumbLabel =
    activeTab && activeGroup !== "overview" ? activeTab.label.replace(/\s+\d+$/, "") : null;
  const routeSlug = activeGroup === "overview" ? "" : activeGroup;
  const routePath = `/${domain}${routeSlug ? `/${routeSlug}` : ""}${activeLeaf ? `/${activeLeaf}` : ""}`;

  return (
    <>
      <div className="page-head">
        <nav className="crumbs" aria-label="Хлебные крошки">
          <Link href="/mydon">MYDON</Link>
          <span className="sep">/</span>
          <span className="cur">{DOMAIN_LABELS[domain]}</span>
          {crumbLabel && (
            <>
              <span className="sep">/</span>
              <span className="cur">{crumbLabel}</span>
            </>
          )}
          <span className="route" title="Адрес раздела">{routePath}</span>
        </nav>
        <h1 className="h1">{DOMAIN_LABELS[domain]}</h1>
        <p className="lead">
          {entities.length} {plural(entities.length, "запись", "записи", "записей")} в реестре
          {openTasks.length > 0 ? ` · открытых задач: ${openTasks.length}` : ""}
        </p>
      </div>

      <div className="tabs" role="tablist">
        {topTabs.map((t) => (
          <Link
            key={t.key}
            href={href(t.key)}
            // Переключение вкладки не прыгает наверх — позиция прокрутки держится.
            scroll={false}
            className={`tab ${activeGroup === t.key ? "active" : ""}`}
            role="tab"
            aria-selected={activeGroup === t.key}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {group && (
        <div className="subtabs">
          {group.leaves.map((l) => {
            // Инкассация живёт своей таблицей, а не реестром — не затемняем.
            const n = isTableBackedLeaf(l.type) ? -1 : l.type ? (byType[l.type] ?? 0) : 0;
            const isActive = leaf === l;
            return (
              <Link
                key={l.label}
                href={href(`${group.key}:${l.type ?? l.label}`)}
                scroll={false}
                className={`subtab ${isActive ? "active" : ""} ${n === 0 ? "dim" : ""}`}
              >
                {l.label}
                {n > 0 ? ` ×${n}` : ""}
              </Link>
            );
          })}
        </div>
      )}

      {/* ── Обслуживание: временная сборка старых операционных панелей (до PR3) ── */}
      {domain === "vendhub" && activeGroup === "service" && (
        <>
          <div className="sect">
            <div className="sect-h"><h3 className="h2">Кофе-бункеры</h3></div>
            <CoffeePanel defaultOwnerRef={defaultOwner?.id ?? null} />
          </div>
          <div className="sect">
            <div className="sect-h"><h3 className="h2">Пополнение снека</h3></div>
            <VendingSupplyPanel />
          </div>
          <div className="sect">
            <div className="sect-h"><h3 className="h2">Инкассация</h3></div>
            <CollectionsView />
          </div>
        </>
      )}

      {/* ── SMM / CRM: деятельность объявлена в структуре, подключение — отдельным этапом ── */}
      {domain === "vendhub" && activeGroup === "smm" && (
        <div className="empty">
          <b>SMM — продвижение</b>
          Вебсайт, Instagram, TikTok и другие каналы направления. Деятельность объявлена
          в структуре; подключение — отдельным этапом со своей спекой.
        </div>
      )}
      {domain === "vendhub" && activeGroup === "crm" && (
        <div className="empty">
          <b>CRM — звонки и обращения</b>
          Приём обращений, анализ звонков. Деятельность объявлена в структуре;
          подключение — отдельным этапом.
        </div>
      )}

      {/* ── Финансы GLOBERENT: агинг, к сроку, термометр, кэш-флоу, ввод ── */}
      {isFinanceTab &&
        (finSummary !== null ? (
          <FinancePanel
            domain={domain}
            summary={finSummary}
            flows={finFlows}
            counterparties={finCounterparties}
            units={finUnits}
          />
        ) : (
          <div className="empty">
            <b>Финансовый свод недоступен</b>
            Core не ответил на запрос финансов. Обнови страницу; если повторяется —
            проверь, что Core обновлён до версии с финансовым контуром.
          </div>
        ))}

      {/* ── Дашборд ── */}
      {activeGroup === "overview" && (
        <>
          <div className="tiles">
            <div className={`tile ${hasMoney(owedToUs) ? "" : "zero"}`}>
              <div className="lab">Должны нам</div>
              <div className="v">{moneyByCurrency(owedToUs)}</div>
              <div className="foot"><span className="mk" />{hasMoney(owedToUs) ? "по реестру обязательств" : "нет открытых счетов"}</div>
            </div>
            <div className={`tile ${hasMoney(owedByUs) ? "" : "zero"}`}>
              <div className="lab">Должны мы</div>
              <div className="v">{moneyByCurrency(owedByUs)}</div>
              <div className="foot"><span className="mk" />{hasMoney(owedByUs) ? "поставщики и аренда" : "нет открытых счетов"}</div>
            </div>
            <div className={`tile ${obligations.overdueTotal > 0 ? "is-hot" : "zero"}`}>
              <div className="lab">Просрочено</div>
              <div className="v">{obligations.overdueTotal}</div>
              <div className="foot"><span className="mk" />{obligations.overdueTotal > 0 ? "требует твоего решения" : "просрочек нет"}</div>
            </div>
            <Link href={href("tasks")} className={`tile ${openTasks.length === 0 ? "zero" : ""}`}>
              <div className="lab">Открытых задач</div>
              <div className="v">{openTasks.length}</div>
              <div className="foot"><span className="mk" />
                {openTasks.length === 0
                  ? "задач нет"
                  : domain === "vendhub" && (coffeeTasks > 0 || snackTasks > 0)
                    ? `кофе ${coffeeTasks} · снек ${snackTasks} · прочее ${openTasks.length - coffeeTasks - snackTasks}`
                    : "по направлению"}
                <span className="go">→</span>
              </div>
            </Link>
          </div>

          {/* ── Контур GLOBERENT: договоры и парк — тревога №1 владельца это сроки ── */}
          {grContracts !== null && entities.length > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Договоры и парк</h3>
                {grContracts.dueSoon.length > 0 && (
                  <span className="chip h">на исходе · {grContracts.dueSoon.length}</span>
                )}
              </div>
              <div className="wgrid">
                <Link
                  href={href("docs:contract")}
                  className={`wt ${grContracts.dueSoon.length > 0 ? "" : "off"}`}
                >
                  <div className="wl">Истекают ≤ 14 дней</div>
                  <div className="wv">{grContracts.dueSoon.length}</div>
                  <div className="wf">
                    {grContracts.dueSoon.length > 0 ? "успей продлить" : "спокойно"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("docs:contract")} className="wt">
                  <div className="wl">Действующие договоры</div>
                  <div className="wv">{grContracts.active}</div>
                  <div className="wf">
                    {grContracts.noDate + grContracts.expired > 0
                      ? `без даты ${grContracts.noDate} · истекло ${grContracts.expired}`
                      : "все со сроком"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("catalog:contractor")} className="wt">
                  <div className="wl">Контрагенты</div>
                  <div className="wv">{byType["contractor"] ?? 0}</div>
                  <div className="wf">ключ сведения — ИНН<span className="go">→</span></div>
                </Link>
                <Link href={href("catalog:equipment")} className="wt">
                  <div className="wl">Техника HELI</div>
                  <div className="wv">{byType["equipment"] ?? 0}</div>
                  <div className="wf">единиц в каталоге<span className="go">→</span></div>
                </Link>
              </div>
              {grContracts.dueSoon.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {grContracts.dueSoon.slice(0, 8).map((e) => {
                    const { text, hot } = endLabel(contractEnd(e), todayKey);
                    return (
                      <Link href={`/card/${e.id}`} className="trow hot" key={e.id}>
                        <div className="tb">
                          <div className="tt">{e.name}</div>
                        </div>
                        <span className={`due ${hot ? "hot" : ""}`}>{text}</span>
                      </Link>
                    );
                  })}
                  {grContracts.dueSoon.length > 8 && (
                    <Link href={href("docs:contract")} className="navlink" style={{ justifyContent: "center" }}>
                      Все на исходе — {grContracts.dueSoon.length}
                    </Link>
                  )}
                </div>
              )}
              {grContracts.badDate > 0 && (
                <div className="warn" style={{ marginTop: 10 }}>
                  <b>Договоры с непонятной датой: {grContracts.badDate}</b>
                  Срок окончания не разобрать — в «на исходе» они не попали. Открой карточку
                  и поправь дату, иначе срок пройдёт незамеченным.
                </div>
              )}
              <div style={{ marginTop: 12 }}>
                <QuickActions
                  domain={domain}
                  actions={["Продлить договор", "Выставить счёт", "Напомнить об оплате"]}
                  defaultOwnerRef={defaultOwner?.id ?? null}
                />
              </div>
            </div>
          )}

          {/* ── Контур GLOBERENT: деньги — сигнал с вкладки «Финансы» ── */}
          {domain === "globerent" && finSummary !== null && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Деньги</h3>
                {finSummary.concentration.alarm && finSummary.concentration.topShare !== null && (
                  <span className="chip h">
                    концентрация · {Math.round(finSummary.concentration.topShare * 100)}%
                  </span>
                )}
              </div>
              <div className="wgrid">
                <Link
                  href={href("finance")}
                  className={`wt ${finSummary.dueSoonIn.length > 0 ? "" : "off"}`}
                >
                  <div className="wl">К сроку ≤ 7 дней · нам</div>
                  <div className="wv">{finSummary.dueSoonIn.length}</div>
                  <div className="wf">
                    {finSummary.dueSoonIn.length > 0 ? "напомни клиентам" : "неделя спокойна"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link
                  href={href("finance")}
                  className={`wt ${finSummary.dueSoonOut.length > 0 ? "" : "off"}`}
                >
                  <div className="wl">К сроку ≤ 7 дней · мы</div>
                  <div className="wv">{finSummary.dueSoonOut.length}</div>
                  <div className="wf">свои платежи<span className="go">→</span></div>
                </Link>
                <Link href={href("finance")} className="wt">
                  <div className="wl">Открытая дебиторка</div>
                  <div className="wv">{finSummary.receivables.total.count}</div>
                  <div className="wf">
                    {finSummary.receivables.total.uzs > 0
                      ? `≈ ${Math.round(finSummary.receivables.total.uzs).toLocaleString("ru-RU")} сум`
                      : "записей со суммой нет"}
                    <span className="go">→</span>
                  </div>
                </Link>
              </div>
            </div>
          )}

          {domain === "vendhub" && supplySummary && supplySummary.emptyPositions > 0 && (
            <div className="notice" style={{ marginTop: 16 }}>
              <b>В автоматах пусто: {supplySummary.emptyPositions} позиций</b>
              Спирали закончились — пора везти пополнение.{" "}
              <Link href={href("settings:machine_stock")} style={{ color: "var(--hot)", fontWeight: 600 }}>
                Смотреть остатки →
              </Link>
            </div>
          )}

          {domain === "vendhub" && machines.length > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Автоматы на карте</h3>
                <span className="chip b">кофе ×{coffeeMachines}</span>
                {snackMachines > 0 && <span className="chip g">снеки ×{snackMachines}</span>}
                {unknownMachines > 0 && (
                  <span className="chip">тип не указан ×{unknownMachines}</span>
                )}
              </div>
              <MapPanel machines={machines} />
              {(unknownMachines > 0 || noCoords.length > 0) && (
                <p className="hint" style={{ marginTop: 8 }}>
                  Данные неполные:{" "}
                  {unknownMachines > 0 && <>у {unknownMachines} автоматов не указан тип. </>}
                  {noCoords.length > 0 && (
                    <>
                      без координат на карте нет:{" "}
                      {noCoords.slice(0, 3).map((e, i) => (
                        <span key={e.id}>
                          {i > 0 && ", "}
                          <Link href={`/card/${e.id}`} style={{ color: "var(--accent)" }}>
                            {e.name}
                          </Link>
                        </span>
                      ))}
                      {noCoords.length > 3 && ` и ещё ${noCoords.length - 3}`}.{" "}
                    </>
                  )}
                  Тип и точка подтягиваются из учёта склада сами; остальное можно
                  дозаполнить в карточке.
                </p>
              )}
            </div>
          )}

          {domain === "vendhub" && collSummary && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Инкассация</h3>
                {collSummary.pending > 0 && <span className="chip h">ждут приёма · {collSummary.pending}</span>}
              </div>
              <div className="tiles" style={{ marginBottom: 10 }}>
                <Link
                  href={href("service")}
                  className={`tile ${collSummary.pending > 0 ? "is-hot" : "zero"}`}
                >
                  <div className="lab">Ждут приёма</div>
                  <div className="v">{collSummary.pending}</div>
                  <div className="foot"><span className="mk" />
                    {collSummary.pending > 0 ? "пересчитай и прими" : "всё принято"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("service")} className={`tile ${collSummary.receivedSum === 0 ? "zero" : ""}`}>
                  <div className="lab">Наличные · 30 дней</div>
                  <div className="v">{Number(collSummary.receivedSum).toLocaleString("ru-RU")} <span className="u">сум</span></div>
                  <div className="foot"><span className="mk" />принято инкассаций: {collSummary.receivedCount}<span className="go">→</span></div>
                </Link>
              </div>
              <p className="hint">
                Оператор пишет боту «инкассация» и выбирает автомат — сбор появляется здесь сам.
              </p>
            </div>
          )}

          {/* ── Контур: кофе-автоматы. Выручка кофе кратно больше снековой, но
                 до разбора заказов в факт панель её не показывала вовсе. ── */}
          {domain === "vendhub" && coffeeOrders !== null && coffeeOrders.всего.чашек > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Кофе-автоматы</h3>
                {coffeeOrdersStatus?.последний && (
                  <span className="chip g">данные по {when(coffeeOrdersStatus.последний)}</span>
                )}
                {coffeeOrders.неВыдано > 0 && (
                  <span className="chip h">не выдано · {coffeeOrders.неВыдано}</span>
                )}
              </div>
              <div className="wgrid">
                <div className="wt">
                  <div className="wl">Выручка за 30 дней</div>
                  <div className="wv">{Math.round(coffeeOrders.всего.выручка).toLocaleString("ru-RU")}</div>
                  <div className="wf">сум · оплаченные заказы</div>
                </div>
                <div className="wt">
                  <div className="wl">Чашек за 30 дней</div>
                  <div className="wv">{coffeeOrders.всего.чашек.toLocaleString("ru-RU")}</div>
                  <div className="wf">
                    без тестовых и бесплатных выдач
                    {coffeeOrders.vip.чашек > 0 &&
                      ` · в т.ч. VIP ${coffeeOrders.vip.чашек} шт`}
                  </div>
                </div>
                <div className="wt">
                  <div className="wl">Средний чек</div>
                  <div className="wv">{coffeeOrders.всего.среднийЧек.toLocaleString("ru-RU")}</div>
                  <div className="wf">сум за чашку</div>
                </div>
                <div className="wt">
                  <div className="wl">Автоматов торговало</div>
                  <div className="wv">{coffeeOrders.поАвтоматам.length}</div>
                  <div className="wf">
                    {coffeeOrders.поАвтоматам.length > 0
                      ? `лучший: ${coffeeOrders.поАвтоматам[0].машина}`
                      : "нет продаж"}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Контур: снек-автоматы — свои цифры и свои быстрые действия ── */}
          {domain === "vendhub" && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Снек-автоматы</h3>
                {salesSummary?.lastSaleDt && <span className="chip g">живые · OurVend</span>}
                {snackTasks > 0 && <span className="chip">задач · {snackTasks}</span>}
              </div>
              {salesSummary && salesSummary.lastSaleDt ? (
                <div className="wgrid">
                  <Link href={href("reports:sale")} className="wt">
                    <div className="wl">Выручка сегодня</div>
                    <div className="wv">{Number(salesSummary.today.amount).toLocaleString("ru-RU")}</div>
                    <div className="wf">вчера: {Number(salesSummary.yesterday.amount).toLocaleString("ru-RU")} сум<span className="go">→</span></div>
                  </Link>
                  <Link href={href("reports:sale")} className="wt">
                    <div className="wl">Продано сегодня</div>
                    <div className="wv">{Number(salesSummary.today.qty).toLocaleString("ru-RU")}</div>
                    <div className="wf">вчера: {Number(salesSummary.yesterday.qty).toLocaleString("ru-RU")}<span className="go">→</span></div>
                  </Link>
                  <Link href={href("reports:sale")} className="wt">
                    <div className="wl">За 30 дней</div>
                    <div className="wv">{Number(salesSummary.days30.amount).toLocaleString("ru-RU")}</div>
                    <div className="wf">сум · журнал продаж<span className="go">→</span></div>
                  </Link>
                  <div className="wt off">
                    <div className="wl">Оплаты Payme · Click · Uzum</div>
                    <div className="wv">—</div>
                    <div className="wf">этап 3 плана миграции</div>
                  </div>
                </div>
              ) : (
                <div className="wgrid">
                  {["Выручка сегодня", "Продажи сегодня", "За 30 дней", "Оплаты"].map((l) => (
                    <div className="wt off" key={l}>
                      <div className="wl">{l}</div>
                      <div className="wv">—</div>
                      <div className="wf">синк продаж включается на сервере</div>
                    </div>
                  ))}
                </div>
              )}
              {salesDaily !== null && salesDaily.length > 1 && (
                <>
                  <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>Выручка по дням · 30 дней:</p>
                  <MiniBars
                    bars={salesDaily.map((d) => ({
                      label: d.dt.slice(8),
                      value: d.amount,
                      title: `${d.dt}: ${Math.round(d.amount).toLocaleString("ru-RU")} сум · ${d.qty} шт`,
                    }))}
                  />
                </>
              )}
              <div style={{ marginTop: 12 }}>
                <QuickActions
                  domain={domain}
                  actions={["Пополнение автоматов", "Инкассация", "Ремонт / выезд"]}
                  defaultOwnerRef={defaultOwner?.id ?? null}
                />
              </div>
            </div>
          )}

          {/* ── Контур: кофе-бункеры — свои цифры и свои быстрые действия ── */}
          {domain === "vendhub" && (coffeeAlerts !== null || coffeeConsumption !== null) && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Кофе-бункеры</h3>
                {coffeeAlerts !== null && coffeeAlerts > 0 && <span className="chip h">внимание · {coffeeAlerts}</span>}
                {coffeeTasks > 0 && <span className="chip">задач · {coffeeTasks}</span>}
              </div>
              <div className="wgrid">
                <Link href={href("service")} className="wt">
                  <div className="wl">Сигналы (недолив · мойка)</div>
                  <div className="wv">{coffeeAlerts ?? "—"}</div>
                  <div className="wf">{coffeeAlerts === 0 ? "спокойно" : "смотреть сверку"}<span className="go">→</span></div>
                </Link>
                <Link href={href("service")} className="wt">
                  <div className="wl">Расход · 30 дней</div>
                  <div className="wv">
                    {coffeeConsumption !== null ? `${(coffeeConsumption.totalGrams / 1000).toFixed(1)} кг` : "—"}
                  </div>
                  <div className="wf">
                    {coffeeConsumption !== null && coffeeConsumption.totalCost !== null
                      ? `${Math.round(coffeeConsumption.totalCost).toLocaleString("ru-RU")} сум`
                      : "по возвратам наборов"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("service")} className="wt">
                  <div className="wl">Локаций в расходе</div>
                  <div className="wv">{coffeeConsumption !== null ? coffeeConsumption.locations.length : "—"}</div>
                  <div className="wf">за 30 дней<span className="go">→</span></div>
                </Link>
              </div>
              {coffeeWeeklyBars.length > 1 && (
                <>
                  <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>Расход по неделям (кг, по возвратам):</p>
                  <MiniBars bars={coffeeWeeklyBars} hot />
                </>
              )}
              <div style={{ marginTop: 12 }}>
                <QuickActions
                  domain={domain}
                  actions={["Чистка кофемолок", "Заливка бункеров"]}
                  defaultOwnerRef={defaultOwner?.id ?? null}
                />
              </div>
              {defaultOwner && (
                <p className="hint" style={{ marginTop: 6 }}>
                  Быстрое действие ставит задачу исполнителю: {defaultOwner.name}. Поменять можно в карточке задачи.
                </p>
              )}
            </div>
          )}

          {obligations.overdue.length > 0 && (
            <>
              <div className="section-title">
                Просрочено{obligations.overdueTotal > 20 ? ` — показаны 20 из ${obligations.overdueTotal}` : ""}
              </div>
              <div className="rows">
                {obligations.overdue.slice(0, 20).map((o) => (
                  <div className="row" key={o.id}>
                    <div className="t">
                      <b>{money(o.amount, o.currency)}</b>
                      <small>{o.status}</small>
                    </div>
                    <span className="when">{when(o.date)}</span>
                  </div>
                ))}
              </div>
              {obligations.overdueTruncated && (
                <p className="hint">
                  Всего просрочек: {obligations.overdueTotal}. Список показывает первые 200 по дате —
                  разберись со старшими, остальные подтянутся.
                </p>
              )}
            </>
          )}

          <div className="sect"><div className="sect-h"><h3 className="h2">Что заведено</h3></div>
          {entities.length === 0 ? (
            <div className="empty">
              <b>Пока пусто</b>
              Данные собираются со страниц ПО и попадают сюда после твоего «Одобрить».
            </div>
          ) : (
            <div className="wgrid">
              {groups.flatMap((g) =>
                g.leaves
                  .filter((l) => l.type !== null)
                  .map((l) => {
                    // Лист со своей таблицей (продажи, приход, остатки) счётом
                    // по реестру не измеряется — ведём на экран, а не пишем
                    // «появится после сбора» поверх готовых данных.
                    if (isTableBackedLeaf(l.type)) {
                      return (
                        <Link href={href(`${g.key}:${l.type}`)} className="wt" key={`${g.key}:${l.type}`}>
                          <div className="wl">{l.label}</div>
                          <div className="wv">·</div>
                          <div className="wf">
                            смотреть<span className="go">→</span>
                          </div>
                        </Link>
                      );
                    }
                    const n = byType[l.type!] ?? 0;
                    return n > 0 ? (
                      <Link href={href(`${g.key}:${l.type}`)} className="wt" key={`${g.key}:${l.type}`}>
                        <div className="wl">{l.label}</div>
                        <div className="wv">{n}</div>
                        <div className="wf">записей<span className="go">→</span></div>
                      </Link>
                    ) : (
                      <div className="wt off" key={`${g.key}:${l.type}`}>
                        <div className="wl">{l.label}</div>
                        <div className="wv">—</div>
                        <div className="wf">появится после сбора</div>
                      </div>
                    );
                  }),
              )}
            </div>
          )}
          </div>
        </>
      )}

      {/* ── Отчёты → По источникам: витрина; вход в детальный срез — драйв по params ── */}
      {group && leaf?.type === "sources" &&
        (sp.src || sp.rep || sp.view || sp.mode || sp.ra || sp.rb ? (
          <SourcesView base={`/domain/${domain}`} sp={sp} />
        ) : (
          <ReportsOverview base={`/domain/${domain}`} />
        ))}

      {/* ── Инкассация: живой экран VendCash (подвкладка отчётов; операционная копия — во «Обслуживании») ── */}
      {group && leaf?.type === "collection" && <CollectionsView />}

      {/* ── Журнал продаж: живые данные из mydon-stock (этап 1 миграции) ── */}
      {group && leaf?.type === "sale" && <SalesView />}

      {/* ── Расход сырья: списание из журнала продаж по рецептам (на чтении) ── */}
      {group && leaf?.type === "consumption" && <ConsumptionView />}

      {/* ── Приход и остатки: живые данные mydon-stock (этап 2 миграции) ── */}
      {group && leaf?.type === "purchase" && <PurchasesView />}
      {group && leaf?.type === "machine_stock" && <MachineStockView />}

      {/* ── Товары: журнал как в ПО владельца — поиск, категории, незаполненные ── */}
      {group && leaf?.type === "product" && (
        <>
          <ProductsBook
            items={leafItems}
            q={q ?? ""}
            cat={cat ?? ""}
            inc={inc === "1"}
            hrefBase={`/domain/${domain}`}
          />
          <NewEntityForm domain={domain} type="product" label={typeOne("product")} />
        </>
      )}

      {/* ── Склад техники: конвейер 17 статусов (перенос PROMACH) ── */}
      {domain === "globerent" && activeGroup === "units" && (
        <UnitsPanel units={units} summary={unitsSummary} clients={unitClients} />
      )}

      {/* ── Импортные контракты: завод → таможня → склад (перенос PROMACH) ── */}
      {domain === "globerent" && activeGroup === "imports" && (
        <>
          <PreordersSection preorders={preorders} clients={importSuppliers} />
          <ImportsPanel imports={importsList} suppliers={importSuppliers} />
        </>
      )}

      {/* ── Калькулятор цены HELI: движок PROMACH, расчёт в браузере ── */}
      {domain === "globerent" && activeGroup === "calc" && (
        <CalcPanel rates={calcRates} brv={calcBrv} fx={calcFx} />
      )}

      {/* ── Справочник растаможки: живые ставки ТН ВЭД + БРВ (перенос PROMACH) ── */}
      {group && leaf?.type === "customs_rates" && (
        <CustomsRatesPanel domain={domain} rates={tnved} brv={brv} />
      )}

      {/* ── Модели каталога: колонки техники подходят и моделям ── */}
      {group && leaf?.type === "equipment_model" && (
        <>
          {leafItems.length > 0 ? (
            <EquipmentBook items={leafItems} />
          ) : (
            <div className="empty">
              <b>Моделей пока нет</b>
              Заведи модели HELI (CPD30, CPCD50…) — на них ссылаются техника, КП и расчёты.
            </div>
          )}
          <NewEntityForm domain={domain} type="equipment_model" label={typeOne("equipment_model")} />
        </>
      )}

      {/* ── GLOBERENT и личный контур: документы и каталог со своими колонками ── */}
      {group && leaf?.type === "contract" && (
        <>
          {/* Живой контур продаж GLOBERENT: договор → график → оплата → акты. */}
          {domain === "globerent" && (
            <div className="sect" style={{ marginTop: 0 }}>
              <div className="sect-h">
                <h3 className="h2">Договоры купли-продажи</h3>
                {liveContracts.length > 0 && <span className="chip">{liveContracts.length}</span>}
              </div>
              {liveContracts.map((c) => {
                const total = Number(c.totalWithVat);
                const paidPct = total > 0 ? Math.min(100, Math.round((c.paidUzs / total) * 100)) : 0;
                const hot = c.status === "active" && paidPct < 100;
                return (
                  <Link href={`/contracts/${c.id}`} className={`trow ${hot ? "hot" : ""}`} key={c.id}>
                    <div className="tb">
                      <div className="tt">№ {c.contractNo}/ОП · {c.clientName ?? (c.buyer["name"] ?? "покупатель не указан")}</div>
                      <div className="tm">
                        {new Intl.NumberFormat("ru-RU").format(total)} сум ·{" "}
                        {c.status === "cancelled" ? "отменён" : c.status === "closed" ? "закрыт" : `оплачено ${paidPct}%`}
                        {c.actsCount > 0 ? ` · актов ${c.actsCount}` : ""}
                      </div>
                    </div>
                    <span className={`due ${hot ? "hot" : ""}`}>{fmtDay(c.contractDate)}</span>
                  </Link>
                );
              })}
              <div style={{ marginTop: 10 }}>
                <NewContractForm clients={contractClients} />
              </div>
            </div>
          )}
          {leafItems.length > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Собранные карточки договоров</h3>
                <span className="chip">{leafItems.length}</span>
              </div>
              <ContractsBook items={leafItems} today={todayKey} />
            </div>
          )}
          {domain !== "globerent" && leafItems.length === 0 && (
            <div className="empty">
              <b>Договоров пока нет</b>
              Добавь запись кнопкой ниже — или пришли сохранённую страницу ПО, соберу всё разом.
            </div>
          )}
          <NewEntityForm domain={domain} type="contract" label={typeOne("contract")} />
        </>
      )}
      {group && leaf?.type === "invoice" && (
        <>
          {leafItems.length > 0 ? (
            <InvoicesBook items={leafItems} />
          ) : (
            <div className="empty">
              <b>Счетов пока нет</b>
              Добавь запись кнопкой ниже — или пришли сохранённую страницу ПО, соберу всё разом.
            </div>
          )}
          <NewEntityForm domain={domain} type="invoice" label={typeOne("invoice")} />
        </>
      )}
      {group && leaf?.type === "contractor" && (
        <>
          {leafItems.length > 0 ? (
            <ContractorsBook items={leafItems} />
          ) : (
            <div className="empty">
              <b>Контрагентов пока нет</b>
              Добавь запись кнопкой ниже — или пришли сохранённую страницу ПО, соберу всё разом.
            </div>
          )}
          <NewEntityForm domain={domain} type="contractor" label={typeOne("contractor")} />
        </>
      )}
      {group && leaf?.type === "equipment" && (
        <>
          {leafItems.length > 0 ? (
            <EquipmentBook items={leafItems} />
          ) : (
            <div className="empty">
              <b>Техники пока нет</b>
              Добавь запись кнопкой ниже — или пришли сохранённую страницу ПО, соберу всё разом.
            </div>
          )}
          <NewEntityForm domain={domain} type="equipment" label={typeOne("equipment")} />
        </>
      )}

      {/* ── Рецепты: не отдельный тип, а принцип карточки товара ──
          Записей entity.type="recipe" не существует — лист годами показывал
          пустоту. Теперь это фильтр: товары с полем «вид» = «рецепт». */}
      {group && leaf?.type === "recipe" && (() => {
        const рецепты = entities
          .filter((e) => e.type === "product" && (e.attrs ?? {})["вид"] === "рецепт")
          .sort((a, b) => a.name.localeCompare(b.name, "ru"));
        return рецепты.length > 0 ? (
          <>
            <div className="book">
              <div className="th">
                <span>Товар с рецептом</span>
                <span>Код</span>
                <span style={{ textAlign: "right" }}>Цена</span>
              </div>
              {рецепты.map((e) => {
                const price = (e.attrs ?? {})["цена"];
                return (
                  <Link href={`/card/${e.id}`} className="tr" key={e.id}>
                    <span className="nm">{e.name}</span>
                    <span className="cd">{String((e.attrs ?? {})["ИКПУ"] ?? "")}</span>
                    <span className="pr">
                      {typeof price === "number"
                        ? <>{Number(price).toLocaleString("ru-RU")} <span className="u">сум</span></>
                        : "—"}
                    </span>
                  </Link>
                );
              })}
            </div>
            <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
              {рецепты.length} товаров с рецептом · состав и себестоимость — на карточке товара
            </p>
          </>
        ) : (
          <div className="empty">
            <b>Товаров с рецептом пока нет</b>
            Рецепт — принцип карточки товара: поле «вид» = «рецепт», состав задаётся на карточке.
          </div>
        );
      })()}

      {/* ── Группа: записи выбранной подвкладки ── */}
      {group && leaf?.type && !["sources", "collection", "sale", "product", "purchase", "machine_stock", "consumption", "contract", "invoice", "contractor", "equipment", "equipment_model", "customs_rates", "recipe"].includes(leaf.type) && (
        <>
          {leafItems.length > 0 ? (
            <>
              <div className="book">
                <div className="th">
                  <span>Название</span>
                  <span>Код</span>
                  <span style={{ textAlign: "right" }}>{leaf.type === "product" ? "Цена" : "Номер"}</span>
                </div>
                {leafItems.map((e) => {
                  const price = (e.attrs ?? {})["цена"];
                  return (
                    <Link href={`/card/${e.id}`} className="tr" key={e.id}>
                      <span className="nm">{e.name}</span>
                      <span className="cd">{String((e.attrs ?? {})["ИКПУ"] ?? (e.attrs ?? {})["код"] ?? "")}</span>
                      <span className="pr">
                        {typeof price === "number"
                          ? <>{Number(price).toLocaleString("ru-RU")} <span className="u">сум</span></>
                          : (e.externalRef ?? "—")}
                      </span>
                    </Link>
                  );
                })}
              </div>
              <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>{leafItems.length} записей</p>
            </>
          ) : (
            <div className="empty">
              <b>{leaf.label}: данных пока нет</b>
              Добавь запись кнопкой ниже — или пришли сохранённую страницу ПО,
              соберу всё разом.
            </div>
          )}
          <NewEntityForm domain={domain} type={leaf.type} label={typeOne(leaf.type)} />
        </>
      )}
      {group && !leaf?.type && (
        <div className="empty">
          <b>{leaf?.label}: данных пока нет</b>
          Появятся после сбора со страницы ПО.
        </div>
      )}

      {/* ── HR (VendHub) / Команда направления (остальные направления) ──
          У VendHub вкладка «Команда» переехала под «HR» (восьмёрка владельца);
          у остальных направлений состав вкладок не меняется — они всё ещё
          приходят сюда ключом "team", поэтому рендерим оба ключа одним блоком.
          "hr" гейтится доменом: вне VendHub этот ключ недостижим (ревью). */}
      {((domain === "vendhub" && activeGroup === "hr") || activeGroup === "team") && (
        <>
          {activeGroup === "hr" && (
            <p className="hint" style={{ marginBottom: 12 }}>
              HR — люди и оценка работы. Оценка объёмов — следующим этапом.
            </p>
          )}
          {ourPeople.length === 0 ? (
            <div className="empty">
              <b>В этом направлении пока никого</b>
              Назначь сотруднику направление в его карточке — он появится здесь.
            </div>
          ) : (
            <div>
              {ourPeople.map((p) => (
                <Link href={`/team/${p.id}`} className="prow" key={p.id}>
                  <span className="av2">{p.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>
                  <div className="pb">
                    <div className="pn">{p.name}</div>
                    <div className="pr2">{p.role ?? "роль не указана"}</div>
                  </div>
                  {p.tgChatId ? <span className="tag-tg">в Telegram</span> : <span className="chip">не подключён</span>}
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Задачи направления ── */}
      {activeGroup === "tasks" &&
        (openTasks.length === 0 ? (
          <div className="empty">
            <b>Открытых задач нет</b>
            Задачи с этим направлением появятся здесь.
          </div>
        ) : (
          <div>
            {openTasks.map((t) => {
              const late = t.due !== null && new Date(t.due).getTime() < Date.now();
              return (
                <Link href={`/tasks/${t.id}`} className={`trow ${late ? "hot" : ""}`} key={t.id}>
                  <div className="tb"><div className="tt">{t.title}</div></div>
                  <span className={`due ${late ? "hot" : ""}`}>{dueLabel(t.due)}</span>
                </Link>
              );
            })}
          </div>
        ))}
    </>
  );
}
