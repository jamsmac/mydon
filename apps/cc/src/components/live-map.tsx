"use client";

import { useEffect } from "react";
import Link from "next/link";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import { POINT_COLOR, pointKindLabel, type PlacePoint } from "../lib/place-points";
import { OSM_TILES, type MapTiles } from "../lib/map-tiles";
import "leaflet/dist/leaflet.css";

// Центр по умолчанию — Ташкент (в VendTripBot была Москва).
const TASHKENT: [number, number] = [41.2995, 69.2401];

/** Подгоняет карту под все точки. Одна точка — просто ставим по центру. */
function FitToPoints({ pts }: { pts: PlacePoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView([pts[0]!.lat, pts[0]!.lng], 15);
      return;
    }
    const bounds = pts.map((p) => [p.lat, p.lng] as [number, number]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [map, pts]);
  return null;
}

/**
 * Настоящая карта парка (перенос из VendTripBot, React-Leaflet). Точка — МЕСТО
 * (М-4): координата принадлежит месту, автоматы — то, что на нём стоит сейчас.
 *
 *  • подложка настраиваемая (`tiles` приходит с сервера из MAP_TILES_URL),
 *    дефолт — бесключевой OSM: CARTO закрыл анонимные тайлы, см. lib/map-tiles.ts;
 *  • точки — векторные CircleMarker в нашей палитре, без внешних PNG-иконок;
 *    место без автоматов — светлым пунктиром;
 *  • центр Ташкент; клик — место и его автоматы со ссылками на карточки.
 *
 * Места одного адреса с разными координатами (корпуса KIUT) дают точки рядом —
 * это правильная картина, а не дубликат (М-10).
 */
export default function LiveMap({
  points,
  tiles = OSM_TILES,
}: {
  points: PlacePoint[];
  tiles?: MapTiles;
}) {
  const center = points.length > 0 ? ([points[0]!.lat, points[0]!.lng] as [number, number]) : TASHKENT;

  return (
    <MapContainer
      center={center}
      zoom={12}
      scrollWheelZoom
      style={{ height: 420, width: "100%", borderRadius: 12, background: "#f4f4ee" }}
    >
      {/* maxZoom 19 — потолок стандартных тайлов OSM; выше отдаются пустые. */}
      <TileLayer attribution={tiles.attribution} url={tiles.url} maxZoom={19} />
      <FitToPoints pts={points} />
      {points.map((p) => (
        <CircleMarker
          key={p.id}
          center={[p.lat, p.lng]}
          radius={p.machines.length > 1 ? 10 : 8}
          pathOptions={{
            color: POINT_COLOR[p.kind],
            fillColor: POINT_COLOR[p.kind],
            fillOpacity: p.kind === "empty" ? 0.15 : 0.35,
            weight: 2,
            dashArray: p.kind === "unknown" || p.kind === "empty" ? "3 3" : undefined,
          }}
        >
          <Popup>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>{p.name}</div>
            {p.address && (
              <div style={{ color: "#4a554a", fontSize: 12, marginBottom: 6 }}>{p.address}</div>
            )}
            <div style={{ fontSize: 12, marginBottom: 6 }}>{pointKindLabel(p.kind)}</div>
            {p.machines.length > 0 && (
              <ul style={{ margin: "0 0 6px", paddingLeft: 16, fontSize: 12 }}>
                {p.machines.map((m) => (
                  <li key={m.id}>
                    <Link href={`/card/${m.id}`}>{m.name}</Link>
                  </li>
                ))}
              </ul>
            )}
            <Link href={`/card/${p.id}`} style={{ color: "#b8480f", fontWeight: 600 }}>
              Открыть место →
            </Link>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
