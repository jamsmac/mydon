import type { CoffeeFillStatusRow } from "../lib/core";

/**
 * Наглядные бункеры — как в референс-приложении владельца (его слово,
 * 2026-08-04): восемь столбиков-«канистр» точки, уровень = чистый вес
 * последней заливки против эталона позиции. Недолив — оранжевым, норма —
 * зелёным, без эталона — приглушённо (высота честно неизвестна, показываем
 * половину с пометкой «?»), пустая позиция — контур без заливки.
 *
 * Серверный компонент: чистое отображение, интерактив не нужен.
 */
export function BunkerLevels({ rows, compact = false }: { rows: CoffeeFillStatusRow[]; compact?: boolean }) {
  const byPosition = new Map(rows.map((r) => [r.position, r]));
  const positions = [1, 2, 3, 4, 5, 6, 7, 8];
  return (
    <div className={`bunkers ${compact ? "compact" : ""}`}>
      {positions.map((pos) => {
        const r = byPosition.get(pos);
        if (!r || r.netFillWeight === null) {
          return (
            <div className="bunker" key={pos} title={`Бункер ${pos}: заливок нет`}>
              <div className="bk-bar" />
              <div className="bk-pos">{pos}</div>
            </div>
          );
        }
        const known = r.fillRatio !== null;
        const pct = known ? Math.max(6, Math.min(100, Math.round(r.fillRatio! * 100))) : 50;
        const cls = r.status === "underfill" ? "hot" : known ? "ok" : "dim";
        const title =
          `Бункер ${pos}${r.ingredientName ? ` · ${r.ingredientName}` : ""}: ${r.netFillWeight} г` +
          (r.targetFillWeight !== null ? ` из ${r.targetFillWeight} г (${Math.round((r.fillRatio ?? 0) * 100)}%)` : " · эталон не задан");
        return (
          <div className="bunker" key={pos} title={title}>
            <div className="bk-bar">
              <div className={`bk-fill ${cls}`} style={{ height: `${pct}%` }} />
            </div>
            <div className="bk-pos">{pos}</div>
            {!compact && (
              <div className="bk-sub">
                {known ? `${Math.round((r.fillRatio ?? 0) * 100)}%` : "?"}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
