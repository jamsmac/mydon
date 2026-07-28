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
import { MONO_KEYS } from "../../../lib/labels";
import { money, plural, when } from "../../../lib/format";

export const dynamic = "force-dynamic";

const mono = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace" } as const;

function isDomain(v: string): v is Domain {
  return (DOMAINS as readonly string[]).includes(v);
}

/** Краткая строка под названием записи: цена для товара, номер для машины. */
function subtitle(e: Entity): string {
  const a = e.attrs ?? {};
  const parts: string[] = [];
  if (typeof a["цена"] === "number") parts.push(`${Number(a["цена"]).toLocaleString("ru-RU")} сум`);
  if (e.externalRef) parts.push(e.externalRef);
  return parts.join(" · ") || "—";
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
        <h1>{DOMAIN_LABELS[domain]}</h1>
        <p>
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
            const n = l.type ? (byType[l.type] ?? 0) : 0;
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
            <div className="tile">
              <div className="v calm">{money(sum(owedToUs))}</div>
              <div className="k">должны нам</div>
            </div>
            <div className="tile">
              <div className="v calm">{money(sum(owedByUs))}</div>
              <div className="k">должны мы</div>
            </div>
            <div className="tile">
              <div className={`v ${obligations.overdue.length > 0 ? "alarm" : "calm"}`}>
                {obligations.overdue.length}
              </div>
              <div className="k">просрочено</div>
            </div>
            <div className="tile">
              <div className={`v ${openTasks.length > 0 ? "" : "calm"}`}>{openTasks.length}</div>
              <div className="k">открытых задач</div>
            </div>
          </div>

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

          <div className="section-title">Что заведено</div>
          {entities.length === 0 ? (
            <div className="empty">
              <b>Пока пусто</b>
              Данные собираются со страниц ПО и попадают сюда после твоего «Одобрить».
            </div>
          ) : (
            <div className="rows">
              {groups.flatMap((g) =>
                g.leaves
                  .filter((l) => l.type !== null && (byType[l.type] ?? 0) > 0)
                  .map((l) => (
                    <Link
                      href={href(`${g.key}:${l.type}`)}
                      className="row rowlink"
                      key={`${g.key}:${l.type}`}
                    >
                      <div className="t">
                        <b>{l.label}</b>
                        <small>{g.label}</small>
                      </div>
                      <span className="pill">{byType[l.type!]}</span>
                    </Link>
                  )),
              )}
            </div>
          )}
        </>
      )}

      {/* ── Группа: записи выбранной подвкладки ── */}
      {group &&
        (leaf?.type && leafItems.length > 0 ? (
          <div className="rows">
            {leafItems.map((e) => (
              <Link href={`/card/${e.id}`} className="row rowlink" key={e.id}>
                <div className="t">
                  <b>{e.name}</b>
                  <small style={e.externalRef && MONO_KEYS.has("серийник") ? mono : undefined}>
                    {subtitle(e)}
                  </small>
                </div>
                <span className="pill">открыть</span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty">
            <b>{leaf?.label}: данных пока нет</b>
            Появятся после сбора со страницы ПО и твоего «Одобрить». Пришли сохранённую
            страницу с этими данными — и вкладка оживёт.
          </div>
        ))}

      {/* ── Команда направления ── */}
      {activeGroup === "team" &&
        (ourPeople.length === 0 ? (
          <div className="empty">
            <b>В этом направлении пока никого</b>
            Назначь сотруднику направление в его карточке — он появится здесь.
          </div>
        ) : (
          <div className="rows">
            {ourPeople.map((p) => (
              <Link href={`/team/${p.id}`} className="row rowlink" key={p.id}>
                <div className="t">
                  <b>{p.name}</b>
                  <small>{p.role ?? "роль не указана"}</small>
                </div>
                <span className={`pill ${p.tgChatId ? "ok" : ""}`}>
                  {p.tgChatId ? "в Telegram" : "не подключён"}
                </span>
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
          <div className="rows">
            {openTasks.map((t) => (
              <Link href={`/tasks/${t.id}`} className="row rowlink" key={t.id}>
                <div className="t">
                  <b>{t.title}</b>
                  <small>{dueLabel(t.due)}</small>
                </div>
              </Link>
            ))}
          </div>
        ))}
    </>
  );
}
