"use client";

import { useEffect } from "react";
import Link from "next/link";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import type { Entity } from "../lib/core";
import { machinePoints, KIND_COLOR, type MachinePoint } from "../lib/machine-points";
import { OSM_TILES, type MapTiles } from "../lib/map-tiles";
import "leaflet/dist/leaflet.css";

// Центр по умолчанию — Ташкент (в VendTripBot была Москва).
const TASHKENT: [number, number] = [41.2995, 69.2401];

/** Подгоняет карту под все точки. Одна точка — просто ставим по центру. */
function FitToPoints({ pts }: { pts: MachinePoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView([pts[0].lat, pts[0].lng], 15);
      return;
    }
    const bounds = pts.map((p) => [p.lat, p.lng] as [number, number]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [map, pts]);
  return null;
}

/**
 * Настоящая карта автоматов (перенос из VendTripBot, React-Leaflet).
 *
 * Отличия от оригинала — под наши правила:
 *  • подложка настраиваемая (`tiles` приходит с сервера из MAP_TILES_URL),
 *    дефолт — бесключевой OSM: CARTO закрыл анонимные тайлы, см. lib/map-tiles.ts;
 *  • точки — векторные CircleMarker в нашей палитре, без внешних PNG-иконок;
 *  • центр Ташкент; клик по точке — карточка автомата.
 *
 * Ни денег, ни маршрутов, ни расчётов — только отображение и вид (этап интерфейса).
 */
export default function LiveMap({
  machines,
  tiles = OSM_TILES,
}: {
  machines: Entity[];
  tiles?: MapTiles;
}) {
  const pts = machinePoints(machines);
  const center = pts.length > 0 ? ([pts[0].lat, pts[0].lng] as [number, number]) : TASHKENT;

  return (
    <MapContainer
      center={center}
      zoom={12}
      scrollWheelZoom
      style={{ height: 420, width: "100%", borderRadius: 12, background: "#f4f4ee" }}
    >
      {/* maxZoom 19 — потолок стандартных тайлов OSM; выше отдаются пустые. */}
      <TileLayer attribution={tiles.attribution} url={tiles.url} maxZoom={19} />
      <FitToPoints pts={pts} />
      {pts.map((p) => (
        <CircleMarker
          key={p.id}
          center={[p.lat, p.lng]}
          radius={8}
          pathOptions={{
            color: KIND_COLOR[p.kind],
            fillColor: KIND_COLOR[p.kind],
            fillOpacity: 0.35,
            weight: 2,
            dashArray: p.kind === "unknown" ? "3 3" : undefined,
          }}
        >
          <Popup>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>{p.name}</div>
            {p.address && (
              <div style={{ color: "#4a554a", fontSize: 12, marginBottom: 6 }}>{p.address}</div>
            )}
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              {p.kind === "coffee" ? "☕ кофе" : p.kind === "snack" ? "🥤 снеки и напитки" : "тип не указан"}
            </div>
            <Link href={`/card/${p.id}`} style={{ color: "#b8480f", fontWeight: 600 }}>
              Открыть карточку →
            </Link>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
