import { normalizeMachineSerial, parseMenu } from "@mydon/shared";
import { MachinesBrowser, type MachineListItem } from "./machines-browser";
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
  type VendingShrinkageReport,
  type VendingSyncRun,
} from "../lib/core";
import { SHRINKAGE_PANEL_DAYS, ShrinkageAlerts, ShrinkageAlertsFailed } from "./shrinkage-view";
import { OurvendHealthSection } from "./ourvend-health-view";
import { CoreDown } from "./core-down";
import { NewEntityForm } from "./entity-new";
import { count } from "../lib/format";
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
 * «Автоматы» — только список аппаратов (слово владельца): выбрал автомат —
 * открыл его карточку. Живой дефицит, закуп и «что доложить» переехали на
 * соседнюю вкладку «Пополнение», чтобы список не тонул в товарной аналитике.
 * Поиск, фильтры, сортировка и вид (список/плитки) — в MachinesBrowser.
 */
export async function VendingMachinesPanel({ machines }: { machines: Entity[] }) {
  // Строка «когда собирали» — контекст свежести; её провал список не роняет.
  let syncLine: string | null = null;
  try {
    syncLine = lastSyncLine(await core.vendingSyncRuns());
  } catch {
    // список карточек живёт и без журнала сбора
  }

  // Вид и состояние всего парка одним запросом; провал — фильтры по виду
  // просто опираются на attrs-категорию.
  const cardById = new Map<string, { kind: string; status: string; statusNote: string | null }>();
  try {
    for (const c of await core.machineCards()) cardById.set(c.entityId, c);
  } catch {
    // без карточек вида список остаётся списком
  }

  // Живая заполненность Ourvend по серийнику — для плиток и сортировки
  // «кого заправлять». Дополнение: без неё список не падает.
  const liveBySerial = new Map<string, VendingMachine>();
  try {
    for (const m of await core.vendingMachines()) {
      if (m.status === "ok") liveBySerial.set(normalizeMachineSerial(m.serial), m);
    }
  } catch {
    // живого контура нет — плитки без полосок заполненности
  }

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

  const cards = [...machines].sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const items: MachineListItem[] = cards.map((e) => {
    const attrs = e.attrs ?? {};
    const card = cardById.get(e.id);
    // Канон вида — machine_card; фолбэк — attrs-категория (10 кофе / 11 снек).
    const kind =
      card?.kind && card.kind !== "other"
        ? card.kind
        : machineKind(e) === "кофе"
          ? "coffee"
          : machineKind(e) === "снек"
            ? "snack"
            : (card?.kind ?? null);
    const live = e.externalRef ? liveBySerial.get(normalizeMachineSerial(e.externalRef)) : undefined;
    const point = attrs["точка"];
    return {
      id: e.id,
      name: e.name,
      serial: e.externalRef ?? null,
      point: typeof point === "string" && point !== "" ? point : null,
      kind,
      status: card?.status ?? "in_service",
      statusNote: card?.statusNote ?? null,
      fillRate: live?.fillRate ?? null,
      deficit: live?.deficit ?? null,
      bunkers: bunkersByEntity.get(e.id) ?? null,
      menuCount: parseMenu(e.attrs).length,
    };
  });

  return (
    <>
      <p className="lead">
        Автоматов в реестре: <b>{cards.length}</b>
        {syncLine ? ` · ${syncLine.toLowerCase()}` : ""}
      </p>

      {cards.length === 0 ? (
        <div className="empty">
          <b>В реестре пока нет автоматов</b>
          Добавь карточку кнопкой ниже — или пришли сохранённую страницу ПО, соберу всё разом.
        </div>
      ) : (
        <MachinesBrowser items={items} />
      )}
      <NewEntityForm domain="vendhub" type="machine" label={typeOne("machine")} />
    </>
  );
}

/**
 * «Пополнение» — живой контур Ourvend поверх реестра: что кончается, что
 * купить, накладные, дефицит по автоматам и «что доложить». Сюда переехали
 * товарные секции бывшей вкладки «Автоматы» — сам список аппаратов остался там.
 */
