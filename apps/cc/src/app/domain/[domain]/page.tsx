import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  DOMAINS,
  DOMAIN_LABELS,
  cardPrice,
  contractorInDirection,
  coffeeRefillToFeed,
  collectionToFeed,
  dueLabel,
  isMachineStatus,
  machineSerialKeys,
  machineStatusLabel,
  mergeServiceFeed,
  pricePerGram,
  resolveActor,
  vendingRefillToFeed,
  type Domain,
  type ServiceFeedItem,
} from "@mydon/shared";
import {
  core,
  CoreUnavailable,
  type BrvValue,
  type CoffeeBunkerIngredient,
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
import { ProductsBook, isIncomplete } from "../../../components/products-book";
import { ListShell, type ListShellKpi } from "../../../components/list-shell";
import { MachineStockView, PurchasesView } from "../../../components/supply-views";
import { MapPanel } from "../../../components/map-panel";
import { MiniBars } from "../../../components/mini-bars";
import { QuickActions } from "../../../components/quick-actions";
import { SourcesView } from "../../../components/sources-view";
import { ReportsOverview } from "../../../components/reports-overview";
import { VendingMachinesPanel, VendingSupplyPanel } from "../../../components/vending-panel";
import { CoffeePanel } from "../../../components/coffee-panel";
import { ServiceTab, type ServiceAction, type ServiceKpiTile } from "../../../components/service-tab";
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

/** «24 июн» по Ташкенту — для KPI «Деньги не сняты с …» (без точки после месяца). */
function shortRuDate(iso: string): string {
  return new Date(iso)
    .toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent", day: "numeric", month: "short" })
    .replace(/\.$/, "");
}

/** Потолок `GET /coffee/refill/recent` (coffee.controller.ts): выше сервер не отдаёт. */
const COFFEE_REFILL_LIMIT = 200;

/**
 * Чип источника задачи (Task 10) — по значению `Task.source`, единственному
 * полю происхождения в типе (`createdFrom`/`origin` в нём нет). Реальные
 * значения из кода-создателя задач и живых данных: `null`/`"owner"` —
 * владелец (ручное создание в CC и заявки «Поломка» из бота — источник у
 * обеих не отличить друг от друга по этому полю, отсюда общая метка);
 * `maint:<planId>` и `recurring:*` — график (ТО-план/повторяющаяся); `maintenance-monitor` /
 * `coffee-monitor` / `coffee-alert` — из «Обслуживания» (авто-задачи по
 * недоливу/лёгким бункерам). Прочее — сырое значение как есть, а не молчание
 * (лучше показать код источника, чем выдумать несуществующую категорию).
 */
function taskSourceLabel(source: string | null): string {
  if (source === null || source === "owner") return "владелец";
  if (source.startsWith("maint:") || source.startsWith("recurring:")) return "график";
  if (source === "maintenance-monitor" || source === "coffee-monitor" || source === "coffee-alert") {
    return "обслуживание";
  }
  return source;
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
  let supplySummary: Awaited<ReturnType<typeof core.supplySummary>> | null = null;
  let salesDaily: Awaited<ReturnType<typeof core.salesDaily>> | null = null;
  // Плитки «Предприятие»/«Парк» на дашборде: деньги в автоматах, пустые
  // спирали, карточки парка. Новые эндпоинты core (эта ветка ещё не выкачена
  // на прод-ядро) — провал (в т.ч. 404) не роняет дашборд, плитка покажет «—».
  let cashEstimate: Awaited<ReturnType<typeof core.cashEstimate>> | null = null;
  let vendingDeficit: Awaited<ReturnType<typeof core.vendingDeficit>> | null = null;
  let machineCards: Awaited<ReturnType<typeof core.machineCards>> | null = null;
  if (domain === "vendhub" && isOverview) {
    [salesSummary, supplySummary, salesDaily, cashEstimate, vendingDeficit, machineCards] = await Promise.all([
      core.salesSummary().catch(() => null),
      core.supplySummary().catch(() => null),
      core.salesDaily(30).catch(() => null),
      core.cashEstimate().catch(() => null),
      core.vendingDeficit().catch(() => null),
      core.machineCards().catch(() => null),
    ]);
  } else if (domain === "vendhub" && activeGroup === "settings" && activeLeaf === "machine" && sp.status) {
    // Панель «Автоматы» (C1) отдаёт уже отфильтрованный по ?status= список —
    // карточки вида нужны здесь же, а не только на дашборде.
    machineCards = await core.machineCards().catch(() => null);
  }
  const openTasks = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");

  // ── Задачи: мини-KPI вкладки TASKS (Task 10) — стиль как у ACTIVITY (.wgrid/.wt),
  // только vendhub и только на самой вкладке (лишний запрос overdue на других
  // вкладках/направлениях ни к чему). "Просрочено" тянет /tasks/overdue —
  // эндпоинт общий по организации (без фильтра домена), поэтому пересекаем
  // с доменом на клиенте, как и остальные best-effort блоки этой страницы.
  let taskKpi: { label: string; value: string; hot?: boolean }[] = [];
  if (domain === "vendhub" && activeGroup === "tasks") {
    const tasksOverdueRows = await core.tasksOverdue().catch(() => null);
    const overdueCount =
      tasksOverdueRows === null ? null : tasksOverdueRows.filter((t) => t.domain === "vendhub").length;
    // ownerRef === "" тоже "свободная" — исторические записи до нормализации
    // "" → null на создании (tasks.service.ts) могли осесть в базе пустой
    // строкой, а не null.
    const unassignedCount = openTasks.filter((t) => t.ownerRef === null || t.ownerRef.trim() === "").length;
    // «За неделю» — та же скользящая граница (сейчас минус 168 часов), что
    // и doneLast7d на сервере (tasks.service.ts), а не календарный день:
    // окно в 7×24 часа не зависит от часового пояса подсчёта.
    const weekAgoMs = Date.now() - 7 * 24 * 3600_000;
    // completedAt — единственное поле-дата закрытия у Task (updatedAt в типе
    // нет); status "done" + completedAt в окне — тот же признак, что у
    // серверного doneLast7d, поэтому цифра не выдумана, а согласована с ним.
    const closedThisWeek = tasks.filter(
      (t) => t.status === "done" && t.completedAt !== null && new Date(t.completedAt).getTime() >= weekAgoMs,
    ).length;
    taskKpi = [
      { label: "Открыто", value: String(openTasks.length) },
      {
        label: "Просрочено",
        value: overdueCount === null ? "—" : String(overdueCount),
        hot: (overdueCount ?? 0) > 0,
      },
      {
        label: "Свободных (без исполнителя)",
        value: String(unassignedCount),
        hot: unassignedCount > 0,
      },
      { label: "Закрыто за неделю", value: String(closedThisWeek) },
    ];
  }

  if (domain === "vendhub") {
    // Тридцать календарных суток по Ташкенту, а не 720 часов от «сейчас»:
    // скользящее окно смещало бы границу внутрь чужого дня, и утренняя
    // сводка расходилась бы с вечерней без единой новой продажи.
    const с = new Date(Date.now() - 30 * 24 * 3600 * 1000).toLocaleDateString("en-CA", {
      timeZone: "Asia/Tashkent",
    });
    // coffeeOrdersStatus (статус синка) читался только снятой секцией
    // «Кофе-автоматы» и нигде больше не используется — запрос убран вместе
    // с переменной, а не просто перестал захватываться.
    coffeeOrders = await core.coffeeOrdersSummary(с).catch(() => null);
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

  // `status` — доп. фильтр парка (C1: плитки «Парк» → settings:machine&status=…),
  // добавляется ПОСЛЕ tab, не заменяя его.
  const href = (t: string, status?: string) =>
    `/domain/${domain}?tab=${encodeURIComponent(t)}${status ? `&status=${encodeURIComponent(status)}` : ""}`;

  // ── верхний ряд вкладок ────────────────────────────────────────────────────
  const teamLabel = `Команда${ourPeople.length > 0 ? ` ${ourPeople.length}` : ""}`;
  const tasksLabel = `Задачи${openTasks.length > 0 ? ` ${openTasks.length}` : ""}`;
  // Подписи вкладок VendHub латиницей (слово владельца, 20.08.2026; контент внутри вкладок остаётся русским)
  const VENDHUB_TAB_LABELS: Record<string, string> = {
    overview: "DASHBOARD",
    service: "ACTIVITY",
    tasks: "TASKS",
    reports: "REPORTS",
    smm: "SMM",
    crm: "CRM",
    hr: "HR",
    settings: "SETTINGS",
  };

  const applyVendHubLabels = (tabs: Array<{ key: string; label: string }>) => {
    return tabs.map((tab) => {
      const newLabel = VENDHUB_TAB_LABELS[tab.key];
      if (!newLabel) return tab;
      // Сохраняем счётчик (число в конце подписи), если оно есть
      const counterMatch = tab.label.match(/\s(\d+)$/);
      return {
        ...tab,
        label: counterMatch ? `${newLabel} ${counterMatch[1]}` : newLabel,
      };
    });
  };

  const topTabs =
    domain === "vendhub"
      ? // Восьмёрка владельца (слово владельца, 20.08.2026) — порядок задан явно,
        // не через groups-порядок (settings/reports там идут иначе). «Задачи» и
        // подписи «Отчёты»/«Настройки» переиспользуют существующие ключи —
        // только переставлены, не задублированы. Подписи переопределяются в VENDHUB_TAB_LABELS.
        applyVendHubLabels([
          { key: "overview", label: "Дашборд" },
          { key: "service", label: "Обслуживание" },
          { key: "tasks", label: tasksLabel },
          { key: "reports", label: groups.find((g) => g.key === "reports")?.label ?? "Отчёты" },
          { key: "smm", label: "SMM" },
          { key: "crm", label: "CRM" },
          { key: "hr", label: `HR${ourPeople.length > 0 ? ` ${ourPeople.length}` : ""}` },
          { key: "settings", label: groups.find((g) => g.key === "settings")?.label ?? "Настройки" },
        ])
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

  // Ингредиенты (settings): бункерный конфиг — источник моста `entityId`
  // (миграция 0059) для KPI «Связано с бункерами». null — эндпоинт недоступен
  // (честное «нет данных»), не «связей нет». Пустой массив/entityId=null у всех
  // строк (миграция ещё не на проде) — это НЕ провал запроса, а нормальный
  // текущий ответ Core: KPI обязан посчитать 0, а не подменить его прочерком.
  let bunkerConfig: CoffeeBunkerIngredient[] | null = null;
  if (group && leaf?.type === "ingredient") {
    bunkerConfig = await core.coffeeBunkerConfig().catch(() => null);
  }

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

  // ── ACTIVITY (Обслуживание) целиком: мини-KPI + единая лента полевых
  // событий трёх источников (mergeServiceFeed + адаптеры, Task 8). Каждый
  // источник — свой Promise, провал одного (в т.ч. эндпоинтов, которых ещё
  // может не быть на проде) не роняет вкладку и не обнуляет чужие KPI/ленту —
  // правило best-effort, как у остальных ленивых блоков этой страницы.
  let serviceKpi: ServiceKpiTile[] = [];
  let serviceFeed: ServiceFeedItem[] = [];
  const SERVICE_ACTIONS: ServiceAction[] = [
    { icon: "☕", title: "Пополнить кофе-точку", subtitle: "точка → бункеры подряд → веса · как в боте", href: "#coffee" },
    { icon: "🍫", title: "Пополнить снек-точку", subtitle: "точка → спирали → количества", href: "#snack" },
    { icon: "💵", title: "Инкассация", subtitle: "автомат → сумма · весь парк, не только рабочие", href: "#cash" },
  ];
  if (domain === "vendhub" && activeGroup === "service") {
    let recentRefills: Awaited<ReturnType<typeof core.recentCoffeeRefills>> | null = null;
    let bunkerConfig: Awaited<ReturnType<typeof core.coffeeBunkerConfig>> | null = null;
    let fillStatus: Awaited<ReturnType<typeof core.coffeeFillStatus>> | null = null;
    let serviceDeficit: Awaited<ReturnType<typeof core.vendingDeficit>> | null = null;
    let refillRows: Awaited<ReturnType<typeof core.vendingRefillList>> | null = null;
    let collRows: Awaited<ReturnType<typeof core.collections>> | null = null;
    [recentRefills, bunkerConfig, fillStatus, serviceDeficit, refillRows, collRows] = await Promise.all([
      // Лимит 200 — потолок эндпоинта (coffee.controller.ts: Math.min(Math.max(limit,1),200)).
      // Одна и та же выборка кормит и счётчик «сегодня», и ленту — ленту резать
      // отдельно не нужно, mergeServiceFeed сам ограничивает итог 50 строками
      // (Task 9 ревью, находка 2: на лимите 50 «сегодня» молча недосчитывало
      // дни с активной заливкой более чем на 50 бункеров).
      core.recentCoffeeRefills(COFFEE_REFILL_LIMIT).catch(() => null),
      core.coffeeBunkerConfig().catch(() => null),
      core.coffeeFillStatus().catch(() => null),
      core.vendingDeficit().catch(() => null),
      core.vendingRefillList(100).catch(() => null),
      core.collections({ days: "365" }).catch(() => null),
    ]);

    // «Залито сегодня» — заливки кофе-бункеров, день createdAt по Ташкенту
    // совпадает с сегодняшним (тот же todayKey, что у GLOBERENT ниже).
    const filledToday =
      recentRefills === null
        ? null
        : recentRefills.filter(
            (r) => new Date(r.createdAt).toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" }) === todayKey,
          ).length;
    // Пришло ровно столько строк, сколько разрешает эндпоинт, — значит за
    // сегодня могло быть больше, чем видно в этой выборке (более старые
    // заливки сегодняшнего дня уже могли не поместиться). Честная оговорка
    // вместо тихого недосчёта (Task 9 ревью, находка 2).
    const filledTodayCapped = recentRefills !== null && recentRefills.length === COFFEE_REFILL_LIMIT;

    // «Точек ждёт визита» — уникальные точки со status="underfill". Пустой
    // ответ ИЛИ ответ, где ни для одной точки эталон не задан (весь список —
    // status="unknown"), — это не «недолива нет нигде», а «нечего сравнивать»:
    // плитка тогда показывает «—», а не обманчивый ноль.
    const hasAnyTarget = fillStatus !== null && fillStatus.some((r) => r.status !== "unknown");
    const underfillLocations = fillStatus === null || !hasAnyTarget
      ? null
      : new Set(fillStatus.filter((r) => r.status === "underfill").map((r) => r.locationId)).size;
    const waitingVisitsFoot =
      fillStatus === null ? "нет данных" : !hasAnyTarget ? "эталоны не заданы" : "уникальных точек с недоливом";

    const emptySpirals = serviceDeficit === null ? null : serviceDeficit.length;

    // «Деньги не сняты» — максимум receivedAt по принятым инкассациям за год;
    // источник пустой (но живой) — «ни разу», источник недоступен — «—».
    const lastReceivedAt = (collRows ?? []).reduce<string | null>((max, c) => {
      if (c.status !== "received" || !c.receivedAt) return max;
      return max === null || new Date(c.receivedAt).getTime() > new Date(max).getTime() ? c.receivedAt : max;
    }, null);
    const moneyValue =
      collRows === null ? "—" : lastReceivedAt === null ? "ни разу" : `с ${shortRuDate(lastReceivedAt)}`;

    serviceKpi = [
      {
        label: "Залито сегодня",
        value: filledToday === null ? "—" : `${filledToday} ${plural(filledToday, "бункер", "бункера", "бункеров")}`,
        foot:
          recentRefills === null
            ? "нет данных"
            : filledTodayCapped
              ? `за сегодня, до ${COFFEE_REFILL_LIMIT} записей`
              : "заливок кофе-бункеров сегодня",
      },
      {
        label: "Точек ждёт визита",
        value: underfillLocations === null ? "—" : String(underfillLocations),
        hot: (underfillLocations ?? 0) > 0,
        foot: waitingVisitsFoot,
      },
      {
        label: "Снек: пустые спирали",
        value: emptySpirals === null ? "—" : String(emptySpirals),
        hot: (emptySpirals ?? 0) > 0,
        foot: serviceDeficit === null ? "нет данных" : "товаров нет ни в одном автомате",
      },
      {
        label: "Деньги не сняты",
        value: moneyValue,
        foot: collRows === null ? "нет данных" : "дата последней принятой инкассации по парку",
      },
    ];

    // Кофе → лента: имя ингредиента в строке заливки не хранится (только
    // ingredientId) — резолвим по конфигу бункеров (Task 8 ревью, пункт 1).
    const ingredientNameById = new Map<string, string>();
    for (const b of bunkerConfig ?? []) ingredientNameById.set(b.ingredientId, b.ingredientName);
    const coffeeFeedItems = (recentRefills ?? []).map((r) =>
      coffeeRefillToFeed({
        locationName: r.locationName,
        position: r.position,
        ingredientName: r.ingredientId ? (ingredientNameById.get(r.ingredientId) ?? null) : null,
        filledWeight: r.filledWeight,
        createdAt: r.createdAt,
        // `createdBy` в журнале — сырая ссылка (`person:<uuid>`/`import:*`/`bot`),
        // не имя (I1 ревью) — разворачиваем в читаемое имя сотрудника.
        createdBy: resolveActor(r.createdBy, people),
      }),
    );

    // Снек → лента: /vending/refills отдаёт построчные записи по слоту, без
    // группировки и без имени автомата — склеиваем сами в визиты (см. ниже)
    // и резолвим имя по реестру (Task 8 ревью, пункт 3). Серийник приходит
    // в форме Ourvend, карточка может хранить другую форму (mydon-stock) —
    // сверяем через machineSerialKeys.
    const machineNameBySerial = new Map<string, string>();
    for (const m of machines) {
      for (const key of machineSerialKeys(m.externalRef)) machineNameBySerial.set(key, m.name);
    }
    const resolveMachineName = (serial: string): string | null => {
      for (const key of machineSerialKeys(serial)) {
        const name = machineNameBySerial.get(key);
        if (name) return name;
      }
      return null;
    };
    // Склейка по разрыву, а не по минутным корзинам: реальный визард в поле
    // (точка → спирали подряд → количества) идёт МИНУТАМИ, и жёсткая минутная
    // корзина рвёт один визит на несколько строк ленты, как только ответ
    // техника растягивается дольше 60 секунд — performedAt на каждую строку
    // ставит сервер в момент своего ответа, а не момент начала визита
    // (Task 9 ревью, находка 1). Правило: строки одного автомата, отсортированные
    // по performedAt, — один визит, пока разрыв между СОСЕДНИМИ строками
    // не превышает 15 минут; больший разрыв — новый визит. ts визита —
    // performedAt первой строки визита.
    const VISIT_GAP_MS = 15 * 60_000;
    const rowsByMachine = new Map<string, NonNullable<typeof refillRows>>();
    for (const row of refillRows ?? []) {
      const list = rowsByMachine.get(row.machineSerial);
      if (list) list.push(row);
      else rowsByMachine.set(row.machineSerial, [row]);
    }
    const vendingVisits: { machineSerial: string; createdAt: string; positions: number; units: number; createdBy: string | null }[] = [];
    for (const [serial, rows] of rowsByMachine) {
      const sorted = [...rows].sort(
        (a, b) => new Date(a.performedAt).getTime() - new Date(b.performedAt).getTime(),
      );
      let current: (typeof vendingVisits)[number] | null = null;
      let lastTs = 0;
      for (const row of sorted) {
        const ts = new Date(row.performedAt).getTime();
        if (current && ts - lastTs <= VISIT_GAP_MS) {
          current.positions += 1;
          current.units += row.qty;
        } else {
          current = { machineSerial: serial, createdAt: row.performedAt, positions: 1, units: row.qty, createdBy: row.createdBy };
          vendingVisits.push(current);
        }
        lastTs = ts;
      }
    }
    const snackFeedItems = vendingVisits.map((g) =>
      vendingRefillToFeed({
        machineName: resolveMachineName(g.machineSerial),
        createdAt: g.createdAt,
        positions: g.positions,
        units: g.units,
        createdBy: resolveActor(g.createdBy, people),
      }),
    );

    // Деньги → лента: та же выборка, что и KPI — приняли (с суммой) и ждут
    // приёма (amount ещё null) идут в общую хронологию; отменённые сборы
    // (ошибочная фиксация) в ленту не идут — иначе адаптер подпишет их «сумма
    // не введена», как будто сбор ещё ждёт приёма (Task 8 ревью, пункт 2:
    // amount строкой decimal, приводим к числу перед адаптером).
    const cashFeedItems = (collRows ?? [])
      .filter((c) => c.status !== "cancelled")
      .map((c) =>
        collectionToFeed({
          machineName: c.machineName,
          collectedAt: c.collectedAt,
          amount: c.amount === null ? null : Number(c.amount),
          // Уже имя из SQL-джойна на person (collections.service.ts) — resolveActor
          // здесь страховка на случай сырой ссылки, а не основной путь.
          operatorName: resolveActor(c.operatorName, people),
        }),
      );

    serviceFeed = mergeServiceFeed([coffeeFeedItems, snackFeedItems, cashFeedItems]);
  }

  // Хлебные крошки и чип маршрута (расположение из обложки): где я и как это
  // адресуется. Счётчик из подписи вкладки для крошки убираем — «Задачи 6» → «Задачи».
  const activeTab = topTabs.find((t) => t.key === activeGroup);
  const crumbLabel =
    activeTab && activeGroup !== "overview" ? activeTab.label.replace(/\s+\d+$/, "") : null;
  const routeSlug = activeGroup === "overview" ? "" : activeGroup;
  const routePath = `/${domain}${routeSlug ? `/${routeSlug}` : ""}${activeLeaf ? `/${activeLeaf}` : ""}`;

  // ── Дашборд VendHub: производные для секций «Предприятие»/«Парк»/«Деньги и
  //    партнёры»/«График» (перекомпоновка overview). Всё best-effort: любой
  //    источник может быть null (провал запроса или эндпоинт ещё не на проде) —
  //    плитка тогда показывает «—», а не роняет остальные секции.
  const coffeeRevenue30 = coffeeOrders?.всего.выручка ?? null;
  const snackRevenue30 = salesSummary?.days30.amount ?? null;
  const hasRevenue30 = coffeeRevenue30 !== null || snackRevenue30 !== null;
  const revenue30 = (coffeeRevenue30 ?? 0) + (snackRevenue30 ?? 0);
  const deficitCount = vendingDeficit?.length ?? 0;
  const notIssuedCount = coffeeOrders?.неВыдано ?? 0;
  const attentionTotal = deficitCount + notIssuedCount + openTasks.length;
  // I3: сколько автоматов ни разу не инкассировались — оценка «Деньги в
  // автоматах» по ним идёт за всю историю, а не с последнего сбора.
  const cashNoCollectionCount = cashEstimate?.поАвтоматам.filter((m) => m.с === null).length ?? 0;

  const contractorTurnover = (e: Entity): number | null => {
    const v = (e.attrs ?? {})["оборот по реестру"];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const topContractor = contractorsLoaded
    ? [...contractors]
        .filter((e) => contractorTurnover(e) !== null)
        .sort((a, b) => (contractorTurnover(b) as number) - (contractorTurnover(a) as number))[0] ?? null
    : null;
  const coffeeTopProducts = coffeeOrders?.поТоварам ?? [];

  // Парк считается по СУЩНОСТЯМ автоматов, а статус берётся из карточки;
  // автомат без карточки — «в работе» (карточка фиксирует отклонение).
  // Тот же источник и то же правило использует отбор ?status= на листе
  // «Автоматы» (ниже), иначе цифра на плитке и список по клику расходятся.
  const cardByEntity = new Map((machineCards ?? []).map((c) => [c.entityId, c]));
  const parkStatusOf = (entityId: string): string => cardByEntity.get(entityId)?.status || "in_service";
  const parkInService = machines.filter((e) => parkStatusOf(e.id) === "in_service");
  const parkWarehouse = machines.filter((e) => parkStatusOf(e.id) === "warehouse");
  const parkRepair = machines.filter((e) => parkStatusOf(e.id) === "repair");
  // Явный подсчёт по виду, а не вычитанием: kind === "other"/"drink"/"combo"/
  // не размечен молча утекал бы в «снек» и врал про состав парка.
  const parkInServiceCoffee = parkInService.filter((e) => cardByEntity.get(e.id)?.kind === "coffee").length;
  const parkInServiceSnack = parkInService.filter((e) => cardByEntity.get(e.id)?.kind === "snack").length;
  const parkInServiceOther = parkInService.length - parkInServiceCoffee - parkInServiceSnack;
  const cupsPerMachine =
    coffeeOrders !== null
      ? Math.round(coffeeOrders.всего.чашек / Math.max(1, coffeeOrders.поАвтоматам.length))
      : null;

  // График «Выручка по дням»: снек (salesDaily) + кофе (coffeeOrders.поДням) —
  // единый ряд по дате, суммируем в один Map; день без продаж одного контура
  // просто не добавляет к сумме (эквивалент 0), а не роняет весь ряд.
  const revenueByDayMap = new Map<string, number>();
  for (const d of salesDaily ?? []) revenueByDayMap.set(d.dt, (revenueByDayMap.get(d.dt) ?? 0) + Number(d.amount));
  for (const d of coffeeOrders?.поДням ?? [])
    revenueByDayMap.set(d.день, (revenueByDayMap.get(d.день) ?? 0) + Number(d.выручка));
  const revenueByDay = [...revenueByDayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

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

      {/* ── ACTIVITY: KPI + действия + единая лента (Task 9), формы ввода ниже под якорями ── */}
      {domain === "vendhub" && activeGroup === "service" && (
        <>
          <ServiceTab
            kpi={serviceKpi}
            feed={serviceFeed}
            actions={SERVICE_ACTIONS}
            // I5: нумерация бункеров и наборов настраивается в CoffeePanel —
            // он ниже на этой же вкладке (#coffee), а не в «Настройках».
            referenceHref="#coffee"
          />
          <div className="sect" id="coffee" data-toc="Кофе">
            <div className="sect-h"><h3 className="h2">Кофе-бункеры</h3></div>
            <CoffeePanel defaultOwnerRef={defaultOwner?.id ?? null} />
          </div>
          <div className="sect" id="snack" data-toc="Снек">
            <div className="sect-h"><h3 className="h2">Пополнение снека</h3></div>
            <VendingSupplyPanel />
          </div>
          <div className="sect" id="cash" data-toc="Инкассация">
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
          {/* I4 (ревью 20.08.2026): у VendHub этот легаси-ряд обязательств
              дублирует «Предприятие»/«Требует внимания» ниже и живую строку
              открытых задач в шапке — оставлен только для остальных направлений
              (GLOBERENT и т.д.), где своей сводки по обязательствам ещё нет. */}
          {domain !== "vendhub" && (
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
                  {/* Этот легаси-ряд у VendHub не рендерится (I4) — разбивку
                      кофе/снек показывать здесь уже некому, у остальных
                      направлений признака контура нет. */}
                  {openTasks.length === 0 ? "задач нет" : "по направлению"}
                  <span className="go">→</span>
                </div>
              </Link>
            </div>
          )}

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

          {/* I4 (ревью 20.08.2026): тревога «В автоматах пусто» снята — её
              покрывают плитка «Требует внимания» (пусто {deficitCount}) и
              «Пустые позиции» в блоке «Снек» ниже; дублировать её отдельным
              баннером незачем. */}

          {/* ── Предприятие: сводка на уровне направления, а не одного контура ── */}
          {domain === "vendhub" && (
            <div className="sect">
              <div className="sect-h"><h3 className="h2">Предприятие</h3></div>
              <div className="wgrid">
                <div className={`wt ${hasRevenue30 ? "" : "off"}`}>
                  <div className="wl">Выручка · 30 дней</div>
                  <div className="wv">{hasRevenue30 ? Math.round(revenue30).toLocaleString("ru-RU") : "—"}</div>
                  <div className="wf">
                    {hasRevenue30
                      ? `кофе ${((coffeeRevenue30 ?? 0) / 1_000_000).toFixed(1)} + снек ${((snackRevenue30 ?? 0) / 1_000_000).toFixed(1)} млн`
                      : "нет данных"}
                  </div>
                </div>
                <div className={`wt ${coffeeOrders ? "" : "off"}`}>
                  <div className="wl">Средний чек кофе</div>
                  <div className="wv">{coffeeOrders ? coffeeOrders.всего.среднийЧек.toLocaleString("ru-RU") : "—"}</div>
                  <div className="wf">сум за чашку · маржа — в отчёте «Себестоимость»</div>
                </div>
                {/* I3: плитка = вопрос («сколько?»), клик = ответ (details — по
                    автомату). Период — с последней ПРИНЯТОЙ инкассации; для
                    автоматов без единой инкассации оценка идёт за всю историю
                    продаж (честно посчитано, а не отсутствие данных). */}
                <details className={`wt cash-estimate ${cashEstimate ? "" : "off"}`}>
                  <summary>
                    <div className="wl">Деньги в автоматах ≈</div>
                    <div className="wv">{cashEstimate ? Math.round(cashEstimate.всего).toLocaleString("ru-RU") : "—"}</div>
                    <div className="wf">
                      {cashEstimate
                        ? `с последней принятой инкассации по каждому автомату${
                            cashNoCollectionCount > 0
                              ? `; у ${cashNoCollectionCount} без инкассаций — за всю историю`
                              : ""
                          }`
                        : "нет данных"}
                    </div>
                  </summary>
                  {cashEstimate && cashEstimate.поАвтоматам.length > 0 && (
                    <div className="rows" style={{ marginTop: 10 }}>
                      {[...cashEstimate.поАвтоматам]
                        .sort((a, b) => b.сумма - a.сумма)
                        .map((m) => (
                          <div className="row" key={m.machineId}>
                            <div className="t">
                              <b>{m.имя ?? "—"}</b>
                              <small>{m.с === null ? "за всю историю" : `с ${shortRuDate(m.с)}`}</small>
                            </div>
                            <span className="pill">{m.сумма.toLocaleString("ru-RU")} сум</span>
                          </div>
                        ))}
                    </div>
                  )}
                </details>
                <Link href={href("service")} className={`wt ${attentionTotal > 0 ? "is-hot" : ""}`}>
                  <div className="wl">Требует внимания</div>
                  <div className="wv">{attentionTotal}</div>
                  <div className="wf">
                    пусто {deficitCount} · не выдано {notIssuedCount} · задачи {openTasks.length}
                    <span className="go">→</span>
                  </div>
                </Link>
              </div>
            </div>
          )}

          {/* ── Быстрые действия: подняты из подвала контуров — под цифрами предприятия ── */}
          {domain === "vendhub" && (
            <div className="sect">
              <div className="sect-h"><h3 className="h2">Быстрые действия</h3></div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                <QuickActions
                  domain={domain}
                  actions={["Пополнение автоматов", "Инкассация", "Ремонт / выезд"]}
                  defaultOwnerRef={defaultOwner?.id ?? null}
                />
                <Link href={href("tasks")} className="btn sm">+ Задача</Link>
              </div>
            </div>
          )}

          {/* ── Контуры: кофе и снек — сжато до 2+2 виджетов по канвасу
                 (design/dashboard-redesign/Main.dc.html). Полные цифры и
                 быстрые действия контуров — на вкладке «Обслуживание» и в
                 «Отчётах», overview даёт только пульс. ── */}
          {domain === "vendhub" && (
            <div className="sect">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18 }}>
                <div>
                  <div className="sect-h">
                    <h3 className="h2">Кофе</h3>
                    {coffeeOrders !== null && coffeeOrders.неВыдано > 0 && (
                      <span className="chip h">не выдано · {coffeeOrders.неВыдано}</span>
                    )}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <Link href={href("service")} className={`wt ${coffeeOrders ? "" : "off"}`}>
                      <div className="wl">Чашек · 30 дней</div>
                      <div className="wv">{coffeeOrders ? coffeeOrders.всего.чашек.toLocaleString("ru-RU") : "—"}</div>
                      <div className="wf">
                        {coffeeOrders ? `чек ${coffeeOrders.всего.среднийЧек.toLocaleString("ru-RU")} сум` : "нет данных"}
                        <span className="go">→</span>
                      </div>
                    </Link>
                    <Link
                      href={href("service")}
                      className={`wt ${coffeeOrders && coffeeOrders.поАвтоматам.length > 0 ? "" : "off"}`}
                    >
                      <div className="wl">Лучший автомат</div>
                      <div className="wv">{coffeeOrders?.поАвтоматам[0]?.машина ?? "—"}</div>
                      <div className="wf">
                        {coffeeOrders && coffeeOrders.поАвтоматам.length > 0
                          ? `${coffeeOrders.поАвтоматам[0].чашек.toLocaleString("ru-RU")} чашек за 30 дней`
                          : "нет продаж"}
                        <span className="go">→</span>
                      </div>
                    </Link>
                  </div>
                </div>
                <div>
                  <div className="sect-h">
                    <h3 className="h2">Снек</h3>
                    {salesSummary?.lastSaleDt && <span className="chip g">живые · OurVend</span>}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <Link href={href("reports:sale")} className={`wt ${salesSummary ? "" : "off"}`}>
                      <div className="wl">Продано вчера</div>
                      <div className="wv">
                        {salesSummary ? `${Number(salesSummary.yesterday.qty).toLocaleString("ru-RU")} шт` : "—"}
                      </div>
                      <div className="wf">
                        {salesSummary ? `${Number(salesSummary.yesterday.amount).toLocaleString("ru-RU")} сум` : "нет данных"}
                        <span className="go">→</span>
                      </div>
                    </Link>
                    <Link
                      href={href("settings:machine_stock")}
                      className={`wt ${supplySummary ? "" : "off"} ${
                        supplySummary && supplySummary.emptyPositions > 0 ? "is-hot" : ""
                      }`}
                    >
                      <div className="wl">Пустые позиции</div>
                      <div className="wv">{supplySummary ? supplySummary.emptyPositions : "—"}</div>
                      <div className="wf">
                        {supplySummary
                          ? supplySummary.emptyPositions > 0
                            ? "спирали закончились — везти пополнение"
                            : "пусто нет"
                          : "нет данных"}
                        <span className="go">→</span>
                      </div>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Деньги и партнёры: закупки, поставщики, инкассация, топ товара ── */}
          {domain === "vendhub" && (
            <div className="sect">
              <div className="sect-h"><h3 className="h2">Деньги и партнёры</h3></div>
              <div className="wgrid">
                <Link href={href("settings:purchase")} className={`wt ${supplySummary ? "" : "off"}`}>
                  <div className="wl">Закупки · 30 дней</div>
                  <div className="wv">
                    {supplySummary ? Math.round(supplySummary.purchases30.total).toLocaleString("ru-RU") : "—"}
                  </div>
                  <div className="wf">по журналу прихода<span className="go">→</span></div>
                </Link>
                <Link href={href("settings:contractor")} className={`wt ${contractorsLoaded ? "" : "off"}`}>
                  <div className="wl">Поставщики</div>
                  <div className="wv">{contractorsLoaded ? contractors.length : "—"}</div>
                  <div className="wf">
                    {topContractor ? `крупнейший: ${topContractor.name}` : "нет данных по обороту"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("service")} className={`wt ${collSummary ? "" : "off"}`}>
                  <div className="wl">Инкассация · 30 дней</div>
                  <div className="wv">
                    {collSummary ? Number(collSummary.receivedSum).toLocaleString("ru-RU") : "—"}
                  </div>
                  <div className="wf">
                    принято инкассаций: {collSummary ? collSummary.receivedCount : "—"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("service")} className={`wt ${coffeeTopProducts.length > 0 ? "" : "off"}`}>
                  <div className="wl">Топ товара</div>
                  <div className="wv">{coffeeTopProducts[0]?.товар ?? "—"}</div>
                  <div className="wf">
                    {coffeeTopProducts.length > 1
                      ? coffeeTopProducts.slice(1, 3).map((p) => p.товар).join(" · ")
                      : "нет данных"}
                    <span className="go">→</span>
                  </div>
                </Link>
              </div>
            </div>
          )}

          {/* ── Парк: где стоят автоматы и как работают ── */}
          {domain === "vendhub" && (
            <div className="sect">
              <div className="sect-h"><h3 className="h2">Парк</h3></div>
              <div className="wgrid">
                <Link href={href("settings:machine", "in_service")} className={`wt ${machineCards ? "" : "off"}`}>
                  <div className="wl">В работе</div>
                  <div className="wv">{machineCards ? parkInService.length : "—"}</div>
                  <div className="wf">
                    {machineCards
                      ? `${parkInServiceCoffee} кофе · ${parkInServiceSnack} снек${parkInServiceOther > 0 ? ` · ${parkInServiceOther} другое` : ""}`
                      : "нет данных"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("settings:machine", "warehouse")} className={`wt ${machineCards ? "" : "off"}`}>
                  <div className="wl">На складе</div>
                  <div className="wv">{machineCards ? parkWarehouse.length : "—"}</div>
                  <div className="wf">простаивают<span className="go">→</span></div>
                </Link>
                <Link href={href("settings:machine", "repair")} className={`wt ${machineCards ? "" : "off"}`}>
                  <div className="wl">В ремонте</div>
                  <div className="wv">{machineCards ? parkRepair.length : "—"}</div>
                  <div className="wf">не в строю<span className="go">→</span></div>
                </Link>
                <Link href={href("settings:machine")} className={`wt ${cupsPerMachine !== null ? "" : "off"}`}>
                  <div className="wl">Выработка · чаш/авт</div>
                  <div className="wv">{cupsPerMachine ?? "—"}</div>
                  <div className="wf">30 дней<span className="go">→</span></div>
                </Link>
              </div>
            </div>
          )}

          {/* ── График: выручка по дням, кофе + снек одним рядом ── */}
          {domain === "vendhub" && revenueByDay.length > 1 && (
            <div className="sect">
              <div className="sect-h"><h3 className="h2">Выручка по дням</h3></div>
              <p className="hint" style={{ marginBottom: 0 }}>Кофе + снек · 30 дней:</p>
              <MiniBars
                bars={revenueByDay.map(([dt, amount]) => ({
                  label: dt.slice(8),
                  value: amount,
                  title: `${dt}: ${Math.round(amount).toLocaleString("ru-RU")} сум`,
                }))}
              />
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

          {/* I4 (ревью 20.08.2026): у VendHub «Что заведено» дублирует SETTINGS
              (тот же реестр по типам, тот же счётчик) — оставлено только для
              остальных направлений, у которых своей навигации по разделам
              с живым счётчиком ещё нет. */}
          {domain !== "vendhub" && (
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
          )}

          {/* ── Карта: свёрнута по умолчанию, в самом конце обзора (по образцу
                 «Истории» в location-panel.tsx) ── */}
          {domain === "vendhub" && machines.length > 0 && (
            <details className="sect loc-hist">
              <summary>
                <span className="loc-hist-t">Автоматы на карте</span>
                <span className="chip b">кофе ×{coffeeMachines}</span>
                {snackMachines > 0 && <span className="chip g">снеки ×{snackMachines}</span>}
                {unknownMachines > 0 && (
                  <span className="chip">тип не указан ×{unknownMachines}</span>
                )}
              </summary>
              <div className="loc-hist-body">
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
            </details>
          )}
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

      {/* ── Товары: журнал как в ПО владельца — поиск, категории, незаполненные ──
          Единый образец листа (§4): KPI сверху, «+ Запись» — в строке
          действия. Поиск и подвкладки категорий остаются внутри ProductsBook —
          у него уже есть своя GET-форма, второй ListShell не рисует. */}
      {group && leaf?.type === "product" && (() => {
        const incompleteCount = leafItems.filter(isIncomplete).length;
        return (
          <ListShell
            kpi={[
              { label: "Всего", value: String(leafItems.length) },
              { label: "Незаполненные", value: String(incompleteCount), hot: incompleteCount > 0 },
            ]}
            action={<NewEntityForm domain={domain} type="product" label={typeOne("product")} />}
            searchQ={q ?? ""}
          >
            <ProductsBook
              items={leafItems}
              q={q ?? ""}
              cat={cat ?? ""}
              inc={inc === "1"}
              hrefBase={`/domain/${domain}`}
            />
          </ListShell>
        );
      })()}

      {/* ── Ингредиенты: сырьё для рецептов кофе/снеков — цена (карточка) и
          мост к бункерному реестру (миграция 0059, срез B). Единый образец
          листа (§4): KPI сверху, поиск ?q= серверный (как у generic-ветки
          ниже — у ингредиентов своей формы поиска нет), карточки-ссылки на
          карточку 360 (Task 5). «Связано с бункерами» считает entity.id
          среди НЕNULL entityId бункерного конфига — честный 0, когда мост ещё
          не выкачен на прод (все entityId в ответе тогда null), а не выдумка. */}
      {group && leaf?.type === "ingredient" && (() => {
        const ingredientQuery = (q ?? "").trim().toLowerCase();
        const shownIngredients = ingredientQuery
          ? leafItems.filter((e) => e.name.toLowerCase().includes(ingredientQuery))
          : leafItems;
        const withPrice = leafItems.filter((e) => cardPrice(e.attrs) !== null).length;
        const linkedIds = new Set(
          (bunkerConfig ?? []).filter((b) => b.entityId !== null).map((b) => b.entityId as string),
        );
        const linkedCount = bunkerConfig === null ? null : leafItems.filter((e) => linkedIds.has(e.id)).length;
        const kpi: ListShellKpi[] = [
          { label: "Всего", value: String(leafItems.length) },
          {
            label: "С ценой",
            value: String(withPrice),
            foot: leafItems.length > 0 ? `из ${leafItems.length} карточек` : undefined,
          },
          {
            label: "Связано с бункерами",
            value: linkedCount === null ? "—" : String(linkedCount),
            foot: bunkerConfig === null ? "нет данных" : "мост entityId · миграция 0059",
          },
        ];
        return (
          <ListShell
            kpi={kpi}
            action={<NewEntityForm domain={domain} type="ingredient" label={typeOne("ingredient")} />}
            searchQ={q ?? ""}
            searchHrefBase={`/domain/${domain}`}
            searchTab={active}
          >
            {shownIngredients.length > 0 ? (
              <>
                <div className="book">
                  <div className="th">
                    <span>Ингредиент</span>
                    <span>Цена в карточке</span>
                    <span style={{ textAlign: "right" }}>Сум/г</span>
                  </div>
                  {shownIngredients.map((e) => {
                    const price = cardPrice(e.attrs);
                    const perGram = pricePerGram(e.attrs);
                    const linked = linkedIds.has(e.id);
                    return (
                      <Link href={`/card/${e.id}`} className="tr" key={e.id}>
                        <span className="nm">
                          {e.name}
                          {linked && (
                            <span className="chip g" style={{ marginLeft: 8 }}>
                              бункер
                            </span>
                          )}
                        </span>
                        <span className="cd">
                          {price ? `${price.price.toLocaleString("ru-RU")} сум/${price.unit}` : "—"}
                        </span>
                        <span className="pr">
                          {perGram !== null ? `${perGram.toLocaleString("ru-RU")} сум/г` : "—"}
                        </span>
                      </Link>
                    );
                  })}
                </div>
                <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
                  {shownIngredients.length === leafItems.length
                    ? `${leafItems.length} карточек`
                    : `${shownIngredients.length} из ${leafItems.length} карточек`}
                </p>
              </>
            ) : leafItems.length === 0 ? (
              <div className="empty">
                <b>Ингредиентов пока нет</b>
                Добавь запись кнопкой ниже — или пришли сохранённую страницу ПО, соберу всё разом.
              </div>
            ) : (
              <div className="empty">
                <b>Ничего не нашлось</b>
                Поменяй запрос или сними фильтр.
              </div>
            )}
          </ListShell>
        );
      })()}

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
      {group && leaf?.type === "contractor" && (() => {
        // «Оборот суммарно» — только если поле известно хоть у одной карточки
        // листа (иначе плитка спорила бы с ContractorsBook, где та же сумма
        // не показывается вовсе — см. `оборотОф` в globerent-books.tsx).
        // Сумма реальна и когда поле известно не у всех (GLOBERENT: 6 из 226),
        // поэтому не прячем плитку по правилу `every` — это лишило бы итога
        // любой список, где хоть у одной карточки нет оборота. Вместо этого
        // фут честно называет охват: «по N из M карточек», когда N < M.
        const turnoverValues = leafItems
          .map((e) => (e.attrs ?? {})["оборот по реестру"])
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const withTurnover = turnoverValues.length;
        const total = leafItems.length;
        const kpi: ListShellKpi[] = [{ label: "Всего", value: String(total) }];
        if (withTurnover > 0) {
          const sum = turnoverValues.reduce((a, b) => a + b, 0);
          kpi.push({
            label: "Оборот суммарно",
            value: `${sum.toLocaleString("ru-RU")} сум`,
            ...(withTurnover < total ? { foot: `по ${withTurnover} из ${total} карточек` } : {}),
          });
        }
        return (
          <ListShell
            kpi={kpi}
            action={<NewEntityForm domain={domain} type="contractor" label={typeOne("contractor")} />}
            searchQ=""
          >
            {leafItems.length > 0 ? (
              <ContractorsBook items={leafItems} />
            ) : (
              <div className="empty">
                <b>Контрагентов пока нет</b>
                Добавь запись кнопкой ниже — или пришли сохранённую страницу ПО, соберу всё разом.
              </div>
            )}
          </ListShell>
        );
      })()}
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

      {/* ── Автоматы (vendhub, C1): полноценная панель парка, а не
          generic-книга «имя/код/номер» — так было до ревью (осиротевший
          VendingMachinesPanel, см. git show 8640e30^ для прежней вкладки
          `vending`). ?status=in_service|warehouse|repair (кликом с плиток
          «Парк» на дашборде) сужает список ДО панели — MachinesBrowser
          внутри получает уже отфильтрованные карточки. */}
      {group && leaf?.type === "machine" && domain === "vendhub" && (() => {
        const statusFilter = isMachineStatus(sp.status) ? sp.status : null;
        const filteredMachines =
          statusFilter === null ? machines : machines.filter((e) => parkStatusOf(e.id) === statusFilter);
        return (
          <>
            {statusFilter !== null && (
              <p className="hint" style={{ marginBottom: 10 }}>
                Показаны только «{machineStatusLabel(statusFilter)}» ({filteredMachines.length}) ·{" "}
                <Link href={href("settings:machine")}>сбросить фильтр</Link>
              </p>
            )}
            <VendingMachinesPanel machines={filteredMachines} />
          </>
        );
      })()}

      {/* ── Группа: записи выбранной подвкладки ── Единый образец листа (§4):
          KPI сверху («Всего записей», «Не утверждено»), поиск по ?q= —
          сервером, тем же приёмом, что у ProductsBook (подстрока имени,
          регистронезависимо), форму рисует сам ListShell — у generic-книги
          своей нет. Действует не только на VendHub: под этот рендер попадают
          и generic-листы GLOBERENT (например «Таможенные посты»). */}
      {group && leaf?.type && !["sources", "collection", "sale", "product", "ingredient", "purchase", "machine_stock", "consumption", "contract", "invoice", "contractor", "equipment", "equipment_model", "customs_rates", "recipe", "machine"].includes(leaf.type) && (() => {
        const genericQuery = (q ?? "").trim().toLowerCase();
        const shownItems = genericQuery
          ? leafItems.filter((e) => e.name.toLowerCase().includes(genericQuery))
          : leafItems;
        const notApproved = leafItems.filter((e) => e.approvedAt == null).length;
        return (
          <ListShell
            kpi={[
              { label: "Всего записей", value: String(leafItems.length) },
              { label: "Не утверждено", value: String(notApproved), hot: notApproved > 0 },
            ]}
            action={<NewEntityForm domain={domain} type={leaf.type} label={typeOne(leaf.type)} />}
            searchQ={q ?? ""}
            searchHrefBase={`/domain/${domain}`}
            searchTab={active}
          >
            {shownItems.length > 0 ? (
              <>
                <div className="book">
                  <div className="th">
                    <span>Название</span>
                    <span>Код</span>
                    <span style={{ textAlign: "right" }}>{leaf.type === "product" ? "Цена" : "Номер"}</span>
                  </div>
                  {shownItems.map((e) => {
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
                <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
                  {shownItems.length === leafItems.length
                    ? `${leafItems.length} записей`
                    : `${shownItems.length} из ${leafItems.length} записей`}
                </p>
              </>
            ) : leafItems.length === 0 ? (
              <div className="empty">
                <b>{leaf.label}: данных пока нет</b>
                Добавь запись кнопкой ниже — или пришли сохранённую страницу ПО,
                соберу всё разом.
              </div>
            ) : (
              <div className="empty">
                <b>Ничего не нашлось</b>
                Поменяй запрос или сними фильтр.
              </div>
            )}
          </ListShell>
        );
      })()}
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
      {activeGroup === "tasks" && (
        <>
          {domain === "vendhub" && taskKpi.length > 0 && (
            <div className="wgrid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", marginBottom: 14 }}>
              {taskKpi.map((t) => (
                <div key={t.label} className={`wt ${t.hot ? "is-hot" : ""}`}>
                  <div className="wl">{t.label}</div>
                  <div className="wv">{t.value}</div>
                </div>
              ))}
            </div>
          )}
          {openTasks.length === 0 ? (
            <div className="empty">
              <b>Открытых задач нет</b>
              Задачи с этим направлением появятся здесь.
            </div>
          ) : (
            <div>
              {openTasks.map((t) => {
                const late = t.due !== null && new Date(t.due).getTime() < Date.now();
                const sourceLabel = taskSourceLabel(t.source);
                // Синий вариант — только для автоматических источников (график/
                // обслуживание): «владелец» — нейтральный чип, не подсвечивать
                // ручной ввод как будто это автоматика.
                const isAutoSource = sourceLabel !== "владелец";
                return (
                  <Link href={`/tasks/${t.id}`} className={`trow ${late ? "hot" : ""}`} key={t.id}>
                    <div className="tb"><div className="tt">{t.title}</div></div>
                    <span className={`chip ${isAutoSource ? "b" : ""}`}>{sourceLabel}</span>
                    <span className={`due ${late ? "hot" : ""}`}>{dueLabel(t.due)}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
