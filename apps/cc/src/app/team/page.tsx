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

export const dynamic = "force-dynamic";

/** Порядок разделов: сначала дела, потом личное, потом неприкаянные. */
const DOMAIN_ORDER = ["globerent", "vendhub", "personal", "mydon", null] as const;
const DOMAIN_TITLES: Record<string, string> = {
  globerent: "GLOBERENT",
  vendhub: "VendHub",
  personal: "Личный контур",
  mydon: "MYDON",
};

/** Короткая строка качества: показываем только то, что есть — без нулей-шума. */
function qualityLine(w: Workload | undefined): string {
  if (!w) return "";
  const parts: string[] = [];
  if (w.doneWithDue > 0) parts.push(`в срок ${Math.round((w.doneOnTime / w.doneWithDue) * 100)}%`);
  if (w.excellent > 0) parts.push(`отлично ×${w.excellent}`);
  if (w.redo > 0) parts.push(`переделки ×${w.redo}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function PersonRow({ p, w }: { p: Person; w: Workload | undefined }) {
  return (
    <Link href={`/team/${p.id}`} className="row rowlink">
      <div className="t">
        <b>{p.name}</b>
        <small>
          {p.role ?? "роль не указана"}
          {w ? ` · висит ${w.open}${w.overdue > 0 ? `, просрочено ${w.overdue}` : ""}` : ""}
          {qualityLine(w)}
        </small>
      </div>
      <span className={`pill ${p.tgChatId ? "ok" : ""}`}>
        {p.tgChatId ? "в Telegram" : "не подключён"}
      </span>
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
              <div className="rows">
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
      <div className="rows">
        {agents.map((a) => {
          const w = byRef.get(`agent:${a.name}`);
          return (
            <Link href={`/agents/${a.name}`} className="row rowlink" key={a.id}>
              <div className="t">
                <b>{a.name}</b>
                <small>
                  {a.description ?? "без описания"}
                  {w && w.open > 0 ? ` · висит ${w.open}` : ""}
                </small>
              </div>
              <span className={`pill ${a.status === "active" ? "ok" : ""}`}>
                {a.status === "active" ? "работает" : "выключен"}
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
