import Link from "next/link";
import { maintenanceKindLabel, partAttentionLabel, partLabel, partLocationLabel } from "@mydon/shared";
import { core, CoreUnavailable, type MaintenanceLogRow, type PartUnit, type PartUnitPeriod } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { PartUnitEditor } from "../../../components/part-unit-editor";

export const dynamic = "force-dynamic";

const дата = (d: string | null): string => (d ? d.split("-").reverse().join(".") : "—");

/** Карточка физического узла: паспорт, где сейчас, история периодов и работ. */
export default async function PartUnitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let unit: PartUnit;
  let history: PartUnitPeriod[] = [];
  let logs: MaintenanceLogRow[] = [];
  try {
    unit = await core.part(id);
    [history, logs] = await Promise.all([core.partUnitHistory(id).catch(() => []), core.partLogs(id).catch(() => [])]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const where = unit.where
    ? unit.where.machineName
      ? `${unit.where.machineName}${unit.where.slot !== null ? ` · слот ${unit.where.slot}` : ""} (с ${дата(unit.where.since)})`
      : `${partLocationLabel(unit.where.location)} (с ${дата(unit.where.since)})`
    : "местонахождение неизвестно — найдётся при инвентаризации";

  return (
    <>
      <div className="page-head">
        <Link href="/parts" className="back">
          ← Все узлы
        </Link>
        <h1>
          {partLabel(unit.partKind)} {unit.inventoryNo ?? "(без номера)"}
        </h1>
        <p>
          {unit.retiredAt ? `Списан ${дата(unit.retiredAt)}${unit.retiredReason ? ` — ${unit.retiredReason}` : ""}` : where}
          {unit.attention.map((a) => (
            <span key={a} className="pill act" style={{ marginLeft: 6 }}>
              {partAttentionLabel(a)}
            </span>
          ))}
        </p>
      </div>

      <PartUnitEditor unit={unit} />

      <section className="group-block">
        <div className="section-title">
          Где стоял и лежал
          <span className="group-count">{history.length}</span>
        </div>
        {history.length === 0 ? (
          <div className="empty">
            <b>Периодов нет</b>
            Узел заведён, но ни на автомат не ставился, ни на склад не клался.
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Где</th>
                <th>С</th>
                <th>По</th>
                <th>Причина</th>
                <th>Примечание</th>
              </tr>
            </thead>
            <tbody>
              {history.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.machineName
                      ? `${p.machineName}${p.slot !== null ? ` · слот ${p.slot}` : ""}`
                      : partLocationLabel(p.location)}
                  </td>
                  <td>{дата(p.installedOn)}</td>
                  <td>{p.removedOn ? дата(p.removedOn) : "сейчас"}</td>
                  <td>{p.reason ?? "—"}</td>
                  <td>{p.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {logs.length > 0 && (
        <section className="group-block">
          <div className="section-title">
            Работы по узлу
            <span className="group-count">{logs.length}</span>
          </div>
          <div className="rows">
            {logs.map((l) => (
              <div className="row" key={l.id}>
                <div className="t">
                  {maintenanceKindLabel(l.kind)}
                  {l.note && <small> · {l.note}</small>}
                </div>
                <span className="when">{дата(l.performedOn)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
