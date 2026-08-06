import {
  DUE_ICON,
  DUE_LABEL,
  maintenanceKindLabel,
  OUTCOME_LABELS,
  partLabel,
  type MaintenanceOutcome,
} from "@mydon/shared";
import {
  core,
  CoreUnavailable,
  type Entity,
  type MaintenanceDue,
  type MaintenanceLogRow,
  type Person,
} from "../../lib/core";
import { CoreDown } from "../../components/core-down";

export const dynamic = "force-dynamic";

/** Сколько дней журнала показываем по умолчанию. */
const LOG_DAYS = 30;

/** YYYY-MM-DD со сдвигом на N дней назад. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Обслуживание оборудования: что горит, что стоит на автоматах, что сделано.
 *
 * Здесь владелец видит ПОЛНУЮ картину, включая зелёное и ненастроенное —
 * в отличие от бота, где технику показывается только то, что горит. Разница
 * намеренная: техник заходит узнать, что делать, владелец — понять состояние.
 */
export default async function Maintenance() {
  let due: MaintenanceDue[];
  let log: MaintenanceLogRow[] = [];
  let people: Person[] = [];
  let machines: Entity[] = [];
  try {
    [due, log, people, machines] = await Promise.all([
      core.maintenanceDue(),
      core.maintenanceLog({ from: daysAgo(LOG_DAYS) }),
      core.people(),
      core.entitiesOfType("vendhub", "machine"),
    ]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const nameOf = new Map(machines.map((m) => [m.id, m.name]));
  const personOf = new Map(people.map((p) => [p.id, p.name]));

  const overdue = due.filter((d) => d.status === "overdue");
  const soon = due.filter((d) => d.status === "due" || d.status === "soon");
  const unknown = due.filter((d) => d.status === "unknown");

  // Начатое и не закрытое старше суток — отдельный сигнал: «начал и забыл»
  // выглядит в журнале как «не приходил», и владелец не видит разницы.
  const stale = log.filter(
    (r) => r.outcome === null && Date.now() - new Date(r.createdAt).getTime() > 86_400_000,
  );

  return (
    <>
      <div className="page-head">
        <h1>Обслуживание</h1>
        <p>
          {due.length === 0
            ? "Нормативы не заведены — графиков пока нет."
            : `Нормативов ${due.length} · просрочено ${overdue.length} · скоро ${soon.length}` +
              (unknown.length > 0 ? ` · без периодичности ${unknown.length}` : "")}
        </p>
      </div>

      {stale.length > 0 && (
        <section className="group-block">
          <div className="section-title">
            Начато и не закрыто
            <span className="group-count">{stale.length}</span>
          </div>
          <p className="group-hint">
            Работа отмечена, но результат не проставлен больше суток. Стоит спросить.
          </p>
          {stale.map((r) => (
            <div key={r.id} className="row">
              <span>{nameOf.get(r.entityId) ?? "объект"}</span>
              <span>{maintenanceKindLabel(r.kind)}</span>
              <span>{r.personId ? (personOf.get(r.personId) ?? "—") : "—"}</span>
              <span>{r.performedOn}</span>
            </div>
          ))}
        </section>
      )}

      <section className="group-block">
        <div className="section-title">
          Графики
          <span className="group-count">{due.length}</span>
        </div>
        {due.length === 0 ? (
          <div className="empty">
            <b>Нормативов ещё нет</b>
            Пока не задано, как часто мыть и менять, система не может ничего напомнить.
            {/* Формы «Новый график» в панели пока нет: нормативы одинаковы для
                всего парка, и заводить их по одному через форму — сорок
                автоматов × три работы. Даём команду, которая делает это разом. */}
            Стандартные — мойка миксера 10 дней, фильтр воды 45, плановое ТО 90 — заводятся на
            весь парк одной командой на сервере:{" "}
            <code>node tools/apply-maintenance-norms.mjs</code>
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Объект</th>
                <th>Работа</th>
                <th>Периодичность</th>
                <th>Прошлый раз</th>
                <th>Срок</th>
                <th>Статус</th>
                <th>Кто ведёт</th>
              </tr>
            </thead>
            <tbody>
              {[...due]
                .sort((a, b) => severity(b.status) - severity(a.status) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
                .map((d) => (
                  <tr key={d.planId}>
                    <td>{d.targetName}</td>
                    <td>{d.title ?? (d.partKind ? `${d.kindLabel}: ${partLabel(d.partKind)}` : d.kindLabel)}</td>
                    <td>{periodText(d)}</td>
                    <td>{d.lastDoneOn ?? "—"}</td>
                    <td>{d.nextDueOn ?? "—"}</td>
                    <td>
                      {DUE_ICON[d.status]} {DUE_LABEL[d.status]}
                      {d.daysLeft !== null && d.status === "overdue" ? ` (${Math.abs(d.daysLeft)} дн.)` : ""}
                    </td>
                    <td>
                      {/* Закрепления за объектами нет: задача уходит в общий
                          пул, если у графика не задан именной исполнитель. */}
                      {d.assigneeId ? (personOf.get(d.assigneeId) ?? "—") : "общий список"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="group-block">
        <div className="section-title">
          Журнал работ за {LOG_DAYS} дней
          <span className="group-count">{log.length}</span>
        </div>
        {log.length === 0 ? (
          <div className="empty">
            <b>Записей нет</b>
            Сотрудники ещё ничего не отмечали в боте.
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Объект</th>
                <th>Работа</th>
                <th>Узел</th>
                <th>Кто</th>
                <th>Результат</th>
                <th>Заметка</th>
              </tr>
            </thead>
            <tbody>
              {log.map((r) => (
                <tr key={r.id}>
                  <td>{r.performedOn}</td>
                  <td>{nameOf.get(r.entityId) ?? "—"}</td>
                  <td>{maintenanceKindLabel(r.kind)}</td>
                  <td>{r.partKind ? partLabel(r.partKind) : "—"}</td>
                  <td>{r.personId ? (personOf.get(r.personId) ?? "—") : "владелец"}</td>
                  <td>{outcomeText(r.outcome)}</td>
                  <td>{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

const ORDER: Record<string, number> = { overdue: 4, due: 3, soon: 2, unknown: 1, ok: 0 };
function severity(s: string): number {
  return ORDER[s] ?? 0;
}

/** «Раз в 30 дней», «раз в 3 мес.», «раз в 5000 чашек». */
function periodText(d: MaintenanceDue): string {
  const parts: string[] = [];
  if (d.countLeft !== null) parts.push(`осталось ${d.countLeft} по счётчику`);
  if (d.nextDueOn === null && parts.length === 0) return "не задана";
  return parts.length > 0 ? parts.join(", ") : "по календарю";
}

function outcomeText(o: MaintenanceOutcome | null): string {
  // Пусто — не «неизвестно», а «начато и не закрыто»: разница видна владельцу.
  return o === null ? "начато" : OUTCOME_LABELS[o];
}
