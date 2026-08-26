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
  type CashReconcileReport,
  type CoffeeBunkerIngredient,
  type Entity,
  type ExpiryReport,
  type FinanceCounterparty,
  type FinanceFlow,
  type FinanceSummary,
  type Gap,
  type GrContract,
  type GrImport,
  type GrPreorder,
  type GrUnit,
  type NormFactReport,
  type Obligations,
  type Person,
  type ReconcileResult,
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
import { ExpiryBook } from "../../../components/expiry-book";
import { CashReconcile } from "../../../components/cash-reconcile";
import { NormFactBook } from "../../../components/norm-fact-book";
import { GapsBook } from "../../../components/gaps-book";
import { ListShell, type ListShellKpi } from "../../../components/list-shell";
import { MachineStockView, PurchasesView } from "../../../components/supply-views";
import { RegisterImport } from "../../../components/register-import";
import { MapPanel } from "../../../components/map-panel";
import { MiniBars } from "../../../components/mini-bars";
import { QuickActions } from "../../../components/quick-actions";
import { SourcesView } from "../../../components/sources-view";
import { ReportsOverview } from "../../../components/reports-overview";
import { VendingMachinesPanel, VendingSupplyPanel } from "../../../components/vending-panel";
import { PurchasePlanView } from "../../../components/purchase-plan-view";
import { SHRINKAGE_WINDOWS, ShrinkageView } from "../../../components/shrinkage-view";
import { MARGIN_WINDOWS, MarginView } from "../../../components/margin-view";
import { REFILL_EVENT_WINDOWS, RefillEventsView } from "../../../components/refill-events-view";
import { DEAD_STOCK_WINDOWS, DeadStockView } from "../../../components/dead-stock-view";
import { PRICE_WINDOWS, VendingPricesView } from "../../../components/vending-prices-view";
import { ProductRulesView } from "../../../components/product-rules-view";
import { CoffeePanel } from "../../../components/coffee-panel";
import {
  ServiceTab,
  type ServiceAction,
  type ServiceKpiTile,
} from "../../../components/service-tab";
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

