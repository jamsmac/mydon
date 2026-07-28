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

/**
 * Команда: люди и агенты в одном месте.
 *
 * Исполнители бывают живые и виртуальные, но задачи им ставятся одинаково —
 * значит и смотреть на них владелец должен в одном списке, а не гадать,
 * в каком разделе искать «кто на меня работает».
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

      <div className="section-title">Люди</div>
      {people.length === 0 ? (
        <div className="empty">
          <b>Сотрудников пока нет</b>
          Добавь первого — и сможешь поручать ему задачи.
        </div>
      ) : (
        <div className="rows">
          {people.map((p) => {
            const w = byRef.get(`human:${p.id}`);
            return (
              <Link href={`/team/${p.id}`} className="row rowlink" key={p.id}>
                <div className="t">
                  <b>{p.name}</b>
                  <small>
                    {p.role ?? "роль не указана"}
                    {w ? ` · висит ${w.open}${w.overdue > 0 ? `, просрочено ${w.overdue}` : ""}` : ""}
                    {w && w.doneLast7d > 0 ? ` · за неделю сделал ${w.doneLast7d}` : ""}
                  </small>
                </div>
                <span className={`pill ${p.tgChatId ? "ok" : ""}`}>
                  {p.tgChatId ? "в Telegram" : "не подключён"}
                </span>
              </Link>
            );
          })}
        </div>
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
