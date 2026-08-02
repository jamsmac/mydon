import {
  core,
  CoreUnavailable,
  type VendingMachine,
  type VendingNeed,
  type VendingOrder,
  type VendingPurchase,
  type VendingRunout,
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

/** Статус накладной закупа по-русски (§5.7). */
const ORDER_LABEL: Record<VendingOrder["status"], string> = {
  approved: "одобрена",
  ordered: "заказана",
  received: "принята",
  cancelled: "отменена",
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
  let critical: VendingRunout[] = [];
  let orders: VendingOrder[] = [];
  let purchase: VendingPurchase = {
    items: [],
    excludedNoSales: [],
    noPrice: [],
    totalBuy: 0,
    totalOrder: 0,
    costExact: 0,
    costRounded: 0,
    overpay: 0,
  };
  try {
    let forecast: { critical: VendingRunout[] };
    [machines, needs, forecast, purchase, orders, syncRuns] = await Promise.all([
      core.vendingMachines(),
      core.vendingDeficit(),
      core.vendingForecast(),
      core.vendingPurchase(),
      core.vendingOrders(),
      core.vendingSyncRuns(),
    ]);
    critical = forecast.critical;
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  const sum = (n: number) => n.toLocaleString("ru-RU");
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

      {critical.length > 0 && (
        <>
          <div className="section-title">Скоро кончится</div>
          <div className="rows">
            {critical.map((r) => (
              <div className="row" key={r.product}>
                <div className="t">
                  <b>{r.product}</b>
                  <small>
                    в автоматах {r.inMachines.toLocaleString("ru-RU")} · расход {r.daily.toFixed(1)}/день
                  </small>
                </div>
                <span className={`pill ${r.daysLeft !== null && r.daysLeft <= 1 ? "bad" : ""}`}>
                  {r.daysLeft === null ? "—" : `${r.daysLeft.toFixed(1)} дн`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {purchase.items.length > 0 && (
        <>
          <div className="section-title">Закуп</div>
          <div className="page-head">
            <p>
              Купить <b>{sum(purchase.totalBuy)}</b> ед · с округлением до упаковок <b>{sum(purchase.totalOrder)}</b> ед
              {purchase.costRounded > 0 && (
                <>
                  {" "}на <b>{sum(purchase.costRounded)}</b> сум
                  {purchase.overpay > 0 && <span className="muted"> (переплата за упаковки {sum(purchase.overpay)})</span>}
                </>
              )}
            </p>
          </div>
          <div className="rows">
            {purchase.items.map((i) => (
              <div className="row" key={i.product}>
                <div className="t">
                  <b>{i.product}</b>
                  <small>
                    нехватка {sum(i.buy)} · упаковка {i.pack}
                    {i.noPrice ? " · нет цены" : ` · ${sum(i.costRounded)} сум`}
                  </small>
                </div>
                <span className="pill">{sum(i.order)} ед</span>
              </div>
            ))}
          </div>
          {purchase.excludedNoSales.length > 0 && (
            <p className="muted">
              Не закупать (нет продаж): {purchase.excludedNoSales.map((i) => i.product).join(", ")}
            </p>
          )}
          {purchase.noPrice.length > 0 && (
            <p className="muted">Без цены в прайсе — на разбор: {purchase.noPrice.join(", ")}</p>
          )}
        </>
      )}

      {orders.length > 0 && (
        <>
          <div className="section-title">Накладные закупа</div>
          <div className="rows">
            {orders.map((o) => {
              const when = new Date(o.createdAt).toLocaleDateString("ru-RU", {
                timeZone: "Asia/Tashkent",
                day: "2-digit",
                month: "2-digit",
              });
              return (
                <div className="row" key={o.id}>
                  <div className="t">
                    <b>
                      {when} · {o.positions} поз.
                    </b>
                    <small>
                      {o.costRounded > 0 ? `${sum(o.costRounded)} сум` : "без суммы"}
                      {o.createdBy ? ` · ${o.createdBy}` : ""}
                    </small>
                  </div>
                  <span className={`pill ${o.status === "received" ? "ok" : ""}`}>{ORDER_LABEL[o.status]}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

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