function coreErrorDetail(err: unknown): string {
  return err instanceof CoreUnavailable ? err.detail : String(err);
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
  if (
    source === "maintenance-monitor" ||
    source === "coffee-monitor" ||
    source === "coffee-alert"
  ) {
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
  const { tab, q, cat, inc, vid } = sp;
  if (!isDomain(domain)) notFound();

  const groups = groupsFor(domain);
  const active = tab ?? "overview";
  const [activeGroup, activeLeaf] = active.includes(":") ? active.split(":") : [active, null];

  // Старые адреса вкладок живут в закладках и в сообщениях бота — они обязаны
  // приводить в новые места, а не в пустую вкладку.
  const TAB_REDIRECTS: Record<string, string> = {
    vending: "settings:machine",
    // Уточнены до листьев: раньше все три вели в верх простыни, и человек
    // всё равно искал нужную панель скроллом.
    supply: "service:snack",
    coffee: "service:coffee",
    collect: "service:collection",
    team: "hr",
    catalog: "settings",
    reference: "settings",
  };
  /**
   * Редиректы уровня ЛИСТА — `"группа:лист"` → новый адрес.
   *
   * Групповая карта выше знает только группу и переносит лист ДОСЛОВНО
   * (`catalog:X` → `settings:X`). Пока листья не двигались, этого хватало.
   * Как только лист переезжает или сливается, дословный перенос приводит
   * «успешно» в никуда: группа найдена, листа в ней нет, и фолбэк молча
   * открывает соседний экран.
   *
   * Значение — либо новый `группа:лист[&параметры]`, либо ПУТЬ (начинается с
   * `/`): часть сущностей живёт не во вкладках, а на сквозных экранах.
   */
  const LEAF_REDIRECTS: Record<string, string> = {
    // Типы `location` (адреса точек) и `workshop` (мастерские) не имеют листа
    // ни в одной группе — они живут на сквозном экране «Места». Эти адреса
    // битые НЕ с этой перестройки, а уже сегодня: `/registry` строит на них
    // ссылку, и клик по плитке «location» открывает список товаров.
    // Переезды листьев «Полевой работы».
    "reports:collection": "service:collection",
    "settings:purchase": "reports:purchase",
    // Слияния: лист превратился в чип или в раздел хаба, адрес ведёт туда же.
    "settings:recipe": "settings:product&vid=рецепт",
    "settings:consumable": "settings:ingredient",
    "settings:classifier": "settings:refs",
    "settings:vat": "settings:refs",
    "settings:ikpu": "settings:refs",
    "settings:package": "settings:refs",
    "settings:barcode": "settings:refs",
    // Мастер стал кнопкой внутри «Прихода» — старая закладка приводит туда же.
    "settings:purchase_import": "reports:purchase",
    "settings:machine_stock": "service:machine_stock",
    "settings:location": "/places",
    "catalog:location": "/places",
    "settings:workshop": "/places",
    "catalog:workshop": "/places",
  };

  const redirectBase = TAB_REDIRECTS[activeGroup];
  if (domain === "vendhub") {
    // Сначала листовая карта: она точнее групповой и должна победить.
    // Прогоняем и исходный адрес, и результат групповой подстановки —
    // `?tab=reference:classifier` обязан доехать до нового места, а не
    // остановиться на промежуточном `settings:classifier`.
    const candidates = [active];
    if (redirectBase && activeLeaf && (activeGroup === "catalog" || activeGroup === "reference")) {
      candidates.push(`settings:${activeLeaf}`);
    }
    for (const candidate of candidates) {
      const target = LEAF_REDIRECTS[candidate];
      if (!target) continue;
      if (target.startsWith("/")) redirect(target);
      // Цель может нести собственные параметры (`settings:product&vid=рецепт`):
      // лист превратился в чип, и чтобы старый адрес привёл к тому же набору
      // записей, фильтр надо доставить вместе с ним. Кладём их РАЗОБРАННЫМИ,
      // иначе весь хвост уехал бы внутрь значения `tab`.
      const amp = target.indexOf("&");
      const targetTab = amp === -1 ? target : target.slice(0, amp);
      const targetQuery = amp === -1 ? "" : target.slice(amp + 1);
      const forwardedLeaf = new URLSearchParams(sp);
      forwardedLeaf.set("tab", targetTab);
      for (const [k, v] of new URLSearchParams(targetQuery)) forwardedLeaf.set(k, v);
      redirect(`/domain/${domain}?${forwardedLeaf.toString()}`);
    }
  }
  if (redirectBase && domain === "vendhub") {
    // catalog/reference были группами с подвкладками — сохраняем лист при
    // переезде в settings; остальные (vending/supply/…) были плоскими
    // операционными вкладками, у них листа не было.
    const redirectTo =
      (activeGroup === "catalog" || activeGroup === "reference") && activeLeaf
        ? `settings:${activeLeaf}`
        : redirectBase;
    // Переносим ВСЕ остальные параметры, а не только `tab`. Раньше адрес
    // пересобирался из одного `tab`, и редирект молча съедал `q`, `cat`,
    // `inc`, `status`, `from`, `to`, `src`, `rep`, `view`, `f0..fN` — то есть
    // ровно то, ради чего по ссылке и шли. Отказ был невидимым: ошибки нет,
    // страница открывается, просто фильтр не применён и список показывает всё.
    // Список параметров намеренно НЕ перечисляем поимённо: каждый следующий
    // экран заводит свои, и такой список протух бы молча — переносим всё, кроме
    // самого `tab`, который заменяем.
    // Идём по `sp`, а не по сырым `searchParams`: он уже сплющен в
    // `Record<string, string>` выше, и ровно его читают все потребители ниже.
    // Переносить больше, чем страница умеет прочитать, смысла нет.
    const forwarded = new URLSearchParams(sp);
    forwarded.set("tab", redirectTo);
    redirect(`/domain/${domain}?${forwarded.toString()}`);
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
  const defaultOwner =
    ourPeople.find((p) => p.active === "yes" && p.tgChatId) ?? ourPeople[0] ?? null;

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
    [salesSummary, supplySummary, salesDaily, cashEstimate, vendingDeficit, machineCards] =
      await Promise.all([
        core.salesSummary().catch(() => null),
        core.supplySummary().catch(() => null),
        core.salesDaily(30).catch(() => null),
        core.cashEstimate().catch(() => null),
        core.vendingDeficit().catch(() => null),
        core.machineCards().catch(() => null),
      ]);
  } else if (
    domain === "vendhub" &&
    activeGroup === "settings" &&
    activeLeaf === "machine" &&
    sp.status
  ) {
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
      tasksOverdueRows === null
        ? null
        : tasksOverdueRows.filter((t) => t.domain === "vendhub").length;
    // ownerRef === "" тоже "свободная" — исторические записи до нормализации
    // "" → null на создании (tasks.service.ts) могли осесть в базе пустой
    // строкой, а не null.
    const unassignedCount = openTasks.filter(
      (t) => t.ownerRef === null || t.ownerRef.trim() === "",
    ).length;
    // «За неделю» — та же скользящая граница (сейчас минус 168 часов), что
    // и doneLast7d на сервере (tasks.service.ts), а не календарный день:
    // окно в 7×24 часа не зависит от часового пояса подсчёта.
    const weekAgoMs = Date.now() - 7 * 24 * 3600_000;
    // completedAt — единственное поле-дата закрытия у Task (updatedAt в типе
    // нет); status "done" + completedAt в окне — тот же признак, что у
    // серверного doneLast7d, поэтому цифра не выдумана, а согласована с ним.
    const closedThisWeek = tasks.filter(
      (t) =>
        t.status === "done" &&
        t.completedAt !== null &&
        new Date(t.completedAt).getTime() >= weekAgoMs,
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
  const isOpenObligation = (t: { status: string }) =>
    t.status !== "actual" && t.status !== "cancelled";
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
  const topTabs =
    domain === "vendhub"
      ? // Порядок задан явно, не порядком групп (settings/reports там идут иначе).
        //
        // ПОДПИСИ РУССКИЕ (решение 22.08.2026, отменяет латиницу от 20.08).
        // У отменяемого решения не было записанного обоснования нигде — ни в
        // спеке, ни в плане, ни в теле PR, ни в транскриптах; решение без
        // причины пересматривается дёшево. Весь остальной интерфейс русский, а
        // отделить верхний ряд от содержимого можно начертанием и трекингом, а
        // не сменой алфавита. Причина этого решения записана —
        // docs/decisions/2026-08-22-navigaciya-i-gamma.md.
        //
        // ЗОНЫ РЯДА: вход · деятельности (растут) · разрезы (не растут) ·
        // система. «Номенклатура» — разрез, а не настройка: каталог это данные
        // бизнеса, а не параметры системы, и лежал он в «Настройках» лишь
        // потому, что не нашлось другой полки. Ключ `settings` при этом
        // СОХРАНЁН за ней намеренно: на него завязаны семь плиток дашборда,
        // кнопка «назад» карточки 360 и плитки реестра — смена ключа
        // потребовала бы редиректов там, где сегодня всё работает само.
        [
          { key: "overview", label: "Сегодня" },
          { key: "service", label: "Полевая работа" },
          { key: "smm", label: "Продвижение" },
          { key: "crm", label: "Клиенты" },
          { key: "hr", label: `Люди${ourPeople.length > 0 ? ` ${ourPeople.length}` : ""}` },
          { key: "tasks", label: tasksLabel },
          { key: "reports", label: groups.find((g) => g.key === "reports")?.label ?? "Отчёты" },
          {
            key: "settings",
            label: groups.find((g) => g.key === "settings")?.label ?? "Номенклатура",
          },
          { key: "system", label: "⚙ Настройки" },
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
  //
  // R-C8 (фикс дефолта «Отчётов»): `activeLeaf` — `null`, когда в адресе нет
  // `group:leaf` (просто `?tab=reports`). Первая строка ниже ТРЕБУЕТ
  // `l.type !== null`, иначе `l.type === activeLeaf` находила первую же
  // заглушку с `type: null` (была «Сроки годности», следом «Себестоимость») —
  // экран приземлялся на пустышку вместо явного дефолта «По источникам»,
  // подставляя порядок массива вместо решения. Явный `?tab=reports:expiry`
  // при этом продолжает работать: activeLeaf тогда строка `"expiry"`, и лист
  // находится этой же веткой.
  //
  // ДЕФОЛТ ГРУППЫ ЗАДАН ЯВНО (`NavGroup.defaultLeaf`), а не вычисляется по
  // данным. Прежняя цепочка последним звеном искала «первый лист с ненулевым
  // счётчиком» — то есть точку входа в группу выбирали ДАННЫЕ: «Настройки»
  // никогда не открывались на «Профиле» (0 карточек), всегда на «Товарах», и
  // порядок листьев в меню не значил ничего. Достаточно было завести первую
  // запись в пустом листе, чтобы вход в группу молча переехал.
  const leaf =
    group?.leaves.find((l) => l.type !== null && l.type === activeLeaf) ??
    group?.leaves.find((l) => l.type !== null && l.type === group.defaultLeaf) ??
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

  // Импорт закупок (Task 4): карточки сырья — вход `suggestCard` (Task 2);
  // склады — куда заводится приход.
  //
  // null — «не удалось прочитать», и это НЕ то же самое, что пустой список.
  // Подменить одно другим значит сказать владельцу «складов нет» в момент, когда
  // ядро просто не ответило: он заведёт дубль-склад, а все 59 имён останутся без
  // предложений якобы потому, что карточек нет. Тот же урок уже оплачен дважды —
  // в срезах B и C витрины чинили отдельными коммитами ровно за эту подмену.
  let importIngredientCards: Entity[] | null = null;
  let importWarehouses: Entity[] | null = null;
  // Мастер импорта живёт внутри листа «Приход», поэтому и данные для него
  // грузим на этом листе. Иначе мастер скажет «складов нет» — не потому, что
  // их нет, а потому что их не спросили.
  if (domain === "vendhub" && group && leaf?.type === "purchase") {
    [importIngredientCards, importWarehouses] = await Promise.all([
      core.entitiesOfType(domain, "ingredient").catch(() => null),
      core.entitiesOfType(domain, "warehouse").catch(() => null),
    ]);
  }

  // Хаб «Справочники»: пять фискальных типов на одном листе. Все пятеро
  // крошечные (62 записи суммарно), поэтому грузим разом и показываем
  // целиком — вложенная навигация ради двух записей НДС была бы дороже, чем
  // сами данные.
  // `one` — подпись кнопки в единственном числе. Задана здесь явно, потому
  // что в общем словаре подписей этих типов нет, и кнопка показывала СЫРОЙ
  // КОД БАЗЫ: «+ vat», «+ ikpu», «+ package», «+ barcode», «+ classifier».
  // Ровно тот дефект, из-за которого раньше удалили целый лист «Поставщики».
  const REFS_TYPES: { type: string; label: string; one: string }[] = [
    { type: "classifier", label: "Классификатор", one: "классификатор" },
    { type: "vat", label: "НДС", one: "ставку НДС" },
    { type: "ikpu", label: "ИКПУ", one: "код ИКПУ" },
    { type: "package", label: "Упаковка", one: "упаковку" },
    { type: "barcode", label: "Штрих-коды", one: "штрих-код" },
  ];
  let refsItems: Record<string, Entity[]> | null = null;
  if (domain === "vendhub" && group && leaf?.type === "refs") {
    const loaded = await Promise.all(
      REFS_TYPES.map((r) => core.entitiesOfType(domain, r.type).catch(() => null)),
    );
    refsItems = {};
    REFS_TYPES.forEach((r, i) => {
      refsItems![r.type] = loaded[i] ?? [];
    });
  }

  // Сроки годности (Task 5): партии — своя таблица, не реестр. Прод-ядро на
  // момент этого среза ещё старой версии (без `/stock/*` партий) — провал
  // запроса (в т.ч. 404) не должен читаться как «просрочки нет»: report
  // остаётся `null`, лист обязан честно сказать «не удалось проверить»
  // (ExpiryBook), а не показать нулевые счётчики.
  let expiryReport: ExpiryReport | null = null;
  if (group && leaf?.type === "expiry") {
    expiryReport = await core.expiryReport().catch(() => null);
  }

  // Сверка кассы (срез К, задача 6; R-K9 + R-K11): период задаётся ?from=&to=
  // формой на самом листе, по умолчанию — вся известная история (инкассации
  // идут с 26.05.2025, факт 11) до сегодня. `isDefaultPeriod` отличает «за всю
  // историю данных нет» от «в выбранном окне пусто» — иначе оба выглядели бы
  // одинаково (тот же урок, что дают три честных состояния ниже). Оба ответа
  // ядра запрашиваются независимо и могут отсутствовать порознь (R-K9: два
  // разных эндпоинта) — .catch(() => null) на каждом отдельно, а не общий try.
  const CASH_RECONCILE_DEFAULT_FROM = "2025-01-01";
  const ISO_DAY_EXACT = /^\d{4}-\d{2}-\d{2}$/;
  let reconcileFrom = CASH_RECONCILE_DEFAULT_FROM;
  let reconcileTo = todayKey;
  let reconcileResult: ReconcileResult | null = null;
  let cashReport: CashReconcileReport | null = null;
  const isDefaultPeriod =
    !(sp.from && ISO_DAY_EXACT.test(sp.from)) && !(sp.to && ISO_DAY_EXACT.test(sp.to));
  if (group && leaf?.type === "cash_reconcile") {
    if (sp.from && ISO_DAY_EXACT.test(sp.from)) reconcileFrom = sp.from;
    if (sp.to && ISO_DAY_EXACT.test(sp.to)) reconcileTo = sp.to;
    if (reconcileFrom > reconcileTo) [reconcileFrom, reconcileTo] = [reconcileTo, reconcileFrom];
    [reconcileResult, cashReport] = await Promise.all([
      core.reconcileCollections(reconcileFrom, reconcileTo).catch(() => null),
      core.cashReconcile(reconcileFrom, reconcileTo).catch(() => null),
    ]);
  }

  // Норма и факт по бункерам (срез F, задача 5): период задаётся ?from=&to=
  // формой на листе — тот же приём умолчания «вся известная история», что и
  // у «Сверки кассы» выше (`isDefaultPeriod` — тот же флаг: он просто отвечает
  // «были ли from/to в адресе», не привязан к конкретному листу, поэтому
  // безопасно переиспользуется норма-фактом ровно так же, как сверкой кассы).
  const NORM_FACT_DEFAULT_FROM = "2025-01-01";
  let normFactFrom = NORM_FACT_DEFAULT_FROM;
  let normFactTo = todayKey;
  let normFactReport: NormFactReport | null = null;
  if (group && leaf?.type === "norm_fact") {
    if (sp.from && ISO_DAY_EXACT.test(sp.from)) normFactFrom = sp.from;
    if (sp.to && ISO_DAY_EXACT.test(sp.to)) normFactTo = sp.to;
    if (normFactFrom > normFactTo) [normFactFrom, normFactTo] = [normFactTo, normFactFrom];
    normFactReport = await core.coffeeNormFact(normFactFrom, normFactTo).catch(() => null);
  }

  // Усушка (П4, R-P4-3): окно задаётся ?days= из закрытого списка кнопок
  // листа — 7/14/30. Белый список здесь не защита прода от «?days=6000»:
  // ядро само зажимает окно `ShrinkageDto` (@Min(1) @Max(60)) и потолком
  // SHRINK_DAYS_MAX=60 внутри сервиса независимо от cc. Список закрыт просто
  // потому, что на листе всего три кнопки — четвёртого значения там нет.
  // Сам отчёт тянет лист (как «План закупа»): страница только читает окно.
  const shrinkDays =
    (SHRINKAGE_WINDOWS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 14;

  // Аналитика снек-контура (П5b): у каждого листа своё окно и свой набор
  // кнопок, но приём тот же, что у усушки — страница читает `?days=`, а сам
  // отчёт тянет лист. Белый список здесь не защита прода (ядро зажимает окно
  // своим DTO), а просто перечень кнопок листа.
  const marginDays = (MARGIN_WINDOWS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 30;
  const deadStockDays = (DEAD_STOCK_WINDOWS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 21;
  const priceDays = (PRICE_WINDOWS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 30;
  // Журнал заливок (R-H-5): тот же приём — страница читает `?days=`, лист сам
  // тянет отчёт. Ядро зажимает своё окно (`RefillEventsListDto` @Max(90))
  // независимо от списка кнопок здесь.
  const refillEventDays =
    (REFILL_EVENT_WINDOWS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 14;

  // Реестр пробелов (срез К, задача 6, шаг 3): вычисляется на каждом чтении
  // (R-K4) — пустой массив здесь означает «всё, что можно посчитать, посчитано»,
  // а не что запрос сломан (null — именно провал запроса).
  let gapsResult: Gap[] | null = null;
  if (group && leaf?.type === "gaps") {
    gapsResult = await core.gaps().catch(() => null);
  }

  // Справочник растаможки (ставки ТН ВЭД + БРВ) — живые таблицы Core, не реестр.
  let tnved: TnvedRate[] = [];
  let brv: BrvValue[] = [];
  let customsLoadError: string | null = null;
  if (group && leaf?.type === "customs_rates") {
    try {
      [tnved, brv] = await Promise.all([core.tnvedRates(), core.brvValues()]);
    } catch (err) {
      customsLoadError = coreErrorDetail(err);
    }
  }

  // Живые UZS-договоры (перенос PROMACH) — поверх собранных карточек реестра.
  let liveContracts: GrContract[] = [];
  let contractClients: FinanceCounterparty[] = [];
  let contractsLoadError: string | null = null;
  if (domain === "globerent" && group && leaf?.type === "contract") {
    try {
      [liveContracts, contractClients] = await Promise.all([
        core.contracts(domain),
        core.financeCounterparties(domain),
      ]);
    } catch (err) {
      contractsLoadError = coreErrorDetail(err);
    }
  }

  // Калькулятор цены: ставки, БРВ и курс — входы движка (сам расчёт в браузере).
  let calcRates: TnvedRate[] = [];
  let calcBrv: BrvValue[] = [];
  let calcFx: Awaited<ReturnType<typeof core.fxRates>> = [];
  let calcLoadError: string | null = null;
  if (domain === "globerent" && activeGroup === "calc") {
    try {
      [calcRates, calcBrv, calcFx] = await Promise.all([
        core.tnvedRates(),
        core.brvValues(),
        core.fxRates(),
      ]);
    } catch (err) {
      calcLoadError = coreErrorDetail(err);
    }
  }

  // Склад техники: конвейер единиц (перенос warehouse_vehicles PROMACH).
  let units: GrUnit[] = [];
  let unitsSummary: { key: string; label: string; n: number }[] = [];
  let unitClients: FinanceCounterparty[] = [];
  let unitsLoadError: string | null = null;
  if (domain === "globerent" && activeGroup === "units") {
    try {
      [units, unitsSummary, unitClients] = await Promise.all([
        core.units(domain),
        core.unitsSummary(domain),
        core.financeCounterparties(domain),
      ]);
    } catch (err) {
      unitsLoadError = coreErrorDetail(err);
    }
  }

  // Импортные контракты и предзаказы (перенос PROMACH).
  let importsList: GrImport[] = [];
  let importSuppliers: FinanceCounterparty[] = [];
  let preorders: GrPreorder[] = [];
  let importsLoadError: string | null = null;
  if (domain === "globerent" && activeGroup === "imports") {
    try {
      [importsList, importSuppliers, preorders] = await Promise.all([
        core.imports(domain),
        core.financeCounterparties(domain),
        core.preorders(domain),
      ]);
    } catch (err) {
      importsLoadError = coreErrorDetail(err);
    }
  }

  // ── ACTIVITY (Обслуживание) целиком: мини-KPI + единая лента полевых
  // событий трёх источников (mergeServiceFeed + адаптеры, Task 8). Каждый
  // источник — свой Promise, провал одного (в т.ч. эндпоинтов, которых ещё
  // может не быть на проде) не роняет вкладку и не обнуляет чужие KPI/ленту —
  // правило best-effort, как у остальных ленивых блоков этой страницы.
  let serviceKpi: ServiceKpiTile[] = [];
  let serviceFeed: ServiceFeedItem[] = [];
  const SERVICE_ACTIONS: ServiceAction[] = [
    // Адреса листьев, а не якоря на секции ниже: у «Полевой работы» появился
    // второй уровень, и три панели больше не лежат простынёй на одной
    // странице. Якорь вёл бы в пустоту — секции с таким id больше нет.
    {
      icon: "☕",
      title: "Пополнить кофе-точку",
      subtitle: "точка → бункеры подряд → веса · как в боте",
      href: href("service:coffee"),
    },
    {
      icon: "🍫",
      title: "Пополнить снек-точку",
      subtitle: "точка → спирали → количества",
      href: href("service:snack"),
    },
    {
      icon: "💵",
      title: "Инкассация",
      subtitle: "автомат → сумма · весь парк, не только рабочие",
      href: href("service:collection"),
    },
  ];
  if (domain === "vendhub" && activeGroup === "service") {
    let recentRefills: Awaited<ReturnType<typeof core.recentCoffeeRefills>> | null = null;
    let bunkerConfig: Awaited<ReturnType<typeof core.coffeeBunkerConfig>> | null = null;
    let fillStatus: Awaited<ReturnType<typeof core.coffeeFillStatus>> | null = null;
    let serviceDeficit: Awaited<ReturnType<typeof core.vendingDeficit>> | null = null;
    let refillRows: Awaited<ReturnType<typeof core.vendingRefillList>> | null = null;
    let collRows: Awaited<ReturnType<typeof core.collections>> | null = null;
    [recentRefills, bunkerConfig, fillStatus, serviceDeficit, refillRows, collRows] =
      await Promise.all([
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
            (r) =>
              new Date(r.createdAt).toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" }) ===
              todayKey,
          ).length;
    // Пришло ровно столько строк, сколько разрешает эндпоинт, — значит за
    // сегодня могло быть больше, чем видно в этой выборке (более старые
    // заливки сегодняшнего дня уже могли не поместиться). Честная оговорка
    // вместо тихого недосчёта (Task 9 ревью, находка 2).
    const filledTodayCapped =
      recentRefills !== null && recentRefills.length === COFFEE_REFILL_LIMIT;

    // «Точек ждёт визита» — уникальные точки со status="underfill". Пустой
    // ответ ИЛИ ответ, где ни для одной точки эталон не задан (весь список —
    // status="unknown"), — это не «недолива нет нигде», а «нечего сравнивать»:
    // плитка тогда показывает «—», а не обманчивый ноль.
    const hasAnyTarget = fillStatus !== null && fillStatus.some((r) => r.status !== "unknown");
    const underfillLocations =
      fillStatus === null || !hasAnyTarget
        ? null
        : new Set(fillStatus.filter((r) => r.status === "underfill").map((r) => r.locationId)).size;
    const waitingVisitsFoot =
      fillStatus === null
        ? "нет данных"
        : !hasAnyTarget
          ? "эталоны не заданы"
          : "уникальных точек с недоливом";

    const emptySpirals = serviceDeficit === null ? null : serviceDeficit.length;

    // «Деньги не сняты» — максимум receivedAt по принятым инкассациям за год;
    // источник пустой (но живой) — «ни разу», источник недоступен — «—».
    const lastReceivedAt = (collRows ?? []).reduce<string | null>((max, c) => {
      if (c.status !== "received" || !c.receivedAt) return max;
      return max === null || new Date(c.receivedAt).getTime() > new Date(max).getTime()
        ? c.receivedAt
        : max;
    }, null);
    const moneyValue =
      collRows === null
        ? "—"
        : lastReceivedAt === null
          ? "ни разу"
          : `с ${shortRuDate(lastReceivedAt)}`;

    serviceKpi = [
      {
        label: "Залито сегодня",
        value:
          filledToday === null
            ? "—"
            : `${filledToday} ${plural(filledToday, "бункер", "бункера", "бункеров")}`,
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
    const vendingVisits: {
      machineSerial: string;
      createdAt: string;
      positions: number;
      units: number;
      createdBy: string | null;
    }[] = [];
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
          current = {
            machineSerial: serial,
            createdAt: row.performedAt,
            positions: 1,
            units: row.qty,
            createdBy: row.createdBy,
          };
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
    ? ([...contractors]
        .filter((e) => contractorTurnover(e) !== null)
        .sort((a, b) => (contractorTurnover(b) as number) - (contractorTurnover(a) as number))[0] ??
      null)
    : null;
  const coffeeTopProducts = coffeeOrders?.поТоварам ?? [];

  // Парк считается по СУЩНОСТЯМ автоматов, а статус берётся из карточки;
  // автомат без карточки — «в работе» (карточка фиксирует отклонение).
  // Тот же источник и то же правило использует отбор ?status= на листе
  // «Автоматы» (ниже), иначе цифра на плитке и список по клику расходятся.
  const cardByEntity = new Map((machineCards ?? []).map((c) => [c.entityId, c]));
  const parkStatusOf = (entityId: string): string =>
    cardByEntity.get(entityId)?.status || "in_service";
  const parkInService = machines.filter((e) => parkStatusOf(e.id) === "in_service");
  const parkWarehouse = machines.filter((e) => parkStatusOf(e.id) === "warehouse");
  const parkRepair = machines.filter((e) => parkStatusOf(e.id) === "repair");
  // Явный подсчёт по виду, а не вычитанием: kind === "other"/"drink"/"combo"/
  // не размечен молча утекал бы в «снек» и врал про состав парка.
  const parkInServiceCoffee = parkInService.filter(
    (e) => cardByEntity.get(e.id)?.kind === "coffee",
  ).length;
  const parkInServiceSnack = parkInService.filter(
    (e) => cardByEntity.get(e.id)?.kind === "snack",
  ).length;
  const parkInServiceOther = parkInService.length - parkInServiceCoffee - parkInServiceSnack;
  const cupsPerMachine =
    coffeeOrders !== null
      ? Math.round(coffeeOrders.всего.чашек / Math.max(1, coffeeOrders.поАвтоматам.length))
      : null;

  // График «Выручка по дням»: снек (salesDaily) + кофе (coffeeOrders.поДням) —
  // единый ряд по дате, суммируем в один Map; день без продаж одного контура
  // просто не добавляет к сумме (эквивалент 0), а не роняет весь ряд.
  const revenueByDayMap = new Map<string, number>();
  for (const d of salesDaily ?? [])
    revenueByDayMap.set(d.dt, (revenueByDayMap.get(d.dt) ?? 0) + Number(d.amount));
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
          <span className="route" title="Адрес раздела">
            {routePath}
          </span>
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
      {/* ── Полевая работа: раньше три полноразмерные панели-формы лежали
          простынёй на одной вкладке, и навигации внутри не было вовсе —
          только скролл. Это была самая длинная страница продукта. Теперь у
          каждой свой лист; «Инкассация» и «Остатки» рендерятся общими
          ветками листьев ниже (они же снимают прежний дубль инкассации,
          которая жила и секцией здесь, и листом в отчётах). */}
      {domain === "vendhub" && activeGroup === "service" && leaf?.type === "feed" && (
        <ServiceTab
          kpi={serviceKpi}
          feed={serviceFeed}
          actions={SERVICE_ACTIONS}
          // Нумерация бункеров и наборов правится в кофе-панели — теперь это
          // отдельный лист, а не секция ниже по странице.
          referenceHref={href("service:coffee")}
        />
      )}
      {domain === "vendhub" && activeGroup === "service" && leaf?.type === "coffee" && (
        <CoffeePanel defaultOwnerRef={defaultOwner?.id ?? null} />
      )}
      {domain === "vendhub" && activeGroup === "service" && leaf?.type === "snack" && (
        <VendingSupplyPanel domain={domain} />
      )}

      {/* ── SMM / CRM: деятельность объявлена в структуре, подключение — отдельным этапом ── */}
      {/* ── Настройки направления: только система ────────────────────────
          Каталог отсюда ушёл разрезом «Номенклатура» (решение Р-1), и здесь
          остаётся то, что настройками действительно является. Своих экранов
          у этих вещей пока нет — вкладка честно ведёт туда, где они живут
          сегодня, а не притворяется готовой. */}
      {domain === "vendhub" && activeGroup === "system" && (
        <div className="card" style={{ maxWidth: 720 }}>
          <div className="h2">Настройки направления</div>
          <p className="hint" style={{ marginTop: 8 }}>
            Здесь будут параметры самого направления: доступы, интеграции с источниками, реквизиты.
            Пока части этого живут на своих экранах — ссылки ниже ведут прямо туда.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
            <Link className="btn sm" href="/team">
              Люди и доступы — команда направления
            </Link>
            <Link className="btn sm" href={href("reports:sources")} scroll={false}>
              Источники данных — свежесть выгрузок и срезы
            </Link>
            <Link className="btn sm" href={href("settings:own_company")} scroll={false}>
              Профиль — реквизиты и параметры
            </Link>
          </div>
          <p className="hint" style={{ marginTop: 14 }}>
            Реестры — автоматы, товары, ингредиенты, контрагенты, склады и справочники — теперь в
            «Номенклатуре»: это данные бизнеса, а не параметры системы.
          </p>
        </div>
      )}
      {domain === "vendhub" && activeGroup === "smm" && (
        <div className="empty">
          <b>SMM — продвижение</b>
          Вебсайт, Instagram, TikTok и другие каналы направления. Деятельность объявлена в
          структуре; подключение — отдельным этапом со своей спекой.
        </div>
      )}
      {domain === "vendhub" && activeGroup === "crm" && (
        <div className="empty">
          <b>CRM — звонки и обращения</b>
          Приём обращений, анализ звонков. Деятельность объявлена в структуре; подключение —
          отдельным этапом.
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
            Core не ответил на запрос финансов. Обнови страницу; если повторяется — проверь, что
            Core обновлён до версии с финансовым контуром.
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
                <div className="foot">
                  <span className="mk" />
                  {hasMoney(owedToUs) ? "по реестру обязательств" : "нет открытых счетов"}
                </div>
              </div>
              <div className={`tile ${hasMoney(owedByUs) ? "" : "zero"}`}>
                <div className="lab">Должны мы</div>
                <div className="v">{moneyByCurrency(owedByUs)}</div>
                <div className="foot">
                  <span className="mk" />
                  {hasMoney(owedByUs) ? "поставщики и аренда" : "нет открытых счетов"}
                </div>
              </div>
              <div className={`tile ${obligations.overdueTotal > 0 ? "is-hot" : "zero"}`}>
                <div className="lab">Просрочено</div>
                <div className="v">{obligations.overdueTotal}</div>
                <div className="foot">
                  <span className="mk" />
                  {obligations.overdueTotal > 0 ? "требует твоего решения" : "просрочек нет"}
                </div>
              </div>
              <Link href={href("tasks")} className={`tile ${openTasks.length === 0 ? "zero" : ""}`}>
                <div className="lab">Открытых задач</div>
                <div className="v">{openTasks.length}</div>
                <div className="foot">
                  <span className="mk" />
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
                  <div className="wf">
                    ключ сведения — ИНН<span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("catalog:equipment")} className="wt">
                  <div className="wl">Техника HELI</div>
                  <div className="wv">{byType["equipment"] ?? 0}</div>
                  <div className="wf">
                    единиц в каталоге<span className="go">→</span>
                  </div>
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
                    <Link
                      href={href("docs:contract")}
                      className="navlink"
                      style={{ justifyContent: "center" }}
                    >
                      Все на исходе — {grContracts.dueSoon.length}
                    </Link>
                  )}
                </div>
              )}
              {grContracts.badDate > 0 && (
                <div className="warn" style={{ marginTop: 10 }}>
                  <b>Договоры с непонятной датой: {grContracts.badDate}</b>
                  Срок окончания не разобрать — в «на исходе» они не попали. Открой карточку и
                  поправь дату, иначе срок пройдёт незамеченным.
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
                  <div className="wf">
                    свои платежи<span className="go">→</span>
                  </div>
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
              <div className="sect-h">
                <h3 className="h2">Предприятие</h3>
              </div>
              <div className="wgrid">
                <div className={`wt ${hasRevenue30 ? "" : "off"}`}>
                  <div className="wl">Выручка · 30 дней</div>
                  <div className="wv">
                    {hasRevenue30 ? Math.round(revenue30).toLocaleString("ru-RU") : "—"}
                  </div>
                  <div className="wf">
                    {hasRevenue30
                      ? `кофе ${((coffeeRevenue30 ?? 0) / 1_000_000).toFixed(1)} + снек ${((snackRevenue30 ?? 0) / 1_000_000).toFixed(1)} млн`
                      : "нет данных"}
                  </div>
                </div>
                <div className={`wt ${coffeeOrders ? "" : "off"}`}>
                  <div className="wl">Средний чек кофе</div>
                  <div className="wv">
                    {coffeeOrders ? coffeeOrders.всего.среднийЧек.toLocaleString("ru-RU") : "—"}
                  </div>
                  <div className="wf">сум за чашку · маржа — в отчёте «Себестоимость»</div>
                </div>
                {/* I3: плитка = вопрос («сколько?»), клик = ответ (details — по
                    автомату). Период — с последней ПРИНЯТОЙ инкассации; для
                    автоматов без единой инкассации оценка идёт за всю историю
                    продаж (честно посчитано, а не отсутствие данных). */}
                <details className={`wt cash-estimate ${cashEstimate ? "" : "off"}`}>
                  <summary>
                    <div className="wl">Деньги в автоматах ≈</div>
                    <div className="wv">
                      {cashEstimate ? Math.round(cashEstimate.всего).toLocaleString("ru-RU") : "—"}
                    </div>
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
                              <small>
                                {m.с === null ? "за всю историю" : `с ${shortRuDate(m.с)}`}
                              </small>
                            </div>
                            <span className="pill">{m.сумма.toLocaleString("ru-RU")} сум</span>
                          </div>
                        ))}
                    </div>
                  )}
                </details>
                <Link
                  href={href("service:feed")}
                  className={`wt ${attentionTotal > 0 ? "is-hot" : ""}`}
                >
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
              <div className="sect-h">
                <h3 className="h2">Быстрые действия</h3>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                <QuickActions
                  domain={domain}
                  actions={["Пополнение автоматов", "Инкассация", "Ремонт / выезд"]}
                  defaultOwnerRef={defaultOwner?.id ?? null}
                />
                <Link href={href("tasks")} className="btn sm">
                  + Задача
                </Link>
              </div>
            </div>
          )}

          {/* ── Контуры: кофе и снек — сжато до 2+2 виджетов по канвасу
                 (design/dashboard-redesign/Main.dc.html). Полные цифры и
                 быстрые действия контуров — на вкладке «Обслуживание» и в
                 «Отчётах», overview даёт только пульс. ── */}
          {domain === "vendhub" && (
            <div className="sect">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                  gap: 18,
                }}
              >
                <div>
                  <div className="sect-h">
                    <h3 className="h2">Кофе</h3>
                    {coffeeOrders !== null && coffeeOrders.неВыдано > 0 && (
                      <span className="chip h">не выдано · {coffeeOrders.неВыдано}</span>
                    )}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                      gap: 10,
                    }}
                  >
                    <Link
                      href={href("service:coffee")}
                      className={`wt ${coffeeOrders ? "" : "off"}`}
                    >
                      <div className="wl">Чашек · 30 дней</div>
                      <div className="wv">
                        {coffeeOrders ? coffeeOrders.всего.чашек.toLocaleString("ru-RU") : "—"}
                      </div>
                      <div className="wf">
                        {coffeeOrders
                          ? `чек ${coffeeOrders.всего.среднийЧек.toLocaleString("ru-RU")} сум`
                          : "нет данных"}
                        <span className="go">→</span>
                      </div>
                    </Link>
                    <Link
                      href={href("service:coffee")}
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
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                      gap: 10,
                    }}
                  >
                    <Link href={href("reports:sale")} className={`wt ${salesSummary ? "" : "off"}`}>
                      <div className="wl">Продано вчера</div>
                      <div className="wv">
                        {salesSummary
                          ? `${Number(salesSummary.yesterday.qty).toLocaleString("ru-RU")} шт`
                          : "—"}
                      </div>
                      <div className="wf">
                        {salesSummary
                          ? `${Number(salesSummary.yesterday.amount).toLocaleString("ru-RU")} сум`
                          : "нет данных"}
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
              <div className="sect-h">
                <h3 className="h2">Деньги и партнёры</h3>
              </div>
              <div className="wgrid">
                <Link
                  href={href("reports:purchase")}
                  className={`wt ${supplySummary ? "" : "off"}`}
                >
                  <div className="wl">Закупки · 30 дней</div>
                  <div className="wv">
                    {supplySummary
                      ? Math.round(supplySummary.purchases30.total).toLocaleString("ru-RU")
                      : "—"}
                  </div>
                  <div className="wf">
                    по журналу прихода<span className="go">→</span>
                  </div>
                </Link>
                <Link
                  href={href("settings:contractor")}
                  className={`wt ${contractorsLoaded ? "" : "off"}`}
                >
                  <div className="wl">Поставщики</div>
                  <div className="wv">{contractorsLoaded ? contractors.length : "—"}</div>
                  <div className="wf">
                    {topContractor ? `крупнейший: ${topContractor.name}` : "нет данных по обороту"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link
                  href={href("service:collection")}
                  className={`wt ${collSummary ? "" : "off"}`}
                >
                  <div className="wl">Инкассация · 30 дней</div>
                  <div className="wv">
                    {collSummary ? Number(collSummary.receivedSum).toLocaleString("ru-RU") : "—"}
                  </div>
                  <div className="wf">
                    принято инкассаций: {collSummary ? collSummary.receivedCount : "—"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link
                  href={href("service:coffee")}
                  className={`wt ${coffeeTopProducts.length > 0 ? "" : "off"}`}
                >
                  <div className="wl">Топ товара</div>
                  <div className="wv">{coffeeTopProducts[0]?.товар ?? "—"}</div>
                  <div className="wf">
                    {coffeeTopProducts.length > 1
                      ? coffeeTopProducts
                          .slice(1, 3)
                          .map((p) => p.товар)
                          .join(" · ")
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
              <div className="sect-h">
                <h3 className="h2">Парк</h3>
              </div>
              <div className="wgrid">
                <Link
                  href={href("settings:machine", "in_service")}
                  className={`wt ${machineCards ? "" : "off"}`}
                >
                  <div className="wl">В работе</div>
                  <div className="wv">{machineCards ? parkInService.length : "—"}</div>
                  <div className="wf">
                    {machineCards
                      ? `${parkInServiceCoffee} кофе · ${parkInServiceSnack} снек${parkInServiceOther > 0 ? ` · ${parkInServiceOther} другое` : ""}`
                      : "нет данных"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link
                  href={href("settings:machine", "warehouse")}
                  className={`wt ${machineCards ? "" : "off"}`}
                >
                  <div className="wl">На складе</div>
                  <div className="wv">{machineCards ? parkWarehouse.length : "—"}</div>
                  <div className="wf">
                    простаивают<span className="go">→</span>
                  </div>
                </Link>
                <Link
                  href={href("settings:machine", "repair")}
                  className={`wt ${machineCards ? "" : "off"}`}
                >
                  <div className="wl">В ремонте</div>
                  <div className="wv">{machineCards ? parkRepair.length : "—"}</div>
                  <div className="wf">
                    не в строю<span className="go">→</span>
                  </div>
                </Link>
                <Link
                  href={href("settings:machine")}
                  className={`wt ${cupsPerMachine !== null ? "" : "off"}`}
                >
                  <div className="wl">Выработка · чаш/авт</div>
                  <div className="wv">{cupsPerMachine ?? "—"}</div>
                  <div className="wf">
                    30 дней<span className="go">→</span>
                  </div>
                </Link>
              </div>
            </div>
          )}

          {/* ── График: выручка по дням, кофе + снек одним рядом ── */}
          {domain === "vendhub" && revenueByDay.length > 1 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Выручка по дням</h3>
              </div>
              <p className="hint" style={{ marginBottom: 0 }}>
                Кофе + снек · 30 дней:
              </p>
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
                Просрочено
                {obligations.overdueTotal > 20
                  ? ` — показаны 20 из ${obligations.overdueTotal}`
                  : ""}
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
                  Всего просрочек: {obligations.overdueTotal}. Список показывает первые 200 по дате
                  — разберись со старшими, остальные подтянутся.
                </p>
              )}
            </>
          )}

          {/* I4 (ревью 20.08.2026): у VendHub «Что заведено» дублирует SETTINGS
              (тот же реестр по типам, тот же счётчик) — оставлено только для
              остальных направлений, у которых своей навигации по разделам
              с живым счётчиком ещё нет. */}
          {domain !== "vendhub" && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Что заведено</h3>
              </div>
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
                            <Link
                              href={href(`${g.key}:${l.type}`)}
                              className="wt"
                              key={`${g.key}:${l.type}`}
                            >
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
                          <Link
                            href={href(`${g.key}:${l.type}`)}
                            className="wt"
                            key={`${g.key}:${l.type}`}
                          >
                            <div className="wl">{l.label}</div>
                            <div className="wv">{n}</div>
                            <div className="wf">
                              записей<span className="go">→</span>
                            </div>
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
                    Тип и точка подтягиваются из учёта склада сами; остальное можно дозаполнить в
                    карточке.
                  </p>
                )}
              </div>
            </details>
          )}
        </>
      )}

      {/* ── Отчёты → По источникам: витрина; вход в детальный срез — драйв по params ── */}
      {group &&
        leaf?.type === "sources" &&
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
      {group && leaf?.type === "purchase" && (
        <>
          <PurchasesView />
          {/* Мастер разового переноса истории закупок. Раньше это был
              отдельный лист верхнего уровня, специально внесённый в список
              «не гасить», чтобы чип не тускнел, — то есть система
              принудительно подсвечивала то, что нужно раз в жизни. Он
              отработал один раз: 35 партий, все израсходованы. Код никуда не
              делся, изменился масштаб входа. */}
          {domain === "vendhub" && (
            <details className="sect" style={{ marginTop: 18 }}>
              <summary className="h2" style={{ cursor: "pointer" }}>
                Импорт истории закупок
              </summary>
              <p className="hint" style={{ margin: "8px 0 12px" }}>
                Разовый перенос: файл → предпросмотр с предложением карточек → запись. Обычный
                приход приходит сюда сам из учёта склада.
              </p>
              <RegisterImport
                ingredientCards={
                  importIngredientCards?.map((e) => ({
                    id: e.id,
                    name: e.name,
                    type: e.type,
                    attrs: e.attrs,
                  })) ?? null
                }
                warehouses={importWarehouses?.map((e) => ({ id: e.id, name: e.name })) ?? null}
              />
            </details>
          )}
        </>
      )}
      {group && leaf?.type === "machine_stock" && <MachineStockView />}

      {/* ── План закупа (срез П5a): что купить, куда везти и как разложить
          по слотам. Считает ядро (/vending/plan) — панель только показывает,
          чтобы её числа не разъехались с ботом. ── */}
      {group && leaf?.type === "buy_plan" && <PurchasePlanView domain={domain} />}

      {/* ── Усушка (П4, R-P4-3): по дням БЕЗ заливок, порог по позиции за
          период. Считает ядро (/vending/shrinkage) — лист только показывает,
          чтобы его числа не разъехались с утренним алертом и ботом. ── */}
      {group && leaf?.type === "shrinkage" && <ShrinkageView domain={domain} days={shrinkDays} />}

      {/* ── Журнал заливок (R-H-5): что автомат получил по снимкам и была ли
          запись оператора. Мёртвый клиент `vendingRefillEvents` (0 вызовов с
          П4) получает потребителя. ── */}
      {group && leaf?.type === "refill_events" && <RefillEventsView domain={domain} days={refillEventDays} />}

      {/* ── Аналитика снек-контура (П5b): маржа по проданному, мёртвый сток и
          цены (изменения, витрина против эталона, динамика по месяцам).
          Считает ядро (/vending/margin, /vending/dead-stock,
          /vending/price-changes + /vending/price-gap) — панель только
          показывает, чтобы её числа не разъехались с ботом и недельной
          сводкой. Кофе сюда не входит (R-P5b-9). ── */}
      {group && leaf?.type === "margin" && <MarginView domain={domain} days={marginDays} />}
      {group && leaf?.type === "dead_stock" && <DeadStockView domain={domain} days={deadStockDays} />}
      {group && leaf?.type === "prices" && <VendingPricesView domain={domain} days={priceDays} />}

      {/* ── Правила закупа (срез П5a): блок / исключение / фикс-количество
          по товару вендинга — форма поверх прайса (Task 6), своих карточек
          реестра лист не заводит. ── */}
      {group && leaf?.type === "purchase_rules" && <ProductRulesView domain={domain} />}

      {/* ── Импорт закупок (Task 4): файл → предпросмотр и сопоставление имён → запись ── */}
      {/* ── Сроки годности (Task 5): партии — счётчики по флагам, плитка =
          фильтр (?flag=), поиск ?q=, три честных пустых состояния ── */}
      {group && leaf?.type === "expiry" && (
        <ExpiryBook
          report={expiryReport}
          hrefBase={`/domain/${domain}`}
          tab={active}
          q={q ?? ""}
          flag={sp.flag}
        />
      )}

      {/* ── Сверка кассы (срез К, задача 6; R-K9 + R-K11): автомат → касса → счёт,
          три секции, период + поиск по автомату, три честных пустых состояния ── */}
      {group && leaf?.type === "cash_reconcile" && (
        <CashReconcile
          reconcile={reconcileResult}
          cash={cashReport}
          hrefBase={`/domain/${domain}`}
          tab={active}
          from={reconcileFrom}
          to={reconcileTo}
          defaultFrom={CASH_RECONCILE_DEFAULT_FROM}
          defaultTo={todayKey}
          isDefaultPeriod={isDefaultPeriod}
          q={q ?? ""}
        />
      )}

      {/* ── Норма и факт (срез F, задача 5): периоды бункера, итог ТОЛЬКО из
          ядра (по полным периодам), неполные — отдельным блоком по причинам,
          без порогов и красного (R-F3) — заменяет старую «Сверку» кофе-
          бункеров (снята из навигации в coffee-client.tsx, шаг 5 брифа) ── */}
      {group && leaf?.type === "norm_fact" && (
        <NormFactBook
          report={normFactReport}
          hrefBase={`/domain/${domain}`}
          tab={active}
          from={normFactFrom}
          to={normFactTo}
          defaultFrom={NORM_FACT_DEFAULT_FROM}
          defaultTo={todayKey}
          isDefaultPeriod={isDefaultPeriod}
          q={q ?? ""}
        />
      )}

      {/* ── Пробелы (срез К, задача 6, шаг 3): что нельзя посчитать, почему, что
          сделать — пустой список это хорошая новость, а не ошибка ── */}
      {group && leaf?.type === "gaps" && (
        <GapsBook gaps={gapsResult} hrefBase={`/domain/${domain}`} tab={active} q={q ?? ""} />
      )}

      {/* ── Товары: журнал как в ПО владельца — поиск, категории, незаполненные ──
          Единый образец листа (§4): KPI сверху, «+ Запись» — в строке
          действия. Поиск и подвкладки категорий остаются внутри ProductsBook —
          у него уже есть своя GET-форма, второй ListShell не рисует. */}
      {group &&
        leaf?.type === "product" &&
        (() => {
          const incompleteCount = leafItems.filter(isIncomplete).length;
          return (
            <ListShell
              kpi={[
                { label: "Всего", value: String(leafItems.length) },
                {
                  label: "Незаполненные",
                  value: String(incompleteCount),
                  hot: incompleteCount > 0,
                },
              ]}
              action={<NewEntityForm domain={domain} type="product" label={typeOne("product")} />}
              searchQ={q ?? ""}
            >
              <ProductsBook
                items={leafItems}
                q={q ?? ""}
                cat={cat ?? ""}
                inc={inc === "1"}
                vid={vid ?? ""}
                hrefBase={`/domain/${domain}`}
                tab={active}
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
      {group &&
        leaf?.type === "ingredient" &&
        (() => {
          const ingredientQuery = (q ?? "").trim().toLowerCase();
          const shownIngredients = ingredientQuery
            ? leafItems.filter((e) => e.name.toLowerCase().includes(ingredientQuery))
            : leafItems;
          const withPrice = leafItems.filter((e) => cardPrice(e.attrs) !== null).length;
          const linkedIds = new Set(
            (bunkerConfig ?? [])
              .filter((b) => b.entityId !== null)
              .map((b) => b.entityId as string),
          );
          const linkedCount =
            bunkerConfig === null ? null : leafItems.filter((e) => linkedIds.has(e.id)).length;
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
              action={
                <NewEntityForm domain={domain} type="ingredient" label={typeOne("ingredient")} />
              }
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
                            {price
                              ? `${price.price.toLocaleString("ru-RU")} сум/${price.unit}`
                              : "—"}
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
      {domain === "globerent" &&
        activeGroup === "units" &&
        (unitsLoadError ? (
          <CoreDown detail={`Склад техники: ${unitsLoadError}`} />
        ) : (
          <UnitsPanel units={units} summary={unitsSummary} clients={unitClients} />
        ))}

      {/* ── Импортные контракты: завод → таможня → склад (перенос PROMACH) ── */}
      {domain === "globerent" &&
        activeGroup === "imports" &&
        (importsLoadError ? (
          <CoreDown detail={`Импортные контракты: ${importsLoadError}`} />
        ) : (
          <>
            <PreordersSection preorders={preorders} clients={importSuppliers} />
            <ImportsPanel imports={importsList} suppliers={importSuppliers} />
          </>
        ))}

      {/* ── Калькулятор цены HELI: движок PROMACH, расчёт в браузере ── */}
      {domain === "globerent" &&
        activeGroup === "calc" &&
        (calcLoadError ? (
          <CoreDown detail={`Калькулятор цены: ${calcLoadError}`} />
        ) : (
          <CalcPanel rates={calcRates} brv={calcBrv} fx={calcFx} />
        ))}

      {/* ── Справочник растаможки: живые ставки ТН ВЭД + БРВ (перенос PROMACH) ── */}
      {group &&
        leaf?.type === "customs_rates" &&
        (customsLoadError ? (
          <CoreDown detail={`Справочник растаможки: ${customsLoadError}`} />
        ) : (
          <CustomsRatesPanel domain={domain} rates={tnved} brv={brv} />
        ))}

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
          <NewEntityForm
            domain={domain}
            type="equipment_model"
            label={typeOne("equipment_model")}
          />
        </>
      )}

      {/* ── GLOBERENT и личный контур: документы и каталог со своими колонками ── */}
      {group && leaf?.type === "contract" && (
        <>
          {/* Живой контур продаж GLOBERENT: договор → график → оплата → акты. */}
          {domain === "globerent" &&
            (contractsLoadError ? (
              <CoreDown detail={`Договоры купли-продажи: ${contractsLoadError}`} />
            ) : (
              <div className="sect" style={{ marginTop: 0 }}>
                <div className="sect-h">
                  <h3 className="h2">Договоры купли-продажи</h3>
                  {liveContracts.length > 0 && <span className="chip">{liveContracts.length}</span>}
                </div>
                {liveContracts.map((c) => {
                  const total = Number(c.totalWithVat);
                  const paidPct =
                    total > 0 ? Math.min(100, Math.round((c.paidUzs / total) * 100)) : 0;
                  const hot = c.status === "active" && paidPct < 100;
                  return (
                    <Link
                      href={`/contracts/${c.id}`}
                      className={`trow ${hot ? "hot" : ""}`}
                      key={c.id}
                    >
                      <div className="tb">
                        <div className="tt">
                          № {c.contractNo}/ОП ·{" "}
                          {c.clientName ?? c.buyer["name"] ?? "покупатель не указан"}
                        </div>
                        <div className="tm">
                          {new Intl.NumberFormat("ru-RU").format(total)} сум ·{" "}
                          {c.status === "cancelled"
                            ? "отменён"
                            : c.status === "closed"
                              ? "закрыт"
                              : `оплачено ${paidPct}%`}
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
            ))}
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
      {group &&
        leaf?.type === "contractor" &&
        (() => {
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
              action={
                <NewEntityForm domain={domain} type="contractor" label={typeOne("contractor")} />
              }
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

      {/* ── Автоматы (vendhub, C1): полноценная панель парка, а не
          generic-книга «имя/код/номер» — так было до ревью (осиротевший
          VendingMachinesPanel, см. git show 8640e30^ для прежней вкладки
          `vending`). ?status=in_service|warehouse|repair (кликом с плиток
          «Парк» на дашборде) сужает список ДО панели — MachinesBrowser
          внутри получает уже отфильтрованные карточки. */}
      {group &&
        leaf?.type === "machine" &&
        domain === "vendhub" &&
        (() => {
          const statusFilter = isMachineStatus(sp.status) ? sp.status : null;
          const filteredMachines =
            statusFilter === null
              ? machines
              : machines.filter((e) => parkStatusOf(e.id) === statusFilter);
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

      {/* ── Справочники: хаб пяти фискальных ────────────────────────────
          Пять слотов верхнего уровня на 62 записи, которых не касались ни
          разу за 25 дней журнала, — и это рядом с «Товарами» (71 карточка).
          Теперь один лист: всё видно сразу, без вложенной навигации ради
          двух записей НДС. */}
      {domain === "vendhub" && group && leaf?.type === "refs" && (
        <>
          <p className="hint" style={{ marginBottom: 14 }}>
            Фискальные справочники направления. Коды ИКПУ, упаковки и штрих-кодов дублируются в
            карточках товаров — если значения разошлись, верным считается то, что в карточке.
          </p>
          {REFS_TYPES.map((r) => {
            const items = refsItems?.[r.type] ?? [];
            return (
              <div className="sect" key={r.type}>
                <div className="sect-h">
                  <h3 className="h2">
                    {r.label} <span className="n">×{items.length}</span>
                  </h3>
                  <NewEntityForm domain={domain} type={r.type} label={r.one} />
                </div>
                {items.length === 0 ? (
                  <div className="empty">
                    <b>Записей нет</b>
                    Заведи первую — она понадобится при выставлении документов.
                  </div>
                ) : (
                  <div className="book">
                    {items.map((e) => (
                      <Link className="tr" href={`/card/${e.id}`} key={e.id}>
                        <span className="nm">{e.name}</span>
                        <span className="cd mono">{String((e.attrs ?? {})["код"] ?? "")}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* ── Себестоимость: честная заглушка ──────────────────────────────
          Отчёта ещё нет, и это записанное обещание владельцу: решением
          20.08.2026 валовая маржа снята с плитки дашборда ИМЕННО в этот
          отчёт. Поэтому лист не удаляем, а показываем прямо, чего не хватает
          и что это даст — «пустой экран всегда говорит, что сделать»
          (правило 29.07.2026). Раньше клик сюда молча открывал «По
          источникам»: у листа не было типа, адрес строился по подписи, и
          резолвер его не находил. */}
      {group && leaf?.type === "cost" && (
        <div className="card">
          <div className="h2">Себестоимость</div>
          <p className="hint" style={{ marginTop: 8 }}>
            Отчёт считается из закупочных цен по составам карточек. Сейчас он не построен: цена
            ингредиента берётся только через единый расчёт, а часть карточек ещё без состава —
            результат был бы занижен молча, а не пуст.
          </p>
          <p className="hint" style={{ marginTop: 8 }}>
            Что закроет пробел: заполнить состав у карточек-рецептов и цены закупки у ингредиентов.
            Что уже посчитано — в «Расходе сырья» и «Норме и факте».
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Link className="btn sm" href={href("reports:consumption")} scroll={false}>
              Расход сырья
            </Link>
            <Link className="btn sm" href={href("reports:norm_fact")} scroll={false}>
              Норма и факт
            </Link>
            <Link className="btn sm" href={href("reports:gaps")} scroll={false}>
              Пробелы
            </Link>
          </div>
        </div>
      )}

      {/* ── Группа: записи выбранной подвкладки ── Единый образец листа (§4):
          KPI сверху («Всего записей», «Не утверждено»), поиск по ?q= —
          сервером, тем же приёмом, что у ProductsBook (подстрока имени,
          регистронезависимо), форму рисует сам ListShell — у generic-книги
          своей нет. Действует не только на VendHub: под этот рендер попадают
          и generic-листы GLOBERENT (например «Таможенные посты»). */}
      {group &&
        leaf?.type &&
        ![
          "sources",
          "collection",
          "sale",
          "product",
          "ingredient",
          "purchase",
          "machine_stock",
          "consumption",
          "contract",
          "invoice",
          "contractor",
          "equipment",
          "equipment_model",
          "customs_rates",
          "recipe",
          "machine",
          "expiry",
          "cash_reconcile",
          "gaps",
          "buy_plan",
          "purchase_rules",
          "shrinkage",
          "refill_events",
          "margin",
          "dead_stock",
          "prices",
          "norm_fact",
          "cost",
          "feed",
          "coffee",
          "snack",
          "refs",
        ].includes(leaf.type) &&
        (() => {
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
                      <span style={{ textAlign: "right" }}>
                        {leaf.type === "product" ? "Цена" : "Номер"}
                      </span>
                    </div>
                    {shownItems.map((e) => {
                      const price = (e.attrs ?? {})["цена"];
                      return (
                        <Link href={`/card/${e.id}`} className="tr" key={e.id}>
                          <span className="nm">{e.name}</span>
                          <span className="cd">
                            {String((e.attrs ?? {})["ИКПУ"] ?? (e.attrs ?? {})["код"] ?? "")}
                          </span>
                          <span className="pr">
                            {typeof price === "number" ? (
                              <>
                                {Number(price).toLocaleString("ru-RU")}{" "}
                                <span className="u">сум</span>
                              </>
                            ) : (
                              (e.externalRef ?? "—")
                            )}
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
                  <span className="av2">
                    {p.name
                      .split(" ")
                      .map((w) => w[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()}
                  </span>
                  <div className="pb">
                    <div className="pn">{p.name}</div>
                    <div className="pr2">{p.role ?? "роль не указана"}</div>
                  </div>
                  {p.tgChatId ? (
                    <span className="tag-tg">в Telegram</span>
                  ) : (
                    <span className="chip">не подключён</span>
                  )}
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
            <div
              className="wgrid"
              style={{
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                marginBottom: 14,
              }}
            >
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
                    <div className="tb">
                      <div className="tt">{t.title}</div>
                    </div>
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
