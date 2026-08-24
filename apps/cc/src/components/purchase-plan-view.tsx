import { TZ } from "@mydon/shared";
import {
  core,
  type VendingPlan,
  type VendingPlanSlot,
  type VendingPurchaseItem,
} from "../lib/core";
import { when } from "../lib/format";
import { SubmitPurchaseButton } from "./purchase-plan-submit";

const n = (v: number): string => v.toLocaleString("ru-RU");
const day = (iso: string): string => new Date(iso).toLocaleDateString("ru-RU", { timeZone: TZ });

/** Откуда закроется слот: показываем только ненулевые источники. */
function slotSource(s: VendingPlanSlot): string {
  const parts: string[] = [];
  if (s.fromPurchase > 0) parts.push(`закуп ${n(s.fromPurchase)}`);
  if (s.fromStock > 0) parts.push(`склад ${n(s.fromStock)}`);
  if (s.unfilled > 0) parts.push(`пусто ${n(s.unfilled)}`);
  return parts.length > 0 ? parts.join(" · ") : "нечем";
}

/** Потребность по автоматам именами, а не серийниками: план читает человек в маршруте. */
function perMachineLine(item: VendingPurchaseItem, names: Map<string, string>): string {
  return Object.entries(item.perMachine)
    .map(([serial, qty]) => `${names.get(serial) ?? serial}: ${n(qty)}`)
    .join(" · ");
}

/**
 * Лист «План закупа» (П5a) без похода в Core — витрина готового плана.
 *
 * Порядок секций отвечает на вопросы в том порядке, в каком они возникают у
 * владельца: сколько всего загрузим и во что это встанет → можно ли верить
 * складу → куда едем → что купить (и кнопка «оформить») → что не купим по
 * правилу → что собрать со склада перед выездом → что делать у каждого
 * автомата по слотам.
 */
