import Link from "next/link";
import type { ReactNode } from "react";

/** Одна плитка мини-KPI строки листа. */
export interface ListShellKpi {
  label: string;
  value: string;
  /** Подсветить как «требует внимания» (не утверждено/незаполнено и т.п.). */
  hot?: boolean;
  /**
   * Подпись под значением — честно раскрывает частичность цифры (например
   * «по 6 из 226 карточек»), когда сумма/счёт посчитаны не по всему листу.
   */
  foot?: string;
  /**
   * «Плитка = вопрос, клик = ответ» (как плитки «Парк» на дашборде): задан —
   * плитка рисуется ссылкой и сужает список тем же фильтром. Не задан —
   * обычная неинтерактивная плитка (не всё в счётчиках листа кликабельно).
   */
  href?: string;
}

/**
 * ListShell — единый образец листа-реестра (§4 спеки, эталон-канвас
 * `design/dashboard-redesign/List.dc.html`): показатели листа → действие и
 * поиск → фильтры-чипы → записи. Серверный компонент — сама книга ниже
 * (`children`) решает, как рисовать записи, ListShell задаёт только общий
 * верх листа, чтобы «Товары», «Контрагенты» и любой справочник выглядели
 * одинаково — как «Автоматы».
 *
 * Поиск не дублируется: когда у книги уже есть свой (ProductsBook держит
 * форму и подвкладки внутри себя), `searchHrefBase` не передаётся — ListShell
 * не рисует вторую форму поверх первой. Когда своего поиска у книги нет
 * (generic-ветка), `searchHrefBase` + `searchTab` включают строку поиска тут.
 */
export function ListShell({
  kpi,
  action,
  searchQ,
  searchHrefBase,
  searchTab,
  chips,
  children,
}: {
  kpi: ListShellKpi[];
  /** «+ Запись» — существующий NewEntityForm. */
  action?: ReactNode;
  /** Текущий ?q= — значение поля поиска, когда ListShell рисует форму сам. */
  searchQ: string;
  /** Адрес отправки формы поиска (GET). Не задан — своей формы ListShell не рисует. */
  searchHrefBase?: string;
  /** Хранимое в адресе значение вкладки (?tab=) — сохраняется скрытым полем формы. */
  searchTab?: string;
  /** Фильтры листа — чипы, если у книги есть (подвкладки, категории). */
  chips?: ReactNode;
  /** Сама книга — таблица/плитки записей. */
  children: ReactNode;
}) {
  return (
    <div className="sect" style={{ marginTop: 0 }}>
      <div
        className="tiles"
        style={{ gridTemplateColumns: `repeat(${kpi.length}, minmax(0, 1fr))`, marginBottom: 14 }}
      >
        {kpi.map((t) => {
          const body = (
            <>
              <div className="lab">{t.label}</div>
              <div className="v">{t.value}</div>
              {t.foot && <div className="foot">{t.foot}</div>}
            </>
          );
          return t.href ? (
            <Link key={t.label} href={t.href} className={`tile mini ${t.hot ? "is-hot" : ""}`}>
              {body}
            </Link>
          ) : (
            <div key={t.label} className={`tile mini ${t.hot ? "is-hot" : ""}`}>
              {body}
            </div>
          );
        })}
      </div>

      {(action ?? searchHrefBase) && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: chips ? 10 : 16 }}>
          {action}
          {searchHrefBase && (
            <form className="search" action={searchHrefBase} method="get" style={{ flex: 1, marginBottom: 0 }}>
              {searchTab && <input type="hidden" name="tab" value={searchTab} />}
              <input
                type="search"
                name="q"
                defaultValue={searchQ}
                placeholder="Поиск по названию…"
                aria-label="Поиск по записям"
              />
              <button className="btn" type="submit" style={{ flex: "none", padding: "0 18px" }}>
                Найти
              </button>
            </form>
          )}
        </div>
      )}

      {chips && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>{chips}</div>}

      {children}
    </div>
  );
}
