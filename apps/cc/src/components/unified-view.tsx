import Link from "next/link";
import type { OurVendRecon, UnifiedJournal, UnifiedOrder } from "../lib/core";

function num(n: number): string {
  return n.toLocaleString("ru-RU");
}

function sum(n: number): string {
  return `${Math.round(n).toLocaleString("ru-RU")} сум`;
}

/**
 * Объединённый журнал двух источников.
 *
 * То, ради чего была нужна сверка: gjvending и vendinghub сведены в ОДИН список,
 * где каждый заказ лежит один раз. Задвоения нет — сколько уникальных номеров,
 * столько продаж на деле. Где источники согласны, значение одно с пометкой
 * «оба»; где разошлись — показаны ОБА, и выбор за владельцем, не за сводкой.
 */
export function UnifiedView({
  u,
  base,
  sp,
}: {
  u: UnifiedJournal;
  base: string;
  sp: Record<string, string>;
}) {
  if (u.totalA === 0 && u.totalB === 0) {
    return (
      <div className="empty">
        <b>Объединять пока нечего</b>
        Нужны выгрузки обоих источников с назначенной ролью «номер операции» — по
        ней заказы и сводятся в один журнал.
      </div>
    );
  }

  const link = (params: Record<string, string | null>) => {
    const p = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    return `${base}?${p.toString()}`;
  };

  const pages = Math.max(1, Math.ceil(u.union / u.size));

  // Пара источников передаётся в выгрузку как есть — файл забирает весь союз.
  const exportQs = new URLSearchParams({
    ra: u.a.source,
    rar: u.a.report,
    rb: u.b.source,
    rbr: u.b.report,
  }).toString();

  return (
    <>
      <div className="srcbar" style={{ marginBottom: 12, alignItems: "flex-start" }}>
        <p className="hint" style={{ margin: 0 }}>
          Объединяются <b>{u.a.title}</b> и <b>{u.b.title}</b> по номеру операции —
          одни и те же заказы в двух системах, сведённые в один журнал. Каждый
          заказ здесь ровно один раз: сложить источники порознь значило бы
          задвоить выручку. Где значения расходятся, показаны оба — какое верное,
          решаешь ты.
        </p>
        <a className="btn sm ghost" href={`/api/sources/unify-export?${exportQs}`}>
          Скачать CSV
        </a>
      </div>

      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile mini">
          <div className="lab">Заказов без задвоения</div>
          <div className="v">{num(u.union)}</div>
          <div className="foot">
            <span className="mk" />
            {num(u.totalA)} + {num(u.totalB)} строк источников
          </div>
        </div>
        <div className="tile mini">
          <div className="lab">Подтверждают оба</div>
          <div className="v">{num(u.both)}</div>
          <div className="foot">
            <span className="mk" />
            {u.union > 0 ? `${Math.round((u.both / u.union) * 100)}% союза` : "—"}
          </div>
        </div>
        <div className={`tile mini ${u.conflicts > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Спорных</div>
          <div className="v">{num(u.conflicts)}</div>
          <div className="foot">
            <span className="mk" />
            {u.conflicts > 0 ? "значение выбирает владелец" : "разногласий нет"}
          </div>
        </div>
        <div className={`tile mini ${u.onlyA + u.onlyB > 0 ? "" : "zero"}`}>
          <div className="lab">Только у одного</div>
          <div className="v">{num(u.onlyA + u.onlyB)}</div>
          <div className="foot">
            <span className="mk" />
            {num(u.onlyA)} у «{u.a.title}», {num(u.onlyB)} у «{u.b.title}»
          </div>
        </div>
      </div>

      {u.duplicated > 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          <b>Задвоенные номера в источнике</b> — {num(u.duplicated)}. Такие заказы
          сведены по первому вхождению и помечены значком, но это данные
          источника, а не ошибка сводки: молча схлопывать их нельзя.
        </div>
      )}

      <OurVendLane r={u.ourvend} />

      <div className="jlegend" style={{ marginBottom: 8 }}>
        <span className="jlg s-matched">
          <i />
          подтверждают оба
        </span>
        <span className="jlg s-mismatch">
          <i />
          расходятся
        </span>
        <span className="jlg s-unchecked">
          <i />
          только у одного
        </span>
      </div>

      <div className="ulist">
        {u.orders.map((o) => (
          <UnifiedRow key={o.key} o={o} a={u.a.title} b={u.b.title} />
        ))}
      </div>

      <div className="pager" style={{ marginTop: 12 }}>
        {u.page > 1 && (
          <Link className="btn sm ghost" href={link({ upage: String(u.page - 1) })}>
            ← назад
          </Link>
        )}
        <span className="hint">
          {u.page} / {pages} · {num(u.union)} заказов без задвоения
        </span>
        {u.page < pages && (
          <Link className="btn sm ghost" href={link({ upage: String(u.page + 1) })}>
            вперёд →
          </Link>
        )}
      </div>
    </>
  );
}

/** Одна строка объединённого журнала: заказ и его поля из обоих источников. */
function UnifiedRow({ o, a, b }: { o: UnifiedOrder; a: string; b: string }) {
  const tone = o.conflict ? "mismatch" : o.presence === "both" ? "matched" : "unchecked";
  const badge =
    o.presence === "both"
      ? o.conflict
        ? "расходятся"
        : "оба"
      : o.presence === "onlyA"
        ? `только «${a}»`
        : `только «${b}»`;

  return (
    <div className={`urow s-${tone}`}>
      <div className="uhead">
        <span className="mono uno">{o.key}</span>
        <span className={`chip ${o.conflict ? "h" : o.presence === "both" ? "g" : ""}`}>{badge}</span>
        {o.duplicated && <span className="chip" title="номер встречается в источнике больше раза">задвоен</span>}
      </div>
      <div className="ufields">
        {o.fields.map((f) => {
          // Согласовано — одно значение. Спор — оба, рядом, ни одно не главнее.
          // Одна сторона — её значение, без ложного сравнения.
          const agreed = f.agree === true;
          const both = f.a !== null && f.b !== null;
          return (
            <div className={`ufield ${f.agree === false ? "hot" : ""}`} key={f.role}>
              <span className="ulab">{f.label}</span>
              {agreed ? (
                <span className="uval mono">{f.a}</span>
              ) : both ? (
                <span className="uval two">
                  <span className="mono">{f.a}</span>
                  <span className="vs">≠</span>
                  <span className="mono warn">{f.b}</span>
                </span>
              ) : (
                <span className="uval mono">
                  {f.a ?? f.b}
                  <span className="uside"> · {f.a !== null ? a : b}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Дневная сверка союза с OurVend.
 *
 * OurVend — третий источник, но дневной: ни номера заказа, ни времени внутри
 * дня. Поэтому он не вливается в союз заказом, а сверяется с ним дневным
 * итогом «день + автомат + товар». Это НЕ добавка к выручке: те же продажи,
 * третий взгляд. Где OurVend расходится с союзом — вопрос владельцу, где видит
 * то, чего в союзе нет — пропущенный автомат или товар.
 */
function OurVendLane({ r }: { r: OurVendRecon }) {
  const src = r.source ?? "OurVend";

  if (!r.synced) {
    return (
      <div className="notice" style={{ marginBottom: 14 }}>
        <b>OurVend за эти дни ничего не показывает</b>
        Третий источник (дневной) не синхронизирован или пуст за диапазон союза
        {r.fromDay ? ` (${r.fromDay} — ${r.toDay})` : ""} — дневную сверку сделать
        не с чем. Как появятся продажи OurVend, они сойдутся здесь.
      </div>
    );
  }

  const revenueClose = Math.round(r.unionRevenue) === Math.round(r.ourvendRevenue);

  return (
    <div className="sect" style={{ marginBottom: 14 }}>
      <div className="sect-h">
        <h3 className="h2">Дневная сверка с {src}</h3>
        <span className="chip">{r.fromDay} — {r.toDay}</span>
      </div>

      <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
        {src} — третий источник, но дневной: он не отдаёт ни номера заказа, ни
        времени внутри дня, поэтому сверяется с союзом не построчно, а итогом за
        день по автомату и товару. Это <b>тот же продажи третьим взглядом</b>, а
        не добавка к выручке — складывать нельзя, можно только сверять.
      </p>

      <div className="tiles" style={{ marginBottom: 12 }}>
        <div className={`tile mini ${r.agree > 0 ? "" : "zero"}`}>
          <div className="lab">Сошлось за день</div>
          <div className="v">{num(r.agree)}</div>
          <div className="foot">
            <span className="mk" />
            из {num(r.matched)} общих корзин
          </div>
        </div>
        <div className={`tile mini ${r.differ > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Разошлось за день</div>
          <div className="v">{num(r.differ)}</div>
          <div className="foot">
            <span className="mk" />
            {r.differ > 0 ? "выручка не сходится" : "по общим — сходится"}
          </div>
        </div>
        <div className={`tile mini ${r.onlyOurVend > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Только у {src}</div>
          <div className="v">{num(r.onlyOurVend)}</div>
          <div className="foot">
            <span className="mk" />
            союз этих продаж не видит
          </div>
        </div>
        <div className={`tile mini ${r.onlyUnion > 0 ? "" : "zero"}`}>
          <div className="lab">Только у союза</div>
          <div className="v">{num(r.onlyUnion)}</div>
          <div className="foot">
            <span className="mk" />
            {src} их не показывает
          </div>
        </div>
      </div>

      <div className={`maprow ${revenueClose ? "" : "hot"}`} style={{ marginBottom: 4 }}>
        <div className="mapv">
          <span className="mapl">Выручка по пересечению</span>
        </div>
        <div className="mapt">
          <span className="chip g">союз {sum(r.unionRevenue)}</span>
          <span className={`chip ${revenueClose ? "" : "h"}`}>{src} {sum(r.ourvendRevenue)}</span>
        </div>
      </div>

      {r.conflicts.length > 0 && (
        <div className="sect" style={{ marginTop: 10 }}>
          <div className="sect-h">
            <h3 className="h2">Где день не сходится</h3>
          </div>
          <div className="rlist">
            <div className="rhead">
              <span>День · автомат · товар</span>
              <span>Заказов союза</span>
              <span>Союз</span>
              <span>{src}</span>
            </div>
            {r.conflicts.slice(0, 30).map((c) => (
              <div className="rrow" key={`${c.day}-${c.serial}-${c.product}`}>
                <span className="mono dim">
                  {c.day} · {c.serial} · {c.product}
                  {c.provisional && <span className="chip" title="в корзине союза есть спорные суммы"> спорн.</span>}
                </span>
                <span className="mono">{num(c.unionOrders)}</span>
                <span className="mono">{sum(c.unionRevenue)}</span>
                <span className="mono warn">{sum(c.ourvendRevenue)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {r.onlyOurVendSamples.length > 0 && (
        <p className="hint" style={{ marginTop: 8 }}>
          {src} видит продажи, которых нет в союзе (первые по выручке):{" "}
          {r.onlyOurVendSamples.slice(0, 8).map((s) => `${s.serial}/${s.product} ${sum(s.revenue)}`).join("; ")}
          {r.onlyOurVend > 8 && " …"}. Возможно, автомат или товар не попал в
          построчные источники — стоит проверить.
        </p>
      )}
    </div>
  );
}
