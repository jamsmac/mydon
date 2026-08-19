import Link from "next/link";
import { PLACE_TYPES, PLACE_TYPE_HINTS, PLACE_TYPE_LABELS, placeTypeLabel } from "@mydon/shared";
import { core, CoreUnavailable, type CoffeePlacementRow, type Entity } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { NewPlaceForm } from "../../components/place-new";

export const dynamic = "force-dynamic";

/**
 * Места: где автомат может стоять — точка продаж, склад, мастерская.
 *
 * До этого экрана мест в системе не было вовсе. Кофейные точки жили в своём
 * справочнике `coffee_location`, склад существовал только типом в коде
 * складского учёта (ни одной записи), а мастерских не было в принципе — и
 * автомат, уехавший в ремонт, числился стоящим на торговой точке.
 *
 * Место — обычная карточка реестра: у неё есть имя, координаты (`geo_point`),
 * утверждение владельцем и вложения. Поэтому здесь нет своей таблицы и своего
 * API — только список по видам и форма заведения.
 */
export default async function PlacesPage() {
  let byType: { type: string; rows: Entity[] }[] = [];
  // Кто где стоит СЕЙЧАС. Одним запросом на все виды мест: `placements` не
  // фильтрует по типу, поэтому склады и мастерские попадают наравне с точками.
  let стоятНаМесте = new Map<string, CoffeePlacementRow[]>();
  try {
    const списки = await Promise.all(
      PLACE_TYPES.map(async (t) => ({ type: t, rows: await core.entitiesOfType("vendhub", t) })),
    );
    byType = списки;
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  try {
    const открытые = (await core.coffeePlacements()).filter((p) => p.endDate === null);
    const карта = new Map<string, CoffeePlacementRow[]>();
    for (const p of открытые) карта.set(p.locationId, [...(карта.get(p.locationId) ?? []), p]);
    стоятНаМесте = карта;
  } catch {
    // Состав места — дополнение: без него список мест всё равно нужен.
  }

  const всего = byType.reduce((n, g) => n + g.rows.length, 0);
  const сКоординатами = byType.reduce(
    (n, g) => n + g.rows.filter((r) => r.geo != null).length,
    0,
  );
  const занятых = byType.reduce(
    (n, g) => n + g.rows.filter((r) => (стоятНаМесте.get(r.id)?.length ?? 0) > 0).length,
    0,
  );

  return (
    <>
      <div className="page-head">
        <h1>Места</h1>
        <p>
          {всего === 0
            ? "Мест пока нет. Заведите склад, мастерскую и локации продаж — автоматы будут стоять на них."
            : `Мест ${всего} · занято ${занятых} · с координатами ${сКоординатами}`}
        </p>
      </div>

      <section className="group-block">
        <div className="section-title">Новое место</div>
        <NewPlaceForm />
      </section>

      {byType.map((g) => (
        <section className="group-block" key={g.type}>
          <div className="section-title">
            {PLACE_TYPE_LABELS[g.type as (typeof PLACE_TYPES)[number]]}
            <span className="group-count">{g.rows.length}</span>
          </div>
          <p className="hint" style={{ marginBottom: 10 }}>
            {PLACE_TYPE_HINTS[g.type as (typeof PLACE_TYPES)[number]]}
          </p>

          {g.rows.length === 0 ? (
            <div className="empty">
              <b>Пока пусто</b>
              {g.type === "workshop"
                ? "Заведите мастерскую — тогда у автомата в ремонте будет видно, где он."
                : "Заведите место — и автоматы можно будет к нему привязывать."}
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Аппараты</th>
                  <th>Адрес</th>
                  <th>Координаты</th>
                  <th>Утверждено</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/card/${r.id}`}>{r.name}</Link>
                    </td>
                    <td>
                      {(стоятНаМесте.get(r.id) ?? []).length === 0 ? (
                        <span className="hint">— пусто —</span>
                      ) : (
                        (стоятНаМесте.get(r.id) ?? []).map((p, i) => (
                          <span key={p.id}>
                            {i > 0 ? " · " : ""}
                            <Link href={`/card/${p.entityId}`}>{p.machineName}</Link>
                          </span>
                        ))
                      )}
                    </td>
                    <td>{r.geo?.address ?? "—"}</td>
                    <td>
                      {r.geo ? `${r.geo.lat.toFixed(5)}, ${r.geo.lng.toFixed(5)}` : "— не отмечено"}
                    </td>
                    <td>{r.approvedAt ? "да" : "ждёт"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      <p className="hint">
        Вид места задаётся при заведении и определяет смысл: на локации продаж автомат торгует, на
        складе хранится, в мастерской чинится. Выручка считается только по локациям продаж — {}
        {placeTypeLabel("warehouse").toLowerCase()} и {placeTypeLabel("workshop").toLowerCase()} её
        не имеют по определению.
      </p>
    </>
  );
}