export function PurchasePlanTables({ plan, domain }: { plan: VendingPlan; domain: string }) {
  const { summary, stock, machines, warnings } = plan;
  const load = summary.totalFromPurchase + summary.totalFromStock;
  // Потребность = раздача + то, что не закроется: `need` каждой позиции ровно
  // так и раскладывается, поэтому отдельного итога потребности не нужно.
  const need = load + summary.totalUnfilled;
  const names = new Map(machines.map((m) => [m.serial, m.name]));
  // Со склада берут не только закупаемые позиции: убранные правилом и «без
  // продаж» тоже едут в автоматы тем, что уже лежит на полке.
  const fromStock = [...summary.items, ...summary.excludedByRule, ...summary.excludedNoSales].filter(
    (i) => i.fromStock > 0,
  );

  return (
    <>
      <p className="lead">
        Загрузить {n(load)} из {n(need)} нужных · со склада {n(summary.totalFromStock)} · купить{" "}
        <b>{n(summary.totalOrder)}</b> ед ({summary.items.length} поз.) на <b>{n(summary.costRounded)}</b> сум · пусто{" "}
        {n(summary.totalUnfilled)}
      </p>

      <div className="rows" style={{ marginBottom: 14 }}>
        <div className="row">
          <div className="t">
            <b>{stock.asOf === null ? "Склад ещё не считали" : `Склад на ${day(stock.asOf)}`}</b>
            <small>
              сейчас {n(stock.totalBefore)} · возьмём {n(stock.use)} · вернём {n(stock.back)} · станет{" "}
              {n(stock.totalAfter)}
            </small>
          </div>
          {stock.stale && <span className="pill bad">устарел</span>}
        </div>
        {warnings.map((w, i) => (
          <div className="row" key={`${w.code}:${i}`}>
            <div className="t">
              <small>⚠️ {w.message}</small>
            </div>
          </div>
        ))}
        <div className="row">
          <div className="t">
            <small>План посчитан {when(plan.generatedAt)} — живёт до следующего сбора Ourvend.</small>
          </div>
        </div>
      </div>

      <div className="section-title">Маршрут</div>
      {machines.length === 0 ? (
        <div className="empty">
          <b>Загружать нечего</b>
          Ни один автомат в строю не просит пополнения — или сбор Ourvend ещё не приносил слотов.
        </div>
      ) : (
        <div className="rows">
          {machines.map((m) => (
            <div className="row" key={m.serial}>
              <span className="pill">{m.routeIndex}</span>
              <div className="t">
                <b>{m.name}</b>
                <small>
                  {m.serial} · закуп {n(m.fromPurchase)} · склад {n(m.fromStock)} · пусто {n(m.unfilled)}
                </small>
              </div>
              <span className="pill">
                {n(m.fromPurchase + m.fromStock)} из {n(m.need)} ед
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="section-title">Купить</div>
      {summary.items.length === 0 ? (
        <div className="empty">
          <b>Закупать нечего</b>
          Потребность закрывается складом — или всё, чего не хватает, убрано из закупки правилом.
        </div>
      ) : (
        <div className="rows">
          {summary.items.map((i) => (
            <div className="row" key={i.product}>
              <div className="t">
                <b>{i.product}</b>
                <small>
                  нужно {n(i.need)} · склад {n(i.stock)} · купить {n(i.buy)} · заказ {n(i.order)} · в автоматы{" "}
                  {n(i.fromPurchase)} · на склад {n(i.toStock)}
                </small>
              </div>
              {i.fixedQty !== null && <span className="pill">фикс {n(i.fixedQty)}</span>}
              {i.noPrice && <span className="pill bad">нет цены</span>}
              <span className="pill">{i.noPrice ? `${n(i.order)} ед` : `${n(i.costRounded)} сум`}</span>
            </div>
          ))}
        </div>
      )}
      <SubmitPurchaseButton domain={domain} />

      {summary.excludedNoSales.length > 0 && (
        <p className="muted">
          Не закупать (нет продаж): {summary.excludedNoSales.map((i) => i.product).join(", ")}
        </p>
      )}
      {summary.noPrice.length > 0 && (
        <p className="muted">Без цены в прайсе — на разбор: {summary.noPrice.join(", ")}</p>
      )}

      {summary.excludedByRule.length > 0 && (
        <>
          <div className="section-title">Убрано из закупки</div>
          <div className="rows">
            {summary.excludedByRule.map((i) => (
              <div className="row" key={i.product}>
                <div className="t">
                  <b>{i.product}</b>
                  <small>
                    нужно {n(i.need)} · со склада {n(i.fromStock)} · пусто {n(i.unfilled)}
                  </small>
                </div>
                <span className="pill">правило товара</span>
              </div>
            ))}
          </div>
        </>
      )}

      {fromStock.length > 0 && (
        <>
          <div className="section-title">Собрать со склада</div>
          <div className="rows">
            {fromStock.map((i) => (
              <div className="row" key={i.product}>
                <div className="t">
                  <b>{i.product}</b>
                  <small>
                    сейчас {n(i.stock)} · после {n(i.stockAfter)} · по автоматам {perMachineLine(i, names)}
                  </small>
                </div>
                <span className="pill">взять {n(i.fromStock)} ед</span>
              </div>
            ))}
          </div>
        </>
      )}

      {machines
        .filter((m) => m.slots.length > 0)
        .map((m) => (
          <details className="sect" open key={m.serial}>
            <summary className="h2" style={{ cursor: "pointer" }}>
              Слоты — {m.name}
            </summary>
            <div className="rows" style={{ marginTop: 10 }}>
              {m.slots.map((s) => (
                <div className="row" key={s.coilId}>
                  <span className="pill">{s.coilId}</span>
                  <div className="t">
                    <b>{s.product}</b>
                    <small>
                      было {n(s.quantity)} из {n(s.capacity)} · нужно {n(s.need)} · {slotSource(s)}
                    </small>
                  </div>
                  <span className="pill">{n(s.fromPurchase + s.fromStock)} ед</span>
                </div>
              ))}
            </div>
          </details>
        ))}
    </>
  );
}

/**
 * Лист «План закупа»: один поход в Core за готовым планом (П5a).
 *
 * Расчёт целиком в ядре — здесь ни одной формулы: панель и бот обязаны
 * показывать одни и те же числа, а два независимых расчёта разъезжаются.
 */
export async function PurchasePlanView({ domain }: { domain: string }) {
  let plan: VendingPlan;
  try {
    plan = await core.vendingPlan();
  } catch {
    return (
      <div className="empty">
        <b>План недоступен</b>
        Core не ответил — обнови страницу.
      </div>
    );
  }
  return <PurchasePlanTables plan={plan} domain={domain} />;
}
