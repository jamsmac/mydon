import { TZ } from "@mydon/shared";
import {
  core,
  type VendingPlan,
  type VendingPlanMachine,
  type VendingPlanSlot,
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

/**
 * Куда уйдёт ИМЕННО СКЛАДСКОЙ товар: «Olma 3, American Hospital 2».
 *
 * `perMachine` — это ПОТРЕБНОСТЬ автомата, а не раздача склада: у позиции,
 * которую наполовину закрывает закуп, он показывал бы «взять со склада»
 * втрое больше, чем плану нужно. Считаем по слотам плана, ровно как бот
 * (`stockByMachine` в purchase-plan.ts) — иначе панель и бот скажут разное.
 */
function stockByMachine(machines: VendingPlanMachine[], product: string): string {
  return machines
    .map((m) => ({ name: m.name, units: m.slots.filter((sl) => sl.product === product).reduce((sum, sl) => sum + sl.fromStock, 0) }))
    .filter((x) => x.units > 0)
    .map((x) => `${x.name} ${n(x.units)}`)
    .join(", ");
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
  // Со склада берут не только закупаемые позиции: убранные правилом и «без
  // продаж» тоже едут в автоматы тем, что уже лежит на полке.
  const fromStock = [...summary.items, ...summary.excludedByRule, ...summary.excludedNoSales]
    .filter((i) => i.fromStock > 0)
    // Куда уйдёт складской товар — считаем ОДИН раз на позицию: в разметке это
    // был обход всех автоматов и всех их слотов дважды на строку.
    .map((i) => ({ item: i, where: stockByMachine(machines, i.product) }));
  // «Порядок — по имени» надо объяснить: настройка есть, но её не видно с
  // этого листа, и владелец не знает, что маршрут вообще настраивается (UX#16).
  const маршрутСломан = warnings.some((w) => w.code === "route_unknown_serial");

  return (
    <>
      <p className="lead">
        Загрузить {n(load)} из {n(need)} нужных · со склада {n(summary.totalFromStock)} · купить{" "}
        <b>{n(summary.totalOrder)}</b> ед ({summary.items.length} поз.)
        {/* «на 0 сум» читалось как «бесплатно». Ноль здесь значит одно из двух:
            покупать нечего либо ни у одной позиции нет цены — это разные вещи. */}
        {summary.costRounded > 0 ? (
          <>
            {" "}
            на <b>{n(summary.costRounded)}</b> сум
            {summary.noPrice.length > 0 && (
              <span className="muted"> (без {n(summary.noPrice.length)} поз. без цены — сумма неполная)</span>
            )}
          </>
        ) : (
          summary.items.length > 0 && <span className="muted"> · сумма не посчитана — ни у одной позиции нет цены</span>
        )}
        {summary.totalUnfilled > 0 && <> · не закроется {n(summary.totalUnfilled)}</>}
      </p>

      <div className="rows" style={{ marginBottom: 14 }}>
        <div className="row">
          <div className="t">
            {/* Дата — про ПЕРЕСЧЁТ склада, а не про план: «Склад на 20.08»
                читалось как «остаток на дату» (UX#5). */}
            <b>{stock.asOf === null ? "Склад ещё не считали" : `Склад: последний пересчёт ${day(stock.asOf)}`}</b>
            <small>
              сейчас {n(stock.totalBefore)} · увезём {n(stock.use)} · докупим сверх нужды {n(stock.back)} · станет{" "}
              {n(stock.totalAfter)}
              {stock.unmatched > 0 && <> · мимо расчёта {n(stock.unmatched)}</>}
            </small>
          </div>
          {stock.stale && <span className="pill bad">часть строк старее 3 дней</span>}
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
        <>
          <p className="hint">
            {plan.routeConfigured && !маршрутСломан
              ? "Порядок задан в настройках («Система» → «Вендинг: маршрут загрузки»)."
              : "Порядок — по имени автомата. Свой задаётся в «Система» → «Вендинг: маршрут загрузки»: серийники через запятую, без «c»."}
          </p>
          <div className="rows">
            {machines.map((m) => (
              <div className="row" key={m.serial}>
                <span className="pill">{m.routeIndex}</span>
                <div className="t">
                  <b>{m.name}</b>
                  <small>
                    {m.serial} · закуп {n(m.fromPurchase)} · склад {n(m.fromStock)}
                    {m.unfilled > 0 && <> · пусто {n(m.unfilled)}</>}
                  </small>
                </div>
                <span className="pill">
                  {n(m.fromPurchase + m.fromStock)} из {n(m.need)} ед
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Порядок секций — как в боте: купить → собрать со склада → убрано →
          слоты. Один и тот же поход, и два разных порядка заставляли владельца
          сверять списки заново (UX#21). */}
      <div className="section-title">Купить</div>
      {summary.items.length === 0 ? (
        <div className="empty">
          <b>Закупать нечего</b>
          Потребность закрывается складом — или всё, чего не хватает, убрано из закупки правилом.
        </div>
      ) : (
        <>
          <div className="rows">
            {summary.items.map((i) => (
              <div className="row" key={i.product}>
                <div className="t">
                  <b>{i.product}</b>
                  <small>
                    нужно {n(i.need)} · склад {n(i.stock)} · купить {n(i.buy)} · заказ {n(i.order)} · сразу в автоматы{" "}
                    {n(i.fromPurchase)} · остальное на склад {n(i.toStock)}
                  </small>
                </div>
                {i.fixedQty !== null && <span className="pill">фикс {n(i.fixedQty)}</span>}
                {i.noPrice && <span className="pill bad">нет цены</span>}
                <span className="pill">{i.noPrice ? `${n(i.order)} ед` : `${n(i.costRounded)} сум`}</span>
              </div>
            ))}
          </div>
          {/* Кнопки нет, когда закупать нечего: нажатие вернуло бы отказ Core
              «Закупать нечего», и владелец решал бы, что панель сломана (UX#23). */}
          <SubmitPurchaseButton domain={domain} />
        </>
      )}

      {summary.excludedNoSales.length > 0 && (
        <p className="muted">
          Не закупать (нет продаж): {summary.excludedNoSales.map((i) => i.product).join(", ")}
        </p>
      )}
      {summary.noPrice.length > 0 && (
        <p className="muted">Без цены в прайсе — на разбор: {summary.noPrice.join(", ")}</p>
      )}

      {fromStock.length > 0 && (
        <>
          <div className="section-title">Собрать со склада</div>
          <div className="rows">
            {fromStock.map(({ item: i, where }) => (
              <div className="row" key={i.product}>
                <div className="t">
                  <b>{i.product}</b>
                  <small>
                    сейчас {n(i.stock)} · после {n(i.stockAfter)}
                    {where && <> · по автоматам {where}</>}
                  </small>
                </div>
                <span className="pill">взять {n(i.fromStock)} ед</span>
              </div>
            ))}
          </div>
        </>
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
                    нужно {n(i.need)} · со склада {n(i.fromStock)}
                    {i.unfilled > 0 && <> · пусто {n(i.unfilled)}</>}
                  </small>
                </div>
                <span className="pill">правило товара</span>
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
