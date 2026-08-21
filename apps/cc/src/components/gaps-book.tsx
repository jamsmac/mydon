import type { Gap } from "../lib/core";
import { fmtDay } from "../lib/globerent";
import { plural } from "../lib/format";
import { ListShell, type ListShellKpi } from "./list-shell";

/**
 * Лист «Пробелы» (срез К, задача 6, шаг 3): реестр из Task 5 — каждая строка
 * отвечает на три вопроса: что нельзя посчитать (`topic`), почему (`missing`),
 * что сделать (`action`). Пустой список — ХОРОШАЯ новость (шаг 4 брифа): всё,
 * что можно посчитать, посчитано, а не запрос сломан — поэтому у него своё,
 * нейтрально-положительное пустое состояние, а не то же самое «ничего нет»,
 * что у провала запроса.
 */
export function GapsBook({
  gaps,
  hrefBase,
  tab,
  q,
}: {
  /** null — ядро не ответило на /gaps. Это НЕ «пробелов нет». */
  gaps: Gap[] | null;
  hrefBase: string;
  tab: string;
  q: string;
}) {
  const allGaps = gaps ?? [];
  const query = q.trim().toLowerCase();
  const shownGaps = query
    ? allGaps.filter(
        (g) =>
          g.topic.toLowerCase().includes(query) ||
          g.missing.toLowerCase().includes(query) ||
          g.action.toLowerCase().includes(query) ||
          (g.scale ?? "").toLowerCase().includes(query),
      )
    : allGaps;

  const kpi: ListShellKpi[] = [
    {
      label: "Пробелов сейчас",
      value: gaps === null ? "—" : String(gaps.length),
      hot: gaps !== null && gaps.length > 0,
      foot: gaps === null ? "не удалось проверить" : gaps.length === 0 ? "всё, что можно посчитать, посчитано" : undefined,
    },
  ];

  return (
    <ListShell kpi={kpi} searchQ="">
      <form className="search" action={hrefBase} method="get" style={{ marginBottom: 14 }}>
        <input type="hidden" name="tab" value={tab} />
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Поиск по теме, причине, действию…"
          aria-label="Поиск по пробелам"
        />
        <button className="btn" type="submit" style={{ flex: "none", padding: "0 18px" }}>
          Найти
        </button>
      </form>

      {gaps === null ? (
        // Пустое состояние 1/3: ядро не ответило. НЕ «пробелов нет».
        <div className="empty">
          <b>Не удалось проверить пробелы</b>
          Core не ответил на запрос /gaps — обнови страницу. Это не значит, что пробелов нет:
          список сейчас просто не посчитан.
        </div>
      ) : allGaps.length === 0 ? (
        // Пустое состояние 2/3: пробелов действительно нет — хорошая новость,
        // а не ошибка (правило брифа, шаг 4).
        <div className="empty">
          <b>Пробелов нет — хорошая новость</b>
          Всё, что сейчас можно посчитать по данным направления, посчитано: ни один из детекторов
          не сработал.
        </div>
      ) : shownGaps.length === 0 ? (
        // Пустое состояние 3/3: фильтр/поиск ничего не нашёл — пробелы есть.
        <div className="empty">
          <b>Ничего не нашлось</b>
          Поменяй запрос или сними фильтр.
        </div>
      ) : (
        <>
          <div>
            {shownGaps.map((g, i) => (
              <div className="trow" key={`${g.topic}-${i}`}>
                <div className="tb">
                  <div className="tt">{g.topic}</div>
                  <div className="tm">
                    <span>{g.missing}</span>
                    {g.period && (
                      <span>
                        {fmtDay(g.period.from)} – {fmtDay(g.period.to)}
                      </span>
                    )}
                    <span>→ {g.action}</span>
                  </div>
                </div>
                {g.scale && <span className="due">{g.scale}</span>}
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
            {shownGaps.length === allGaps.length
              ? `${allGaps.length} ${plural(allGaps.length, "пробел", "пробела", "пробелов")}`
              : `${shownGaps.length} из ${allGaps.length}`}
          </p>
        </>
      )}
    </ListShell>
  );
}
