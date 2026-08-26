import Link from "next/link";
import { core, type PurchaseRow } from "../lib/core";
import { count } from "../lib/format";
import { SyncIntakeButton } from "./sync-intake-button";

const day = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y.slice(2)}`;
};

/**
 * Частота обновления остатков — по ИСТОЧНИКУ учётного потока OurVend, а не
 * константой.
 *
 * Пока источник — зеркало базы mydon-stock, строки приезжают синком раз в 10
 * минут. После флипа `OURVEND_ACCOUNTING_SOURCE=own` их приносит наш
 * собственный сбор слотов (раз в 3 часа, он же кормит детектор заливок), и
 * подпись «каждые 10 минут» стала бы обещанием свежести, которого нет.
 *
 * `undefined` — ядро поле ещё не отдаёт: молчание источника трактуем как
 * зеркало, то есть как было.
 */
export function stockFreshnessNote(source: "own" | "stock" | undefined): string {
  return source === "own"
    ? "остатки: свой снимок раз в 3 часа (детектор заливок)"
    : "обновляется каждые 10 минут";
}

/**
 * Имя товара из источника → карточка реестра: точное имя карточки или алиас
 * из словаря продаж (product_name_alias — один словарь на весь товарный
 * контур). Ошибка резолвинга ленты не ломает: имя остаётся текстом.
 */
async function productLinkMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const [товары, алиасы] = await Promise.all([
      core.entitiesOfType("vendhub", "product"),
      core.salesAliases(),
    ]);
    for (const p of товары) map.set(p.name.trim().toLowerCase(), p.id);
    for (const a of алиасы) map.set(a.name.trim().toLowerCase(), a.entityId);
  } catch {
    // ленты живут и без ссылок
  }
  return map;
}

/** Имя — ссылкой на карточку, если карточка или алиас есть; иначе текстом. */
function productName(name: string, links: Map<string, string>) {
  const id = links.get(name.trim().toLowerCase());
  return id ? <Link href={`/card/${id}`}>{name}</Link> : <>{name}</>;
}

/** Приход товара и сырья — журнал из mydon-stock (этап 2 миграции). */
export async function PurchasesView() {
  let rows: PurchaseRow[] = [];
  let summary: Awaited<ReturnType<typeof core.supplySummary>> | null = null;
  let links = new Map<string, string>();
  try {
    [rows, summary, links] = await Promise.all([
      // ОКНО ГОД, А НЕ 30 ДНЕЙ. Приход заводится нерегулярно: на проде 320
      // строк за год и НИ ОДНОЙ за последние 30 дней. Лист показывал «Прихода
      // за 30 дней нет» при полном журнале — и это не всё: ранний выход ниже
      // прятал вместе с пустотой единственную кнопку листа, синхронизацию с
      // mydon-stock. То есть экран сообщал «пусто» и одновременно убирал
      // единственный способ это исправить.
      core.purchases(365, 500),
      core.supplySummary(),
      productLinkMap(),
    ]);
  } catch {
    return <div className="empty"><b>Приход недоступен</b>Core не ответил — обнови страницу.</div>;
  }
  return (
    <>
      {/* Кнопка синхронизации ВСЕГДА выше пустого состояния: раньше ранний
          выход при нуле строк убирал её вместе с таблицей — «пусто» и нечем
          починить одновременно. Пустой экран обязан говорить, что сделать. */}
      <SyncIntakeButton />
      {rows.length === 0 && (
        <div className="empty">
          <b>Прихода за год нет</b>
          Записи приходят из учёта склада (mydon-stock). Если закупки были — нажми
          «Синхронизировать», иначе заведи первую партию.
        </div>
      )}
      {summary && (
        <div className="tiles" style={{ marginBottom: 14 }}>
          <div className="tile">
            <div className="lab">Приход за 30 дней</div>
            <div className="v">{count(summary.purchases30.total)} <span className="u">сум</span></div>
            <div className="foot"><span className="mk" />партий: {summary.purchases30.count}</div>
          </div>
        </div>
      )}
      {rows.length > 0 && (
      <div className="book">
        <div className="th">
          <span>Товар</span>
          <span>День</span>
          <span style={{ textAlign: "right" }}>Сумма</span>
        </div>
        {rows.map((r) => (
          <div className="tr" key={r.id}>
            <span className="nm">
              {productName(r.product, links)}
              <span style={{ color: "var(--tx-3)" }}>
                {" "}· ×{Number(r.qty)}{r.unit ? ` ${r.unit}` : ""}
                {r.note ? ` · ${r.note}` : ""}
                {r.expiryDate ? ` · годен до ${day(r.expiryDate)}` : ""}
              </span>
            </span>
            <span className="cd">{day(r.dt)}</span>
            <span className="pr">{r.total !== null ? <>{count(Number(r.total))} <span className="u">сум</span></> : "—"}</span>
          </div>
        ))}
      </div>
      )}
      {rows.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
          {rows.length} партий за год · из учёта склада, {stockFreshnessNote(summary?.source)}
        </p>
      )}
    </>
  );
}

/** Остатки внутри автоматов: свежий снапшот OurVend, нули горят. */
export async function MachineStockView() {
  let levels: Awaited<ReturnType<typeof core.machineStockLevels>> = [];
  let summary: Awaited<ReturnType<typeof core.supplySummary>> | null = null;
  let links = new Map<string, string>();
  try {
    [levels, summary, links] = await Promise.all([
      core.machineStockLevels(),
      core.supplySummary(),
      productLinkMap(),
    ]);
  } catch {
    return <div className="empty"><b>Остатки недоступны</b>Core не ответил — обнови страницу.</div>;
  }
  if (levels.length === 0) {
    return (
      <div className="empty">
        <b>Снапшотов остатков пока нет</b>
        OurVend отдаёт их по снек-автоматам — появятся сами.
      </div>
    );
  }

  const byMachine = new Map<string, typeof levels>();
  for (const l of levels) {
    const key = l.machineName ?? l.machineSerial;
    if (!byMachine.has(key)) byMachine.set(key, []);
    byMachine.get(key)!.push(l);
  }

  return (
    <>
      {summary && (
        <div className="tiles" style={{ marginBottom: 14 }}>
          <div className={`tile ${summary.emptyPositions > 0 ? "is-hot" : "zero"}`}>
            <div className="lab">Пустые позиции</div>
            <div className="v">{summary.emptyPositions}</div>
            <div className="foot"><span className="mk" />{summary.emptyPositions > 0 ? "пора везти пополнение" : "пустых нет"}</div>
          </div>
          <div className={`tile ${summary.lowPositions > 0 ? "" : "zero"}`}>
            <div className="lab">Мало (≤2 шт)</div>
            <div className="v">{summary.lowPositions}</div>
            <div className="foot"><span className="mk" />скоро закончатся</div>
          </div>
          <div className="tile zero">
            <div className="lab">Снапшот от</div>
            <div className="v" style={{ fontSize: 20 }}>{summary.lastStockDt ? day(summary.lastStockDt) : "—"}</div>
            <div className="foot"><span className="mk" />дневные данные OurVend</div>
          </div>
        </div>
      )}

      {[...byMachine.entries()].map(([name, items]) => {
        const empty = items.filter((i) => i.qty === 0).length;
        const first = items[0];
        return (
          <div className="sect" style={{ marginTop: 18 }} key={name}>
            <div className="sect-h">
              <h3 className="h2">
                {first.machineId ? <Link href={`/card/${first.machineId}`}>{name}</Link> : name}
              </h3>
              {empty > 0 ? <span className="chip h">пусто ×{empty}</span> : <span className="chip g">заполнен</span>}
              <span className="chip">{day(first.dt)}</span>
            </div>
            <div className="book">
              {items
                .slice()
                .sort((a, b) => a.qty - b.qty)
                .map((i) => (
                  <div className="tr" key={`${name}:${i.product}`}>
                    <span className="nm">
                      {i.qty === 0 && <span style={{ color: "var(--hot)", marginRight: 7 }}>●</span>}
                      {i.qty > 0 && i.qty <= 2 && <span style={{ color: "var(--tx-2)", marginRight: 7 }}>◐</span>}
                      {productName(i.product, links)}
                    </span>
                    <span className="cd" />
                    <span className="pr" style={i.qty === 0 ? { color: "var(--hot)" } : undefined}>
                      {i.qty === 0 ? "пусто" : `${i.qty} шт`}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
