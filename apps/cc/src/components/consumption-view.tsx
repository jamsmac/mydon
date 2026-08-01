import Link from "next/link";
import { core, type ConsumptionReport } from "../lib/core";

const num = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
const sum = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} сум`;
const day = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y.slice(2)}`;
};

/**
 * Расход сырья за период: сколько ингредиентов списали продажи.
 *
 * Считается на чтении из журнала продаж и рецептов — не хранится. Продали
 * латте → списали зёрна, молоко, стакан. Товары без рецепта и продажи без
 * карточки показаны отдельно: расход по ним честно не сведён.
 */
export async function ConsumptionView() {
  let report: ConsumptionReport;
  try {
    report = await core.consumption();
  } catch {
    return (
      <div className="empty">
        <b>Расход недоступен</b>
        Core не ответил — обнови страницу.
      </div>
    );
  }

  const hasData = report.ingredients.length > 0 || report.unmatched.length > 0;

  return (
    <div className="sect">
      <div className="sect-h">
        <h3 className="h2">Расход сырья</h3>
        <span className="chip">
          {day(report.from)}–{day(report.to)}
        </span>
      </div>

      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile">
          <div className="lab">Себестоимость списанного</div>
          <div className="v">{sum(report.totalCost)}</div>
          <div className="foot">
            <span className="mk" />
            {report.unresolved > 0 ? `не посчитано строк: ${report.unresolved}` : "по текущим ценам"}
          </div>
        </div>
        <div className="tile">
          <div className="lab">Продано по рецептам</div>
          <div className="v">{num(report.soldRecipeUnits)}</div>
          <div className="foot">
            <span className="mk" />
            единиц товаров-рецептов
          </div>
        </div>
      </div>

      {!hasData ? (
        <p className="hint">
          За период нет продаж по товарам с рецептом. Заведи рецепты у товаров и цены у
          ингредиентов — расход соберётся из журнала продаж.
        </p>
      ) : (
        <>
          {report.ingredients.length > 0 && (
            <div className="pass">
              {report.ingredients.map((i) => (
                <div className="f" key={i.ingredientId}>
                  <div className="k">
                    <Link href={`/card/${i.ingredientId}`}>{i.ingredientName}</Link>
                    {!i.approved ? " (ждёт утверждения)" : ""}
                  </div>
                  <div className="val">
                    {i.consumed === null ? "не сведён" : `${num(i.consumed)} ${i.unit ?? ""}`}
                    {i.cost !== null ? ` · ${sum(i.cost)}` : ""}
                    {i.unconvertible > 0 ? ` · не посчитано: ${i.unconvertible}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}

          {report.products.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="result-title">Из чего сложилось</div>
              <div className="pass">
                {report.products.map((p) => (
                  <div className="f" key={p.productId}>
                    <div className="k">
                      <Link href={`/card/${p.productId}`}>{p.productName}</Link>
                    </div>
                    <div className="val">
                      {num(p.soldQty)} шт{p.cost !== null ? ` · ${sum(p.cost)}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.unmatched.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="result-title">Продажи без карточки — расход не сведён</div>
              <div className="pass">
                {report.unmatched.slice(0, 20).map((u) => (
                  <div className="f" key={`${u.source}:${u.product}`}>
                    <div className="k">{u.product}</div>
                    <div className="val">
                      {num(u.soldQty)} шт · {sum(u.revenue)} · {u.source}
                    </div>
                  </div>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                Свяжи эти названия с карточками товаров во вкладке «Источники» — тогда их
                расход тоже сведётся.
              </p>
            </div>
          )}
        </>
      )}

      <p className="hint" style={{ marginTop: 8 }}>
        Расход выводится из журнала продаж и рецептов, а не хранится: продали товар —
        списали его состав, приведённый к единице ингредиента. Списание привязано к
        продаже, не к складу: остаток на конкретном складе появится, когда будет связь
        автомат→склад.
      </p>
    </div>
  );
}
