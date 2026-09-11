import Link from "next/link";
import { isPlaceType } from "@mydon/shared";
import type { CoffeePlacementRow, Entity } from "../lib/core";
import { mapTilesFromEnv } from "../lib/map-tiles";
import { placeMapCounts, placePoints } from "../lib/place-points";
import { MapPanel } from "./map-panel";

/** До трёх ссылок и «и ещё N» — подсказка не должна становиться простынёй. */
function FewLinks({ items }: { items: Entity[] }) {
  return (
    <>
      {items.slice(0, 3).map((e, i) => (
        <span key={e.id}>
          {i > 0 && ", "}
          <Link href={`/card/${e.id}`} style={{ color: "var(--accent)" }}>
            {e.name}
          </Link>
        </span>
      ))}
      {items.length > 3 && ` и ещё ${items.length - 3}`}
    </>
  );
}

/**
 * Тело раздела «Парк на карте»: точки — места (М-4), под картой — почему
 * видны не все автоматы. Две причины названы раздельно, потому что чинятся в
 * разных экранах: место без координат — в карточке МЕСТА, автомат без места —
 * в «Где стоит» автомата.
 *
 * `placements === null` — Core не отдал размещения. Тогда карты нет вовсе:
 * без размещений все места выглядели бы пустыми, а все автоматы — «без места».
 */
export function ParkMapSection({
  entities,
  placements,
}: {
  entities: Entity[];
  placements: CoffeePlacementRow[] | null;
}) {
  if (placements === null) {
    return <p className="hint">Карта недоступна: Core не отдал размещения автоматов. Обновите страницу позже.</p>;
  }
  const places = entities.filter((e) => isPlaceType(e.type));
  const machines = entities.filter((e) => e.type === "machine");
  const points = placePoints(places, machines, placements);
  const c = placeMapCounts(places, machines, placements);

  return (
    <>
      <MapPanel
        points={points}
        counts={{
          machinesTotal: c.machinesTotal,
          machinesOnMap: c.machinesOnMap,
          coffee: c.coffee,
          snack: c.snack,
          unknown: c.unknown,
          machinesNoPlace: c.machinesNoPlace.length,
          machinesOnPlacesNoCoords: c.machinesOnPlacesNoCoords,
          emptyPlacesOnMap: c.emptyPlacesOnMap,
        }}
        tiles={mapTilesFromEnv()}
      />
      {(c.placesNoCoords.length > 0 || c.machinesNoPlace.length > 0) && (
        <p className="hint" style={{ marginTop: 8 }}>
          {c.placesNoCoords.length > 0 && (
            <>
              Места без координат — их автоматов на карте нет: <FewLinks items={c.placesNoCoords} />.
              Координаты задаются в карточке места.{" "}
            </>
          )}
          {c.machinesNoPlace.length > 0 && (
            <>
              Автоматы без места: <FewLinks items={c.machinesNoPlace} /> — место ставится в «Где стоит».
            </>
          )}
        </p>
      )}
    </>
  );
}
