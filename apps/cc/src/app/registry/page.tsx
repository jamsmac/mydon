import { core, CoreUnavailable, type Entity } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { when } from "../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Реестр сущностей (ТЗ FR-5): одна карточка на контрагента, договор, автомат.
 * Поиск идёт через Core без фильтра по направлению — слово запроса может
 * совпасть с названием домена и увести поиск не туда (ловилось на проверке бота).
 */
export default async function Registry({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  let found: Entity[] = [];
  let error: string | null = null;

  if (query.length > 0) {
    try {
      found = await core.search(query);
    } catch (err) {
      error = err instanceof CoreUnavailable ? err.detail : String(err);
    }
  }

  if (error) return <CoreDown detail={error} />;

  return (
    <>
      <div className="page-head">
        <h1>Реестр</h1>
        <p>Контрагенты, договоры, автоматы, техника — одна карточка на сущность.</p>
      </div>

      <form className="search" action="/registry" method="get">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Название или часть названия…"
          aria-label="Поиск по реестру"
        />
        <button className="btn" type="submit" style={{ flex: "none", padding: "11px 18px" }}>
          Найти
        </button>
      </form>

      {query.length === 0 ? (
        <div className="empty">
          <b>Введите запрос</b>
          Например: часть названия контрагента или номер договора.
        </div>
      ) : found.length === 0 ? (
        <div className="empty">
          <b>Ничего не найдено по «{query}»</b>
          Возможно, эта сущность ещё не заведена — бизнес-данные загружаются по согласованию.
        </div>
      ) : (
        <div className="rows">
          {found.map((e) => (
            <div className="row" key={e.id}>
              <div className="t">
                <b>{e.name}</b>
                <small>
                  {e.type}
                  {e.externalRef ? ` · ${e.externalRef}` : ""}
                </small>
              </div>
              <span className="when">{when(e.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
