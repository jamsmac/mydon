import Link from "next/link";
import type { WarehouseStock } from "../lib/core";

const num = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 3 });

/**
 * Остаток склада: что и сколько на нём лежит. Считается на чтении из движений;
 * ингредиенты — ссылками, чтобы уйти в приход и ленту.
 */
export function WarehouseStockView({ stock }: { stock: WarehouseStock }) {
  const items = stock.items.filter((i) => i.qty === null || i.qty !== 0 || i.unconvertible > 0);
  return (
    <div className="sect">
      <div className="sect-h">
        <h3 className="h2">Остаток на складе</h3>
        <span className="chip">
          {stock.items.length} {stock.items.length === 1 ? "позиция" : "позиций"}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="hint">Пусто. Приход заводится в карточке ингредиента.</p>
      ) : (
        <div className="pass">
          {items.map((i) => (
            <div className="f" key={i.ingredientId}>
              <div className="k">
                <Link href={`/card/${i.ingredientId}`}>{i.ingredientName}</Link>
              </div>
              <div className="val">
                {i.qty === null ? "нет единицы" : `${num(i.qty)} ${i.baseUnit ?? ""}`}
                {i.unconvertible > 0 ? ` · не посчитано движений: ${i.unconvertible}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
