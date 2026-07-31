import Link from "next/link";
import { core, CoreUnavailable, type Entity, type MachineStays } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { DeleteEntityButton } from "../../../components/entity-delete";
import { EntityEditor } from "../../../components/entity-editor";
import { StayTimeline } from "../../../components/machine-stays";
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

  // История стоянок нужна только автоматам и только если она вообще собрана.
  // Ошибка здесь не должна ронять карточку: это дополнение, а не её суть.
  let stays: MachineStays | null = null;
  if (entity.type === "machine" && entity.externalRef) {
    try {
      const { machines } = await core.rawStays("gjvending", "order_query");
      const ref = entity.externalRef.toLowerCase();
      stays = machines.find((m) => m.serial.toLowerCase() === ref) ?? null;
    } catch {
      stays = null;
    }
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

      {stays && (
        <div className="sect">
          <div className="sect-h">
            <h3 className="h2">Где стоял</h3>
            {stays.moves > 0 ? (
              <span className="chip b">переездов: {stays.moves}</span>
            ) : (
              <span className="chip">не переезжал</span>
            )}
          </div>
          <StayTimeline stays={stays.stays} />
          <p className="hint" style={{ marginTop: 8 }}>
            Восстановлено из заказов источника: адрес и время есть в каждом.
            Точка — период, а не одно значение: переставили автомат, начался новый отрезок.
          </p>
        </div>
      )}

      <EntityEditor entity={entity} />

      <DeleteEntityButton
        id={entity.id}
        domain={entity.domain ?? null}
        type={entity.type}
        name={entity.name}
      />
    </>
  );
}
