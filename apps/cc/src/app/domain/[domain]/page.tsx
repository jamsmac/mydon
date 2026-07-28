import { notFound } from "next/navigation";
import { DOMAINS, DOMAIN_LABELS, type Domain } from "@mydon/shared";
import { core, CoreUnavailable, type Entity, type Obligations } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { money, plural, when } from "../../../lib/format";

export const dynamic = "force-dynamic";

function isDomain(v: string): v is Domain {
  return (DOMAINS as readonly string[]).includes(v);
}

export default async function DomainPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  if (!isDomain(domain)) notFound();

  let obligations: Obligations;
  let entities: Entity[];
  try {
    [obligations, entities] = await Promise.all([core.obligations(domain), core.entitiesOf(domain)]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  // Сколько должны нам и сколько должны мы — по направлению движения денег.
  const owedToUs = obligations.totals.filter((t) => t.direction === "in");
  const owedByUs = obligations.totals.filter((t) => t.direction === "out");
  const sum = (rows: typeof owedToUs) => rows.reduce((s, r) => s + Number(r.amount || 0), 0);

  const byType = entities.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <div className="page-head">
        <h1>{DOMAIN_LABELS[domain]}</h1>
        <p>
          {entities.length} {plural(entities.length, "запись", "записи", "записей")} в реестре
        </p>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="v calm">{money(sum(owedToUs))}</div>
          <div className="k">должны нам</div>
        </div>
        <div className="tile">
          <div className="v calm">{money(sum(owedByUs))}</div>
          <div className="k">должны мы</div>
        </div>
        <div className="tile">
          <div className={`v ${obligations.overdue.length > 0 ? "alarm" : "calm"}`}>
            {obligations.overdue.length}
          </div>
          <div className="k">просрочено</div>
        </div>
        <div className="tile">
          <div className="v calm">{Object.keys(byType).length}</div>
          <div className="k">видов сущностей</div>
        </div>
      </div>

      {obligations.overdue.length > 0 && (
        <>
          <div className="section-title">Просрочено</div>
          <div className="rows">
            {obligations.overdue.slice(0, 20).map((o) => (
              <div className="row" key={o.id}>
                <div className="t">
                  <b>{money(o.amount, o.currency)}</b>
                  <small>{o.status}</small>
                </div>
                <span className="when">{when(o.date)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">Что заведено</div>
      {entities.length === 0 ? (
        <div className="empty">
          <b>Пока пусто</b>
          Бизнес-данные не загружались — они заводятся отдельно и по согласованию.
        </div>
      ) : (
        <div className="rows">
          {Object.entries(byType)
            .sort((a, b) => b[1] - a[1])
            .map(([type, n]) => (
              <div className="row" key={type}>
                <div className="t">
                  <b>{type}</b>
                </div>
                <span className="mono" style={{ color: "var(--steel)" }}>
                  {n}
                </span>
              </div>
            ))}
        </div>
      )}
    </>
  );
}
