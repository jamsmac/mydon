import type { Reconciliation } from "../lib/core";

function num(n: number): string {
  return n.toLocaleString("ru-RU");
}

/**
 * Построчная сверка двух источников.
 *
 * Отвечает на вопрос «где источники расходятся», а не сводит их в один. Ни одно
 * значение не объявлено верным: расхождение показывает оба, а какое из них
 * правда — решает владелец. Это предшественник объединённого журнала, не он сам.
 */
export function ReconcileView({ r }: { r: Reconciliation }) {
  if (r.totalA === 0 && r.totalB === 0) {
    return (
      <div className="empty">
        <b>Сверять пока нечего</b>
        Нужны выгрузки обоих источников с назначенной ролью «номер операции» —
        по ней заказы и сопоставляются.
      </div>
    );
  }

  const conflictFields = r.fields.filter((f) => f.differ > 0);
  const cleanMatched = r.matched - r.conflicts.length;

  return (
    <>
      <p className="hint" style={{ marginBottom: 12 }}>
        Сверяются <b>{r.a.title}</b> и <b>{r.b.title}</b> по номеру операции — это
        одни и те же заказы в двух системах. Ни одно значение не считается верным:
        где расходится, показаны оба, а какое правда — решаешь ты. Складывать эти
        источники нельзя, пока расхождения не разобраны.
      </p>

      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile mini">
          <div className="lab">Сошлось по номеру</div>
          <div className="v">{num(r.matched)}</div>
          <div className="foot">
            <span className="mk" />
            {num(cleanMatched)} без расхождений
          </div>
        </div>
        <div className={`tile mini ${r.conflicts.length > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Расходятся</div>
          <div className="v">{num(r.conflicts.length)}</div>
          <div className="foot">
            <span className="mk" />
            {r.conflicts.length > 0 ? "хоть одно поле не сошлось" : "совпали полностью"}
          </div>
        </div>
        <div className={`tile mini ${r.onlyACount > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Только в «{r.a.title}»</div>
          <div className="v">{num(r.onlyACount)}</div>
          <div className="foot">
            <span className="mk" />
            из {num(r.totalA)} строк
          </div>
        </div>
        <div className={`tile mini ${r.onlyBCount > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Только в «{r.b.title}»</div>
          <div className="v">{num(r.onlyBCount)}</div>
          <div className="foot">
            <span className="mk" />
            из {num(r.totalB)} строк
          </div>
        </div>
      </div>

      {/* Свод по полям: где именно источники не сходятся. */}
      <div className="sect" style={{ marginTop: 4 }}>
        <div className="sect-h">
          <h3 className="h2">Согласие по полям</h3>
        </div>
        <div className="maplist">
          {r.fields.map((f) => (
            <div className={`maprow ${f.differ > 0 ? "hot" : ""}`} key={f.role}>
              <div className="mapv">
                <span className="mapl">{f.label}</span>
              </div>
              <div className="mapt">
                <span className="chip g">сошлось {num(f.agree)}</span>
                {f.differ > 0 && <span className="chip h">разошлось {num(f.differ)}</span>}
                {f.absent > 0 && <span className="chip">не с чем сравнить {num(f.absent)}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {(r.duplicatesA.length > 0 || r.duplicatesB.length > 0) && (
        <div className="notice" style={{ marginTop: 14 }}>
          <b>Задвоенные номера в источнике</b>
          {r.duplicatesA.length > 0 && (
            <>
              {" "}
              «{r.a.title}»: {r.duplicatesA.map((d) => `${d.key}×${d.count}`).join(", ")}.
            </>
          )}
          {r.duplicatesB.length > 0 && (
            <>
              {" "}
              «{r.b.title}»: {r.duplicatesB.map((d) => `${d.key}×${d.count}`).join(", ")}.
            </>
          )}
          {" "}
          Это данные источника, а не ошибка сверки — схлопывать их молча нельзя.
        </div>
      )}

      {r.conflicts.length > 0 && (
        <div className="sect" style={{ marginTop: 14 }}>
          <div className="sect-h">
            <h3 className="h2">Расхождения по операциям</h3>
            <span className="chip">
              {conflictFields.map((f) => f.label).join(", ")}
            </span>
          </div>
          <div className="rlist">
            <div className="rhead">
              <span>Номер операции</span>
              <span>Поле</span>
              <span>{r.a.title}</span>
              <span>{r.b.title}</span>
            </div>
            {r.conflicts.map((c) =>
              c.diffs.map((d, i) => (
                <div className="rrow" key={`${c.key}-${d.role}`}>
                  <span className="mono dim">{i === 0 ? c.key : ""}</span>
                  <span>{d.label}</span>
                  <span className="mono">{d.a || "—"}</span>
                  <span className="mono warn">{d.b || "—"}</span>
                </div>
              )),
            )}
          </div>
        </div>
      )}

      {(r.onlyA.length > 0 || r.onlyB.length > 0) && (
        <div className="sect" style={{ marginTop: 14 }}>
          <div className="sect-h">
            <h3 className="h2">Есть только у одного источника</h3>
          </div>
          {r.onlyA.length > 0 && (
            <p className="hint">
              Только в «{r.a.title}» ({num(r.onlyACount)}):{" "}
              <span className="mono">{r.onlyA.slice(0, 20).join(", ")}</span>
              {r.onlyACount > 20 && " …"}
            </p>
          )}
          {r.onlyB.length > 0 && (
            <p className="hint">
              Только в «{r.b.title}» ({num(r.onlyBCount)}):{" "}
              <span className="mono">{r.onlyB.slice(0, 20).join(", ")}</span>
              {r.onlyBCount > 20 && " …"}
            </p>
          )}
        </div>
      )}
    </>
  );
}
