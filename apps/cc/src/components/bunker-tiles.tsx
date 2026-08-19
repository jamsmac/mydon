import Link from "next/link";
import type { CoffeeFillStatusRow } from "../lib/core";

/**
 * Ингредиенты по бункерам — плитками, как всё остальное в карточке.
 *
 * Столбики-«канистры» хороши для списка парка, где нужен один взгляд, но на
 * своей вкладке они молчали о главном: ЧТО в бункере и СКОЛЬКО. Здесь на
 * каждой позиции имя ингредиента, чистый вес последней заливки и — если
 * эталон позиции задан — уровень полосой. Без эталона показываем вес и
 * говорим прямо, что процент считать не из чего: пустая шкала выглядела бы
 * как «бункер пуст», а это разные вещи.
 */
export function BunkerTiles({
  rows,
  positions = 8,
}: {
  rows: CoffeeFillStatusRow[];
  /** Сколько бункеров у аппарата: у кофейных — восемь. */
  positions?: number;
}) {
  const byPos = new Map(rows.map((r) => [r.position, r]));
  const г = (n: number) => `${n.toLocaleString("ru-RU")} г`;

  return (
    <div className="bnk-grid">
      {Array.from({ length: positions }, (_, i) => i + 1).map((pos) => {
        const r = byPos.get(pos);
        const залито = r?.netFillWeight ?? null;
        const эталон = r?.targetFillWeight ?? null;
        const доля = r?.fillRatio ?? null;
        const pct = доля !== null ? Math.max(3, Math.min(100, Math.round(доля * 100))) : null;
        const мало = r?.status === "underfill";
        return (
          <div className={`bnk${залито === null ? " bnk-empty" : ""}${мало ? " bnk-low" : ""}`} key={pos}>
            <div className="bnk-head">
              <span className="bnk-pos mono">Б{pos}</span>
              <span className="bnk-name">
                {r?.ingredientId ? (
                  <Link href={`/card/${r.ingredientId}`}>{r.ingredientName ?? "без имени"}</Link>
                ) : (
                  (r?.ingredientName ?? "не назначен")
                )}
              </span>
            </div>

            {залито === null ? (
              <div className="bnk-foot">заливок нет</div>
            ) : (
              <>
                <div className="bnk-val mono">
                  {г(залито)}
                  {эталон !== null && <span className="u"> из {г(эталон)}</span>}
                </div>
                {pct !== null ? (
                  <div className="bnk-bar" title={`Заполнен ${pct}%`}>
                    <i className={мало ? "low" : ""} style={{ width: `${pct}%` }} />
                  </div>
                ) : (
                  <div className="bnk-foot">эталон позиции не задан — % не считается</div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
