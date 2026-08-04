import Link from "next/link";
import { notFound } from "next/navigation";
import { DOMAINS, DOMAIN_LABELS, dueLabel, type Domain } from "@mydon/shared";
import {
  core,
  CoreUnavailable,
  type BrvValue,
  type Entity,
  type FinanceCounterparty,
  type FinanceFlow,
  type FinanceSummary,
  type Obligations,
  type Person,
  type Task,
  type TnvedRate,
} from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { groupsFor } from "../../../lib/domain-nav";
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
import { VendingPanel } from "../../../components/vending-panel";
import { CoffeePanel } from "../../../components/coffee-panel";
import {
  ContractorsBook,
  ContractsBook,
  EquipmentBook,
  InvoicesBook,
} from "../../../components/globerent-books";
import { FinancePanel } from "../../../components/finance-panel";
import { CustomsRatesPanel } from "../../../components/customs-rates";
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

  const isOverview = activeGroup === "overview";

  // Реестр направления и метки вкладок (команда, задачи) нужны на любой вкладке —
  // их тянем всегда. Реестр — сердце страницы: его провал показываем как «Core лёг».
  let entities: Entity[];
  let people: Person[] = [];
  let tasks: Task[] = [];
  try {
    entities = await core.entitiesOf(domain);
    try {
      [people, tasks] = await Promise.all([core.people(), core.tasks({ domain })]);
    } catch {
      // команда и задачи — не повод ронять страницу направления
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
  const byType = entities.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});

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
  if (domain === "globerent" && (isFinanceTab || isOverview)) {
    finSummary = await core.financeSummary(domain).catch(() => null);
    if (isFinanceTab) {
      [finFlows, finCounterparties] = await Promise.all([
        core.financeFlows(domain, { limit: "100" }).catch(() => [] as FinanceFlow[]),
        core.financeCounterparties(domain).catch(() => [] as FinanceCounterparty[]),
      ]);
    }
  }

  // «Должны» — только открытые обязательства: оплаченное (actual) и отменённое
  // долгом не является (ловилось при переносе финконтура PROMACH).
  const isOpenObligation = (t: { status: string }) => t.status !== "actual" && t.status !== "cancelled";
  const owedToUs = obligations.totals.filter((t) => t.direction === "in" && isOpenObligation(t));
  const owedByUs = obligations.totals.filter((t) => t.direction === "out" && isOpenObligation(t));

  const href = (t: string) => `/domain/${domain}?tab=${encodeURIComponent(t)}`;

  // ── верхний ряд вкладок ────────────────────────────────────────────────────
  const topTabs = [
    { key: "overview", label: "Дашборд" },
    // Живые операционные инструменты VendHub — раньше отдельные пункты сайдбара
    // («Система»), теперь вкладки этого же рабочего места: один адрес
    // направления, а не разрозненные экраны.
    ...(domain === "vendhub" ? [{ key: "vending", label: "Автоматы" }, { key: "coffee", label: "Кофе-бункеры" }] : []),
    // Финансы GLOBERENT — живой контур (перенос PROMACH): агинг, к сроку, курс.
    ...(domain === "globerent" ? [{ key: "finance", label: "Финансы" }] : []),
    ...groups.map((g) => ({ key: g.key, label: g.label })),
    // Инкассация — ежедневная операция, ей место в верхнем ряду (слово владельца).
    ...(domain === "vendhub"
      ? [
          { key: "collect", label: `Инкассация${(collSummary?.pending ?? 0) > 0 ? ` ${collSummary!.pending}` : ""}` },
        ]
      : []),
    { key: "team", label: `Команда${ourPeople.length > 0 ? ` ${ourPeople.length}` : ""}` },
    { key: "tasks", label: `Задачи${openTasks.length > 0 ? ` ${openTasks.length}` : ""}` },
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
    group && leaf?.type ? entities.filter((e) => e.type === leaf.type).sort((a, b) => a.name.localeCompare(b.name, "ru")) : [];

  // Справочник растаможки (ставки ТН ВЭД + БРВ) — живые таблицы Core, не реестр.
  let tnved: TnvedRate[] = [];
  let brv: BrvValue[] = [];
  if (group && leaf?.type === "customs_rates") {
    [tnved, brv] = await Promise.all([
      core.tnvedRates().catch(() => [] as TnvedRate[]),
      core.brvValues().catch(() => [] as BrvValue[]),
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
            const LIVE = ["sources", "collection", "sale", "purchase", "machine_stock", "consumption", "customs_rates"];
            const n = l.type && LIVE.includes(l.type) ? -1 : l.type ? (byType[l.type] ?? 0) : 0;
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

      {/* ── Живые операционные вкладки VendHub ── */}
      {activeGroup === "vending" && <VendingPanel machines={machines} />}
      {activeGroup === "coffee" && <CoffeePanel defaultOwnerRef={defaultOwner?.id ?? null} />}

      {/* ── Финансы GLOBERENT: агинг, к сроку, термометр, кэш-флоу, ввод ── */}
      {isFinanceTab &&
        (finSummary !== null ? (
          <FinancePanel
            domain={domain}
            summary={finSummary}
            flows={finFlows}
            counterparties={finCounterparties}
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
              <Link href={href("catalog:machine_stock")} style={{ color: "var(--hot)", fontWeight: 600 }}>
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
                  href={href("collect")}
                  className={`tile ${collSummary.pending > 0 ? "is-hot" : "zero"}`}
                >
                  <div className="lab">Ждут приёма</div>
                  <div className="v">{collSummary.pending}</div>
                  <div className="foot"><span className="mk" />
                    {collSummary.pending > 0 ? "пересчитай и прими" : "всё принято"}
                    <span className="go">→</span>
                  </div>
                </Link>
                <Link href={href("collect")} className={`tile ${collSummary.receivedSum === 0 ? "zero" : ""}`}>
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
                <Link href={href("coffee")} className="wt">
                  <div className="wl">Сигналы (недолив · мойка)</div>
                  <div className="wv">{coffeeAlerts ?? "—"}</div>
                  <div className="wf">{coffeeAlerts === 0 ? "спокойно" : "смотреть сверку"}<span className="go">→</span></div>
                </Link>
                <Link href={href("coffee")} className="wt">
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
                <Link href={href("coffee")} className="wt">
                  <div className="wl">Точек в расходе</div>
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

      {/* ── Инкассация: живой экран VendCash (верхняя вкладка и подвкладка отчётов) ── */}
      {(activeGroup === "collect" || (group && leaf?.type === "collection")) && <CollectionsView />}

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
          {leafItems.length > 0 ? (
            <ContractsBook items={leafItems} today={todayKey} />
          ) : (
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

      {/* ── Группа: записи выбранной подвкладки ── */}
      {group && leaf?.type && !["sources", "collection", "sale", "product", "purchase", "machine_stock", "consumption", "contract", "invoice", "contractor", "equipment", "equipment_model", "customs_rates"].includes(leaf.type) && (
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

      {/* ── Команда направления ── */}
      {activeGroup === "team" &&
        (ourPeople.length === 0 ? (
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
        ))}

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
