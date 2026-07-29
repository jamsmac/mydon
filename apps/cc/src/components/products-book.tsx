import Link from "next/link";
import type { Entity } from "../lib/core";

/**
 * Журнал товаров — как экран «Товары» в ПО владельца (VHM24):
 * поиск, фильтр категорий цветными метками, «незаполненные» отдельно.
 *
 * Правило «незаполнено» перенесено из ПО: у кофейных — нет ИКПУ или упаковки,
 * у прохладительных/снеков — ещё и штрих-кода. Цвета — как на карте автоматов:
 * кофе синий, прохладительные зелёные.
 */

const CAT = {
  10: { label: "Кофейные", color: "#1A6BFF" },
  11: { label: "Прохладительные", color: "#2BD9A0" },
} as const;

export function isIncomplete(e: Entity): boolean {
  const a = e.attrs ?? {};
  const cat = Number(a["категория"]);
  if (!a["цена"] || !a["ИКПУ"] || !a["упаковка"]) return true;
  if (cat === 11 && !a["штрихкод"]) return true;
  return false;
}

export function ProductsBook({
  items,
  q,
  cat,
  inc,
  hrefBase,
}: {
  items: Entity[];
  q: string;
  cat: string;
  inc: boolean;
  hrefBase: string;
}) {
  const query = q.trim().toLowerCase();
  const counts = {
    all: items.length,
    coffee: items.filter((e) => Number((e.attrs ?? {})["категория"]) === 10).length,
    cold: items.filter((e) => Number((e.attrs ?? {})["категория"]) === 11).length,
    inc: items.filter(isIncomplete).length,
  };

  let shown = items;
  if (query) shown = shown.filter((e) => e.name.toLowerCase().includes(query));
  if (cat === "10" || cat === "11") {
    shown = shown.filter((e) => String(Number((e.attrs ?? {})["категория"])) === cat);
  }
  if (inc) shown = shown.filter(isIncomplete);

  const link = (params: Record<string, string>) => {
    const p = new URLSearchParams({ tab: "catalog:product", ...(query ? { q } : {}), ...params });
    return `${hrefBase}?${p.toString()}`;
  };

  return (
    <>
      <form className="search" action={hrefBase} method="get">
        <input type="hidden" name="tab" value="catalog:product" />
        {cat && <input type="hidden" name="cat" value={cat} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Найти товар по названию…"
          aria-label="Поиск по товарам"
        />
        <button className="btn" type="submit" style={{ flex: "none", padding: "0 18px" }}>
          Найти
        </button>
      </form>

      <div className="subtabs" style={{ marginBottom: 12 }}>
        <Link href={link({})} className={`subtab ${!cat && !inc ? "active" : ""}`}>
          Все <span className="n">×{counts.all}</span>
        </Link>
        <Link href={link({ cat: "10" })} className={`subtab ${cat === "10" ? "active" : ""}`}>
          <span style={{ color: CAT[10].color }}>●</span> {CAT[10].label}
          <span className="n">×{counts.coffee}</span>
        </Link>
        <Link href={link({ cat: "11" })} className={`subtab ${cat === "11" ? "active" : ""}`}>
          <span style={{ color: CAT[11].color }}>●</span> {CAT[11].label}
          <span className="n">×{counts.cold}</span>
        </Link>
        <Link
          href={link({ inc: "1" })}
          className={`subtab ${inc ? "active" : ""}`}
          style={counts.inc > 0 ? { color: "var(--hot)" } : undefined}
        >
          незаполненные <span className="n">×{counts.inc}</span>
        </Link>
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          <b>Ничего не нашлось</b>
          Поменяй запрос или сними фильтр.
        </div>
      ) : (
        <>
          <div className="book">
            <div className="th">
              <span>Товар</span>
              <span>ИКПУ</span>
              <span style={{ textAlign: "right" }}>Цена</span>
            </div>
            {shown
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name, "ru"))
              .map((e) => {
                const a = e.attrs ?? {};
                const c = CAT[Number(a["категория"]) as 10 | 11];
                const bad = isIncomplete(e);
                return (
                  <Link href={`/card/${e.id}`} className="tr" key={e.id}>
                    <span className="nm">
                      {c && <span style={{ color: c.color, marginRight: 7 }}>●</span>}
                      {e.name}
                      {bad && (
                        <span className="chip h" style={{ marginLeft: 8 }}>
                          незаполнено
                        </span>
                      )}
                    </span>
                    <span className="cd">{String(a["ИКПУ"] ?? "—")}</span>
                    <span className="pr">
                      {typeof a["цена"] === "number" ? (
                        <>
                          {Number(a["цена"]).toLocaleString("ru-RU")} <span className="u">сум</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  </Link>
                );
              })}
          </div>
          <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
            {shown.length} из {counts.all} товаров
            {counts.inc > 0 ? ` · незаполненных: ${counts.inc} — открой и дозаполни карточку` : ""}
          </p>
        </>
      )}
    </>
  );
}