export async function VendingSupplyPanel({ domain = "vendhub" }: { domain?: string }) {
  let ourvendMachines: VendingMachine[] = [];
  let needs: VendingNeed[] = [];
  let syncRuns: VendingSyncRun[] = [];
  let critical: VendingRunout[] = [];
  let orders: VendingOrder[] = [];
  let purchase: VendingPurchase = {
    items: [],
    excludedNoSales: [],
    excludedByRule: [],
    noPrice: [],
    allocation: "purchase-first",
    totalNeed: 0,
    totalCovered: 0,
    totalBuy: 0,
    totalOrder: 0,
    costExact: 0,
    costRounded: 0,
    overpay: 0,
    shortfallCost: 0,
    costByPriceFull: 0,
    totalFromPurchase: 0,
    totalFromStock: 0,
    totalUnfilled: 0,
    totalToStock: 0,
  };
  // Усушка уходит ОТДЕЛЬНЫМ запросом и ВМЕСТЕ с основным пакетом.
  // Отдельным — потому что она читает снимки и продажи за две недели и падает
  // по своим причинам, а вкладка «Снек» нужна для пополнения и обязана
  // открываться без неё. Вместе — потому что последовательным `await` после
  // Promise.all она добавила бы своё время к открытию вкладки целиком.
  // `null` значит «ядро не ответило»: секция всё равно рисуется, но честным
  // «не проверили» (final-review (d)) — молчание здесь читалось бы как
  // «порог не превышен», а мы даже не спросили.
  const усушка: Promise<VendingShrinkageReport | null> = core
    .vendingShrinkage(SHRINKAGE_PANEL_DAYS)
    .catch(() => null);
  // Здоровье сбора (П5b, R-P5b-8) — по той же причине и тем же способом:
  // свой запрос, свой отказ, но старт вместе с основным пакетом, иначе
  // вкладка ждала бы его последовательно. Отказ ловит сама секция.
  const здоровье = OurvendHealthSection();

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
  const shrinkage = await усушка;
  const syncLine = lastSyncLine(syncRuns);

  const ok = ourvendMachines.filter((m) => m.status === "ok");
  const totalDeficit = ok.reduce((a, m) => a + m.deficit, 0);
  const totalCap = ok.reduce((a, m) => a + m.capacity, 0);
  const totalFilled = ok.reduce((a, m) => a + m.filled, 0);
  const fillRate = totalCap > 0 ? Math.round((totalFilled / totalCap) * 100) : 0;
  const hasLive = ourvendMachines.length > 0;

  return (
    <>
      {hasLive ? (
        <p className="lead">
          К пополнению: <b>{count(totalDeficit)}</b> ед · заполненность {fillRate}% · автоматов в
          расчёте {ok.length} из {ourvendMachines.length}
        </p>
      ) : (
        <p className="lead">Живой сбор Ourvend ещё не приносил данных{syncLine ? ` · ${syncLine.toLowerCase()}` : ""}</p>
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
                    в автоматах {count(r.inMachines)} · расход {r.daily.toFixed(1)}/день
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

      {shrinkage ? <ShrinkageAlerts report={shrinkage} domain={domain} /> : <ShrinkageAlertsFailed />}

      {/* Здоровье сбора рядом с усушкой: обе секции про то, можно ли
          верить числам вкладки. 12 отказов подряд с 24.08 никто не
          заметил — смотреть было некуда (R-P5b-8). */}
      {await здоровье}

      {purchase.items.length > 0 && (
        <>
          <div className="section-title">Закуп</div>
          <div className="page-head">
            <p>
              Купить <b>{count(purchase.totalBuy)}</b> ед · с округлением до упаковок <b>{count(purchase.totalOrder)}</b> ед
              {purchase.costRounded > 0 && (
                <>
                  {" "}на <b>{count(purchase.costRounded)}</b> сум
                  {purchase.overpay > 0 && <span className="muted"> (переплата за упаковки {count(purchase.overpay)})</span>}
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
                    нехватка {count(i.buy)} · упаковка {i.pack}
                    {i.noPrice ? " · нет цены" : ` · ${count(i.costRounded)} сум`}
                  </small>
                </div>
                <span className="pill">{count(i.order)} ед</span>
              </div>
            ))}
          </div>
          {purchase.excludedNoSales.length > 0 && (
            <p className="muted">
              Не закупать (нет продаж): {purchase.excludedNoSales.map((i) => i.product).join(", ")}
            </p>
          )}
          {/* Убранные правилом владельца не попадали сюда вовсе: их не видно
              ни в списке закупа, ни рядом, и «почему этого нет в закупе»
              оставалось без ответа. */}
          {purchase.excludedByRule.length > 0 && (
            <p className="muted">
              Убрано из закупки (правило товара, грузим только со склада):{" "}
              {purchase.excludedByRule.map((i) => i.product).join(", ")}
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
                      {o.costRounded > 0 ? `${count(o.costRounded)} сум` : "без суммы"}
                      {o.createdBy ? ` · ${o.createdBy}` : ""}
                      {/* Показываем только после приёмки (§5.7) — до неё оба поля null. */}
                      {o.distributedUnits != null && o.distributedUnits > 0 && (
                        <> · в автоматы {count(o.distributedUnits)} ед.</>
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
                    −{count(m.deficit)} ед
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
                <span className="pill">{count(n.total)} ед</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!hasLive && (
        <p className="hint" style={{ marginTop: 10 }}>
          Живые остатки и дефицит появятся, когда заработает сбор Ourvend:
          задай <code>OURVEND_*</code> в окружении сервера и запусти синк.
        </p>
      )}
    </>
  );
}
