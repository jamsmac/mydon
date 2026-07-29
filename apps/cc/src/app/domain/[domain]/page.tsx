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
import { MachineMap } from "../../../components/machine-map";
import { QuickActions } from "../../../components/quick-actions";
import { typeOne } from "../../../lib/labels";
import { money, plural, when } from "../../../lib/format";

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
  searchParams: Promise<{ tab?: string }>;
}) {
  const { domain } = await params;
  const { tab } = await searchParams;
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
  const coffeeMachines = machines.filter((e) => Number((e.attrs ?? {})["категория"]) === 10).length;
  const snackMachines = machines.length - coffeeMachines;
  const defaultOwner = ourPeople.find((p) => p.active === "yes" && p.tgChatId) ?? ourPeople[0] ?? null;
  const openTasks = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const byType = entities.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});

  const owedToUs = obligations.totals.filter((t) => t.direction === "in");
  const owedByUs = obligations.totals.filter((t) => t.direction === "out");
  const sum = (rows: typeof owedToUs) => rows.reduce((s, r) => s + Number(r.amount || 0), 0);

  const href = (t: string) => `/domain/${domain}?tab=${encodeURIComponent(t)}`;

  // ── верхний ряд вкладок ────────────────────────────────────────────────────
  const topTabs = [
    { key: "overview", label: "Дашборд" },
    ...groups.map((g) => ({ key: g.key, label: g.label })),
    { key: "team", label: `Команда${ourPeople.length > 0 ? ` ${ourPeople.length}` : ""}` },
    { key: "tasks", label: `Задачи${openTasks.length > 0 ? ` ${openTasks.length}` : ""}` },
  ];

  const group = groups.find((g) => g.key === activeGroup);
  // Внутри группы по умолчанию открыта первая подвкладка с данными.
  const leaf =
    group?.leaves.find((l) => l.type === activeLeaf) ??
    group?.leaves.find((l) => l.type !== null && (byType[l.type] ?? 0) > 0) ??
    group?.leaves[0];
  const leafItems =
    group && leaf?.type ? entities.filter((e) => e.type === leaf.type).sort((a, b) => a.name.localeCompare(b.name, "ru")) : [];

  return (
    <>
      <div className="page-head">
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
            const n = l.type === "collection" ? -1 : l.type ? (byType[l.type] ?? 0) : 0;
            const isActive = leaf === l;
            return (
              <Link
                key={l.label}
                href={href(`${group.key}:${l.type ?? l.label}`)}
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
            <div className={`tile ${sum(owedToUs) === 0 ? "zero" : ""}`}>
              <div className="lab">Должны нам</div>
              <div className="v">{money(sum(owedToUs))}</div>
              <div className="foot"><span className="mk" />{sum(owedToUs) === 0 ? "нет открытых счетов" : "по реестру обязательств"}</div>
            </div>
            <div className={`tile ${sum(owedByUs) === 0 ? "zero" : ""}`}>
              <div className="lab">Должны мы</div>
              <div className="v">{money(sum(owedByUs))}</div>
              <div className="foot"><span className="mk" />{sum(owedByUs) === 0 ? "нет открытых счетов" : "поставщики и аренда"}</div>
            </div>
            <div className={`tile ${obligations.overdue.length > 0 ? "is-hot" : "zero"}`}>
              <div className="lab">Просрочено</div>
              <div className="v">{obligations.overdue.length}</div>
              <div className="foot"><span className="mk" />{obligations.overdue.length > 0 ? "требует твоего решения" : "просрочек нет"}</div>
            </div>
            <Link href={href("tasks")} className={`tile ${openTasks.length === 0 ? "zero" : ""}`}>
              <div className="lab">Открытых задач</div>
              <div className="v">{openTasks.length}</div>
              <div className="foot"><span className="mk" />{openTasks.length > 0 ? "по направлению" : "задач нет"}<span className="go">→</span></div>
            </Link>
          </div>

          {domain === "vendhub" && machines.length > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Автоматы на карте</h3>
                <span className="chip b">кофе ×{coffeeMachines}</span>
                <span className="chip g">снеки ×{snackMachines}</span>
              </div>
              <MachineMap machines={machines} />
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
                <span className="chip">структура из VendHub-OS</span>
              </div>
              <div className="wgrid">
                {["Выручка сегодня", "Продажи сегодня", "Оплаты Payme · Click · Uzum", "Топ товаров по выручке"].map((l) => (
                  <div className="wt off" key={l}>
                    <div className="wl">{l}</div>
                    <div className="wv">—</div>
                    <div className="wf">появится после сбора</div>
                  </div>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                Эти цифры живут в журнале продаж твоего ПО (VHM24). Пришли сохранённую
                страницу «Журнал продаж» — и виджеты оживут, как ожили товары и автоматы.
              </p>
            </div>
          )}

          {obligations.overdue.length > 0 && (
            <>
              <div className="section-title">Просрочено</div>
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

      {/* ── Инкассация: живой экран VendCash вместо пустого списка записей ── */}
      {group && leaf?.type === "collection" && <CollectionsView />}

      {/* ── Группа: записи выбранной подвкладки ── */}
      {group && leaf?.type && leaf.type !== "collection" && (
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
