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
  10: { label: "Кофейные", color: "#b8480f" },
  11: { label: "Прохладительные", color: "#627719" },
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
  vid,
  hrefBase,
  tab,
}: {
  items: Entity[];
  q: string;
  cat: string;
  inc: boolean;
  /**
   * Фильтр по признаку `attrs["вид"]` — сейчас единственное значение
   * «рецепт».
   *
   * ЗАЧЕМ ЭТО ЧИП, А НЕ ЛИСТ. Карточек типа `recipe` не существует НИ ОДНОЙ:
   * бывший лист «Рецепты» рендерил товары с `attrs["вид"] === "рецепт"`, то
   * есть был фильтром, притворявшимся типом. Счётчик при этом брался по
   * пустому типу — и подвкладка стояла серой при девятнадцати живых
   * позициях: владелец видел «пусто», открывал, а там девятнадцать.
   */
  vid: string;
  hrefBase: string;
  /**
   * Текущий `?tab=` — сохраняется в ссылках чипов и скрытым полем формы, тот
   * же приём, что у `expiry-book`/`cash-reconcile`/`gaps-book`.
   *
   * Раньше здесь стояла КОНСТАНТА `"catalog:product"` — ключ группы, которой
   * не существует с 20.08.2026. Каждый клик по чипу и каждый поиск уходили на
   * `?tab=catalog:product&cat=…&q=…`, проходили через редирект `catalog →
   * settings` (page.tsx), а тот пересобирал адрес ИЗ ОДНОГО `tab` и терял
   * `cat`/`q`/`inc`. Итог: фильтры и поиск по товарам на проде не работали
   * вовсе, и молча — список просто показывал всё, без всякой ошибки.
   */
  tab: string;
}) {
  const query = q.trim().toLowerCase();
  const counts = {
    all: items.length,
    coffee: items.filter((e) => Number((e.attrs ?? {})["категория"]) === 10).length,
    cold: items.filter((e) => Number((e.attrs ?? {})["категория"]) === 11).length,
    inc: items.filter(isIncomplete).length,
    recipe: items.filter((e) => (e.attrs ?? {})["вид"] === "рецепт").length,
  };

  let shown = items;
  if (query) shown = shown.filter((e) => e.name.toLowerCase().includes(query));
  if (cat === "10" || cat === "11") {
    shown = shown.filter((e) => String(Number((e.attrs ?? {})["категория"])) === cat);
  }
  if (inc) shown = shown.filter(isIncomplete);
  if (vid) shown = shown.filter((e) => String((e.attrs ?? {})["вид"] ?? "") === vid);

  const link = (params: Record<string, string>) => {
    const p = new URLSearchParams({ tab, ...(query ? { q } : {}), ...params });
    return `${hrefBase}?${p.toString()}`;
  };

  return (
    <>
      <form className="search" action={hrefBase} method="get">
        <input type="hidden" name="tab" value={tab} />
        {cat && <input type="hidden" name="cat" value={cat} />}
        {vid && <input type="hidden" name="vid" value={vid} />}
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
        <Link href={link({})} className={`subtab ${!cat && !inc && !vid ? "active" : ""}`}>
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
        <Link href={link({ vid: "рецепт" })} className={`subtab ${vid === "рецепт" ? "active" : ""}`}>
          рецепты <span className="n">×{counts.recipe}</span>
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
