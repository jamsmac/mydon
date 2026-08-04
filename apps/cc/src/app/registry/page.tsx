import Link from "next/link";
import { core, CoreUnavailable, type Entity } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { groupsFor } from "../../lib/domain-nav";
import { when } from "../../lib/format";

export const dynamic = "force-dynamic";

/** Порядок направлений: сначала дела, потом личное. */
const DOMAIN_ORDER = ["globerent", "vendhub", "personal", "mydon"] as const;
const DOMAIN_TITLES: Record<string, string> = {
  globerent: "GLOBERENT",
  vendhub: "VendHub",
  personal: "Личный контур",
  mydon: "MYDON",
};

/** Человеческие названия типов записей — владелец не обязан знать словарь базы. */
const TYPE_LABELS: Record<string, string> = {
  contractor: "контрагенты",
  counterparty: "контрагенты",
  contract: "договоры",
  machine: "автоматы",
  equipment: "техника",
  object: "объекты",
  invoice: "счета",
  product: "товары",
};
const typeLabel = (t: string): string => TYPE_LABELS[t] ?? t;

/** Группа вкладок направления, где живёт тип: у GLOBERENT договоры — в «Документах». */
const groupKeyFor = (domain: string, type: string): string =>
  groupsFor(domain).find((g) => g.leaves.some((l) => l.type === type))?.key ?? "catalog";

/**
 * Реестр по направлениям (ТЗ FR-5).
 *
 * Контрагенты GLOBERENT и автоматы VendHub — разные миры: без запроса видна
 * сводка «что где лежит», а результаты поиска раскладываются по направлениям,
 * чтобы тёзки из разных дел не смешивались в одну кучу. Поиск по-прежнему идёт
 * без фильтра по направлению — слово запроса может совпасть с названием домена
 * и увести поиск не туда (ловилось на проверке бота).
 */
export default async function Registry({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  let found: Entity[] = [];
  let overview: { domain: string; type: string; n: number }[] = [];
  let error: string | null = null;

  try {
    if (query.length > 0) {
      found = await core.search(query);
    } else {
      overview = await core.registryOverview();
    }
  } catch (err) {
    error = err instanceof CoreUnavailable ? err.detail : String(err);
  }

  if (error) return <CoreDown detail={error} />;

  // Результаты поиска — по направлениям; без направления в конец.
  const foundGroups = [...DOMAIN_ORDER.map((d) => d as string), null]
    .map((d) => ({
      key: d,
      title: d === null ? "Без направления" : DOMAIN_TITLES[d],
      items: found.filter((e) => (e.domain ?? null) === d),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <div className="page-head">
        <h1 className="h1">Реестр</h1>
        <p className="lead">Контрагенты, договоры, автоматы, техника — отдельно по каждому направлению.</p>
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
        overview.length === 0 ? (
          <div className="empty">
            <b>Реестр пока пуст</b>
            Бизнес-данные загружаются по согласованию. Сводка по направлениям появится сразу
            после загрузки.
          </div>
        ) : (
          DOMAIN_ORDER.map((d) => {
            const rows = overview.filter((o) => o.domain === d);
            if (rows.length === 0) return null;
            const total = rows.reduce((s, r) => s + Number(r.n), 0);
            return (
              <div key={d}>
                <div className="section-title">
                  {DOMAIN_TITLES[d]}
                  <span className="group-count">{total}</span>
                </div>
                <div className="wgrid">
                  {rows.map((r) => (
                    <Link
                      href={`/domain/${d}?tab=${groupKeyFor(d, r.type)}:${encodeURIComponent(r.type)}`}
                      className="wt"
                      key={`${d}:${r.type}`}
                    >
                      <div className="wl">{typeLabel(r.type)}</div>
                      <div className="wv">{r.n}</div>
                      <div className="wf">записей<span className="go">→</span></div>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })
        )
      ) : found.length === 0 ? (
        <div className="empty">
          <b>Ничего не найдено по «{query}»</b>
          Возможно, эта сущность ещё не заведена — бизнес-данные загружаются по согласованию.
        </div>
      ) : (
        foundGroups.map((g) => (
          <div key={g.title}>
            <div className="section-title">
              {g.title}
              <span className="group-count">{g.items.length}</span>
            </div>
            <div className="rows">
              {g.items.map((e) => (
                <Link href={`/card/${e.id}`} className="row rowlink" key={e.id}>
                  <div className="t">
                    <b>{e.name}</b>
                    <small>
                      {typeLabel(e.type)}
                      {e.externalRef ? ` · ${e.externalRef}` : ""}
                    </small>
                  </div>
                  <span className="when">{when(e.updatedAt)}</span>
                </Link>
              ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}
