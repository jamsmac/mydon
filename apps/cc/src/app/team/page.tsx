import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type AgentCard,
  type Person,
  type Workload,
} from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { NewPersonForm } from "../../components/person-new";
import { rolesLabel } from "@mydon/shared";

export const dynamic = "force-dynamic";

/** Порядок разделов: сначала дела, потом личное, потом неприкаянные. */
const DOMAIN_ORDER = ["globerent", "vendhub", "personal", "mydon", null] as const;
const DOMAIN_TITLES: Record<string, string> = {
  globerent: "GLOBERENT",
  vendhub: "VendHub",
  personal: "Личный контур",
  mydon: "MYDON",
};

function PersonRow({ p, w }: { p: Person; w: Workload | undefined }) {
  const initials = p.name.split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();
  return (
    <Link href={`/team/${p.id}`} className="prow">
      <span className="av2">{initials}</span>
      <div className="pb">
        <div className="pn">{p.name}</div>
        <div className="pr2">{p.role ?? "роль не указана"}</div>
        {/* Права доступа — не то же, что должность в карточке: от них
            зависит, какие кнопки человек видит в боте. */}
        {p.tgChatId && <div className="pr2">{rolesLabel(p.roles ?? [])}</div>}
        {w && (
          <div className="stats">
            <span>висит <b>{w.open}</b></span>
            {w.overdue > 0 && (
              <span style={{ color: "var(--hot)" }}>просрочено <b style={{ color: "var(--hot)" }}>{w.overdue}</b></span>
            )}
            {w.doneWithDue > 0 && <span>в срок <b>{Math.round((w.doneOnTime / w.doneWithDue) * 100)}%</b></span>}
            {w.excellent > 0 && <span>отлично <b>×{w.excellent}</b></span>}
            {w.redo > 0 && <span>переделки <b>×{w.redo}</b></span>}
          </div>
        )}
      </div>
      {p.tgChatId ? <span className="tag-tg">в Telegram</span> : <span className="chip">не подключён</span>}
    </Link>
  );
}

/**
 * Команда: люди внутри своих направлений, агенты рядом.
 *
 * Сотрудник нанят в конкретное дело (GLOBERENT, VendHub…) — значит и смотреть
 * на него надо внутри дела: кто где работает, что висит, какое качество.
 * Плоский список прятал главное — картину по направлениям.
 */
export default async function Team() {
  let people: Person[];
  let agents: AgentCard[];
  let load: Workload[] = [];
  try {
    [people, agents] = await Promise.all([core.people(), core.agents()]);
    try {
      load = await core.workload();
    } catch {
      load = []; // без нагрузки список всё равно полезен
    }
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const byRef = new Map(load.map((w) => [`${w.ownerKind}:${w.ownerRef ?? ""}`, w]));
  const notLinked = people.filter((p) => p.tgChatId === null).length;

  return (
    <>
      <div className="page-head">
        <h1>Команда</h1>
        <p>
          Людей {people.length}, агентов {agents.length}. Задачи ставятся одинаково и тем, и другим.
        </p>
      </div>

      {notLinked > 0 && (
        <div className="notice">
          <b>Не подключены к Telegram: {notLinked}</b>
          Пока сотрудник не нажал «Старт» у бота, задачи ему не дойдут — только в этом списке.
        </div>
      )}

      {people.length === 0 ? (
        <div className="empty">
          <b>Сотрудников пока нет</b>
          Добавь первого — и сможешь поручать ему задачи.
        </div>
      ) : (
        DOMAIN_ORDER.map((d) => {
          const group = people.filter((p) => (p.domain ?? null) === d);
          if (group.length === 0) return null;
          return (
            <div key={d ?? "none"}>
              <div className="section-title">
                {d === null ? "Без направления" : DOMAIN_TITLES[d]}
                <span className="group-count">{group.length}</span>
              </div>
              <div>
                {group.map((p) => (
                  <PersonRow key={p.id} p={p} w={byRef.get(`human:${p.id}`)} />
                ))}
              </div>
            </div>
          );
        })
      )}

      <div className="section-title">Добавить сотрудника</div>
      <NewPersonForm />

      <div className="section-title">Агенты</div>
      <div>
        {agents.map((a) => {
          const w = byRef.get(`agent:${a.name}`);
          return (
            <Link href={`/agents/${a.name}`} className="prow" key={a.id}>
              <span className="av2 ag">✦</span>
              <div className="pb">
                <div className="pn">{a.name}</div>
                <div className="pr2">{a.description ?? "без описания"}</div>
                {w && w.open > 0 && (
                  <div className="stats"><span>висит <b>{w.open}</b></span></div>
                )}
              </div>
              <span className={`chip ${a.status === "active" ? "g" : ""}`}>
                {a.status === "active" ? "работает" : "выключен"}
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
