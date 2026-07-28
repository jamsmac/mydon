import Link from "next/link";
import { core, CoreUnavailable, type Entity } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { EntityEditor } from "../../../components/entity-editor";
import { DOMAIN_TITLES, typeOne } from "../../../lib/labels";
import { when } from "../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Карточка записи реестра — как в ПО владельца: все поля на виду,
 * пополняются и меняются на месте.
 */
export default async function EntityCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let entity: Entity;
  try {
    entity = await core.entity(id);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const a = entity.attrs ?? {};
  const lat = a["широта"];
  const lng = a["долгота"];
  const hasGeo = typeof lat === "string" && typeof lng === "string" && lat.length > 0;

  return (
    <>
      <div className="page-head">
        <Link
          href={entity.domain ? `/domain/${entity.domain}?tab=catalog:${entity.type}` : "/registry"}
          className="back"
        >
          ← {entity.domain ? DOMAIN_TITLES[entity.domain] ?? entity.domain : "Реестр"}
        </Link>
        <h1>{entity.name}</h1>
        <p>
          {typeOne(entity.type)}
          {entity.domain ? ` · ${DOMAIN_TITLES[entity.domain] ?? entity.domain}` : ""}
          {` · обновлено ${when(entity.updatedAt)}`}
        </p>
      </div>

      {hasGeo && (
        <div className="card">
          <div className="result-title">Где стоит</div>
          <p>
            <a
              href={`https://maps.google.com/?q=${String(lat)},${String(lng)}`}
              target="_blank"
              rel="noreferrer"
            >
              Открыть точку на карте ({String(lat)}, {String(lng)})
            </a>
          </p>
        </div>
      )}

      <EntityEditor entity={entity} />
    </>
  );
}
