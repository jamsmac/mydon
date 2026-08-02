import { core, CoreUnavailable, type VendingMachine, type VendingNeed } from "../../lib/core";
import { CoreDown } from "../../components/core-down";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<VendingMachine["status"], string> = {
  ok: "в расчёте",
  no_slots: "слоты не назначены",
  uncalibrated: "нужен Audit (199)",
};

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
  try {
    [machines, needs] = await Promise.all([core.vendingMachines(), core.vendingDeficit()]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

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
          <p>Сбор ещё не приносил данных.</p>
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
