import {
  core,
  CoreUnavailable,
  type VendingMachine,
  type VendingNeed,
  type VendingSyncRun,
} from "../../lib/core";
import { CoreDown } from "../../components/core-down";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<VendingMachine["status"], string> = {
  ok: "в расчёте",
  no_slots: "слоты не назначены",
  uncalibrated: "нужен Audit (199)",
};

const SYNC_LABEL: Record<VendingSyncRun["status"], string> = {
  running: "идёт сбор",
  success: "успешно",
  partial: "частично",
  failed: "сбой",
};

/** Строка «когда последний раз собирали» по журналу сбора Ourvend. */
function lastSyncLine(runs: VendingSyncRun[]): string | null {
  const last = runs[0];
  if (!last) return null;
  const when = new Date(last.finishedAt ?? last.startedAt).toLocaleString("ru-RU", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const tail = last.status === "success" ? "" : ` · автоматов ${last.machinesOk}/${last.machinesTotal}`;
  return `Сбор: ${when} — ${SYNC_LABEL[last.status]}${tail}`;
}

/** Цвет автомата по дефициту (§5.2): ≥100 красный, ≥50 жёлтый, иначе зелёный. */
function color(deficit: number): "bad" | "warn" | "ok" {
  if (deficit >= 100) return "bad";
  if (deficit >= 50) return "warn";
  return "ok";
}

/**
 * Автоматы и дефицит (ТЗ Фаза 1). Данные собирает коннектор Ourvend и кладёт в
 * базу; здесь — что доложить по каждому автомату и сводная потребность по
 * товарам. Пусто → сбор ещё не приносил данных (коннектор выключен или не
 * запускался).
 */
export default async function VendingPage() {
  let machines: VendingMachine[] = [];
  let needs: VendingNeed[] = [];
  let syncRuns: VendingSyncRun[] = [];
  try {
    [machines, needs, syncRuns] = await Promise.all([
      core.vendingMachines(),
      core.vendingDeficit(),
      core.vendingSyncRuns(),
    ]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  const syncLine = lastSyncLine(syncRuns);

  const ok = machines.filter((m) => m.status === "ok");
  const totalDeficit = ok.reduce((a, m) => a + m.deficit, 0);
  const totalCap = ok.reduce((a, m) => a + m.capacity, 0);
  const totalFilled = ok.reduce((a, m) => a + m.filled, 0);
  const fillRate = totalCap > 0 ? Math.round((totalFilled / totalCap) * 100) : 0;

  if (machines.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Автоматы и дефицит</h1>
          <p>{syncLine ?? "Сбор ещё не приносил данных."}</p>
        </div>
        <div className="empty">
          <b>Пока пусто</b>
          Коннектор Ourvend выключен или не запускался. Задай <code>OURVEND_*</code> в окружении и запусти сбор — здесь появятся автоматы, дефицит и что доложить.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Автоматы и дефицит</h1>
        <p>
          К пополнению: <b>{totalDeficit.toLocaleString("ru-RU")}</b> ед · заполненность {fillRate}% · автоматов в
          расчёте {ok.length} из {machines.length}
        </p>
        {syncLine && <p className="muted">{syncLine}</p>}
      </div>

      <div className="section-title">Автоматы</div>
      <div className="rows">
        {machines.map((m) => (
          <div className="row" key={m.serial}>
            <div className="t">
              <b>{m.serial}</b>
              <small>
                {m.status === "ok"
                  ? `${m.filled}/${m.capacity} · заполнено ${m.fillRate}%`
                  : STATUS_LABEL[m.status]}
              </small>
            </div>
            {m.status === "ok" ? (
              <span className={`pill ${color(m.deficit) === "ok" ? "ok" : color(m.deficit) === "bad" ? "bad" : ""}`}>
                −{m.deficit.toLocaleString("ru-RU")} ед
              </span>
            ) : (
              <span className="pill">вне расчёта</span>
            )}
          </div>
        ))}
      </div>

      {needs.length > 0 && (
        <>
          <div className="section-title">Что доложить — по товарам</div>
          <div className="rows">
            {needs.map((n) => (
              <div className="row" key={n.product}>
                <div className="t">
                  <b>{n.product}</b>
                  <small>
                    {Object.entries(n.perMachine)
                      .map(([serial, qty]) => `${serial}: ${qty}`)
                      .join(" · ")}
                  </small>
                </div>
                <span className="pill">{n.total.toLocaleString("ru-RU")} ед</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
