import Link from "next/link";
import type { UnifiedJournal, UnifiedOrder } from "../lib/core";

function num(n: number): string {
  return n.toLocaleString("ru-RU");
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
