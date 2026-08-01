import Link from "next/link";
import { notFound } from "next/navigation";
import { DOMAINS, DOMAIN_LABELS, dueLabel, type Domain } from "@mydon/shared";
import {
  core,
  CoreUnavailable,
  type Entity,
  type Obligations,
  type Person,
  type Task,
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
import { QuickActions } from "../../../components/quick-actions";
import { SourcesView } from "../../../components/sources-view";
import { ReportsOverview } from "../../../components/reports-overview";
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

  let obligations: Obligations;
  let entities: Entity[];
  let people: Person[] = [];
  let tasks: Task[] = [];
  try {
    [obligations, entities] = await Promise.all([core.obligations(domain), core.entitiesOf(domain)]);
    try {
      [people, tasks] = await Promise.all([core.people(), core.tasks({ domain })]);
    } catch {
      // команда и задачи — не повод ронять страницу направления
    }
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
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

  // Инкассация на дашборде: владелец должен видеть «ждут приёма» без раскопок.
  let collSummary: { pending: number; receivedCount: number; receivedSum: number } | null = null;
  let salesSummary: Awaited<ReturnType<typeof core.salesSummary>> | null = null;
  if (domain === "vendhub") {
    try {
      collSummary = await core.collectionsSummary(30);
    } catch {
      collSummary = null;
    }
    try {
      salesSummary = await core.salesSummary();
    } catch {
      salesSummary = null;
    }
  }
  let supplySummary: Awaited<ReturnType<typeof core.supplySummary>> | null = null;
  if (domain === "vendhub") {
    try {
      supplySummary = await core.supplySummary();
    } catch {
      supplySummary = null;
    }
  }
  const openTasks = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const byType = entities.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});

  const owedToUs = obligations.totals.filter((t) => t.direction === "in");
  const owedByUs = obligations.totals.filter((t) => t.direction === "out");

  const href = (t: string) => `/domain/${domain}?tab=${encodeURIComponent(t)}`;

  // ── верхний ряд вкладок ────────────────────────────────────────────────────
  const topTabs = [
    { key: "overview", label: "Дашборд" },
    ...groups.map((g) => ({ key: g.key, label: g.label })),
    // Инкассация — ежедневная операция, ей место в верхнем ряду (слово владельца).
    ...(domain === "vendhub"
      ? [
          { key: "collect", label: `Инкассация${(collSummary?.pending ?? 0) > 0 ? ` ${collSummary!.pending}` : ""}` },
          // Отчёты — витрина по источникам (сырьё, из которого берутся все цифры).
          { key: "sources", label: "Отчёты" },
        ]
      : []),
    { key: "team", label: `Команда${ourPeople.length > 0 ? ` ${ourPeople.length}` : ""}` },
    { key: "tasks", label: `Задачи${openTasks.length > 0 ? ` ${openTasks.length}` : ""}` },
  ];

  const group = groups.find((g) => g.key === activeGroup);
  // Внутри группы по умолчанию открыта первая подвкладка с данными.
  const leaf =
    group?.leaves.find((l) => l.type === activeLeaf) ??
    group?.leaves.find((l) => l.type !== null && (byType[l.type] ?? 0) > 0) ??
    // Единственный живой отчёт — Инкассация: группа открывается сразу на нём.
    group?.leaves.find((l) => l.type === "collection") ??
    group?.leaves[0];
  const leafItems =
    group && leaf?.type ? entities.filter((e) => e.type === leaf.type).sort((a, b) => a.name.localeCompare(b.name, "ru")) : [];

  // Хлебные крошки и чип маршрута (расположение из обложки): где я и как это
  // адресуется. Счётчик из подписи вкладки для крошки убираем — «Задачи 6» → «Задачи».
  const activeTab = topTabs.find((t) => t.key === activeGroup);
  const crumbLabel =
    activeTab && activeGroup !== "overview" ? activeTab.label.replace(/\s+\d+$/, "") : null;
  const routeSlug = activeGroup === "overview" ? "" : activeGroup === "sources" ? "reports" : activeGroup;
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
            const LIVE = ["collection", "sale", "purchase", "machine_stock", "consumption"];
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
              <div className="foot"><span className="mk" />{openTasks.length > 0 ? "по направлению" : "задач нет"}<span className="go">→</span></div>
            </Link>
          </div>

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

          {domain === "vendhub" && (
            <div className="sect">
              <div className="sect-h"><h3 className="h2">Быстрые действия</h3></div>
              <QuickActions
                domain={domain}
                actions={["Пополнение автоматов", "Инкассация", "Чистка кофемолок", "Ремонт / выезд"]}
                defaultOwnerRef={defaultOwner?.id ?? null}
              />
              {defaultOwner && (
                <p className="hint" style={{ marginTop: 6 }}>
                  Задача уйдёт исполнителю: {defaultOwner.name}. Поменять можно в карточке задачи.
                </p>
              )}
            </div>
          )}

          {domain === "vendhub" && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Продажи и выручка</h3>
                {salesSummary?.lastSaleDt && <span className="chip g">живые · OurVend</span>}
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

      {/* ── Отчёты: витрина по источникам; вход в детальный срез — драйв по params ── */}
      {activeGroup === "sources" &&
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

      {/* ── Группа: записи выбранной подвкладки ── */}
      {group && leaf?.type && !["collection", "sale", "product", "purchase", "machine_stock"].includes(leaf.type) && (
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
