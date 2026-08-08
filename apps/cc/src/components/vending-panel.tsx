import Link from "next/link";
import { BunkerLevels } from "./bunker-levels";
import {
  core,
  CoreUnavailable,
  type CoffeeFillStatusRow,
  type Entity,
  type VendingMachine,
  type VendingNeed,
  type VendingOrder,
  type VendingPurchase,
  type VendingRunout,
  type VendingSyncRun,
} from "../lib/core";
import { CoreDown } from "./core-down";
import { NewEntityForm } from "./entity-new";
import { typeOne } from "../lib/labels";

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

/** Тип автомата из карточки реестра: категория 10 — кофе (как на дашборде). */
function machineKind(e: Entity): "кофе" | "снек" | null {
  const cat = (e.attrs ?? {})["категория"];
  if (cat === undefined || cat === null || cat === "") return null;
  return Number(cat) === 10 ? "кофе" : "снек";
}

/**
 * Автоматы — единая вкладка рабочего места VendHub. «Автоматы» и «аппараты» —
 * одно и то же (слово владельца), поэтому здесь И карточки реестра (всегда),
 * И живой дефицит из Ourvend поверх, когда сбор приносил данные. Отдельного
 * листа «Аппараты» в Каталоге больше нет.
 */
export async function VendingPanel({ machines }: { machines: Entity[] }) {
  let ourvendMachines: VendingMachine[] = [];
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
    [ourvendMachines, needs, forecast, purchase, orders, syncRuns] = await Promise.all([
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

  // Наглядные бункеры у кофе-машин (слово владельца): карточка автомата,
  // привязанного к кофе-точке, показывает уровни прямо в списке. Кофе-данные —
  // дополнение: их провал списка автоматов не роняет.
  const bunkersByEntity = new Map<string, CoffeeFillStatusRow[]>();
  try {
    const [coffeeLocations, fillStatus] = await Promise.all([core.coffeeLocations(), core.coffeeFillStatus()]);
    // Только места, где стоит РОВНО ОДИН аппарат. Уровни бункеров хранятся по
    // месту, а показываются на карточке аппарата: пока аппарат один — это одно
    // и то же. Если их два, чьи это бункеры — неизвестно, и подписать их
    // первым попавшимся значило бы показать владельцу выдумку.
    const locationByEntity = new Map(
      coffeeLocations
        .filter((l) => (l.machines ?? []).length === 1)
        .map((l) => [l.machines[0]!.entityId, l.id] as const),
    );
    for (const [entityId, locationId] of locationByEntity) {
      const rows = fillStatus.filter((r) => r.locationId === locationId);
      if (rows.length > 0) bunkersByEntity.set(entityId, rows);
    }
  } catch {
    // без кофе-данных карточки просто без бункеров
  }

  const ok = ourvendMachines.filter((m) => m.status === "ok");
  const totalDeficit = ok.reduce((a, m) => a + m.deficit, 0);
  const totalCap = ok.reduce((a, m) => a + m.capacity, 0);
  const totalFilled = ok.reduce((a, m) => a + m.filled, 0);
  const fillRate = totalCap > 0 ? Math.round((totalFilled / totalCap) * 100) : 0;
  const hasLive = ourvendMachines.length > 0;

  const cards = [...machines].sort((a, b) => a.name.localeCompare(b.name, "ru"));

  return (
    <>
      {hasLive ? (
        <p className="lead">
          К пополнению: <b>{totalDeficit.toLocaleString("ru-RU")}</b> ед · заполненность {fillRate}% · автоматов в
          расчёте {ok.length} из {ourvendMachines.length}
        </p>
      ) : (
        <p className="lead">
          Автоматов в реестре: <b>{cards.length}</b>
          {syncLine ? ` · ${syncLine.toLowerCase()}` : " · живой сбор Ourvend ещё не приносил данных"}
        </p>
      )}
      {hasLive && syncLine && <p className="muted">{syncLine}</p>}

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
                      {/* Показываем только после приёмки (§5.7) — до неё оба поля null. */}
                      {o.distributedUnits != null && o.distributedUnits > 0 && (
                        <> · в автоматы {sum(o.distributedUnits)} ед.</>
                      )}
                      {o.unmatchedDistribution != null && o.unmatchedDistribution.length > 0 && (
                        <span style={{ color: "var(--hot)" }}>
                          {" "}
                          · не найдено в накладной: {o.unmatchedDistribution.join(", ")}
                        </span>
                      )}
                    </small>
                  </div>
                  <span className={`pill ${o.status === "received" ? "ok" : ""}`}>{ORDER_LABEL[o.status]}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {hasLive && (
        <>
          <div className="section-title">Дефицит по автоматам</div>
          <div className="rows">
            {ourvendMachines.map((m) => (
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
        </>
      )}

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

      {/* ── Карточки реестра: те же автоматы, паспортные данные ── */}
      <div className="section-title">Карточки автоматов{cards.length > 0 ? ` · ${cards.length}` : ""}</div>
      {cards.length === 0 ? (
        <div className="empty">
          <b>В реестре пока нет автоматов</b>
          Добавь карточку кнопкой ниже — или пришли сохранённую страницу ПО, соберу всё разом.
        </div>
      ) : (
        <div className="rows">
          {cards.map((e) => {
            const attrs = e.attrs ?? {};
            const point = attrs["точка"];
            const kind = machineKind(e);
            const bunkers = bunkersByEntity.get(e.id);
            return (
              <Link href={`/card/${e.id}`} className="row" key={e.id}>
                <div className="t">
                  <b>{e.name}</b>
                  <small>
                    {e.externalRef ? `серийник ${e.externalRef}` : "серийник не указан"}
                    {typeof point === "string" && point !== "" ? ` · ${point}` : ""}
                  </small>
                </div>
                {bunkers && <BunkerLevels rows={bunkers} compact />}
                <span className={`chip ${kind === "кофе" ? "b" : kind === "снек" ? "g" : ""}`}>
                  {kind ?? "тип не указан"}
                </span>
              </Link>
            );
          })}
        </div>
      )}
      <NewEntityForm domain="vendhub" type="machine" label={typeOne("machine")} />
      {!hasLive && (
        <p className="hint" style={{ marginTop: 10 }}>
          Живые остатки и дефицит появятся поверх карточек, когда заработает сбор Ourvend:
          задай <code>OURVEND_*</code> в окружении сервера и запусти синк.
        </p>
      )}
    </>
  );
}
