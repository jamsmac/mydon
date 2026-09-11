"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { POINT_COLOR, type PlacePoint } from "../lib/place-points";
import type { MapTiles } from "../lib/map-tiles";
import { PlaceScheme } from "./place-scheme";

// Leaflet трогает window — только на клиенте. Пока грузится, показываем схему.
const LiveMap = dynamic(() => import("./live-map"), {
  ssr: false,
  loading: () => (
    <div style={{ height: 420, display: "grid", placeItems: "center", color: "var(--tx-3)" }}>
      Загружаю карту…
    </div>
  ),
});

/** Числа для подписи — считаются на сервере (`placeMapCounts`). */
export interface MapPanelCounts {
  machinesTotal: number;
  machinesOnMap: number;
  coffee: number;
  snack: number;
  unknown: number;
  machinesNoPlace: number;
  machinesOnPlacesNoCoords: number;
  emptyPlacesOnMap: number;
}

/**
 * Панель карты парка. Точка — место (М-4), на нём — автоматы. Два вида одних
 * и тех же точек:
 *  • «Карта» — настоящая карта с дорогами (Leaflet; подложка — `tiles`
 *    с сервера, дефолт OSM, см. lib/map-tiles.ts);
 *  • «Схема» — наша SVG-сетка, работает без интернета (запас на сбой подложки).
 */
export function MapPanel({ points, counts, tiles }: { points: PlacePoint[]; counts: MapPanelCounts; tiles?: MapTiles }) {
  const [mode, setMode] = useState<"live" | "scheme">("live");
  const c = counts;

  const tab = (active: boolean): React.CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid var(--line)",
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--tx-2)",
  });

  return (
    <div className="card" style={{ padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" style={tab(mode === "live")} onClick={() => setMode("live")}>
            Карта
          </button>
          <button type="button" style={tab(mode === "scheme")} onClick={() => setMode("scheme")}>
            Схема
          </button>
        </div>
        <div style={{ display: "flex", gap: 14, marginLeft: "auto", fontSize: 11.5, color: "var(--tx-2)", flexWrap: "wrap" }}>
          <span><span style={{ color: POINT_COLOR.coffee }}>●</span> кофе {c.coffee}</span>
          <span><span style={{ color: POINT_COLOR.snack }}>●</span> снеки и напитки {c.snack}</span>
          {c.unknown > 0 && <span><span style={{ color: POINT_COLOR.unknown }}>○</span> тип не указан {c.unknown}</span>}
          {c.emptyPlacesOnMap > 0 && (
            <span><span style={{ color: POINT_COLOR.empty }}>○</span> мест без автоматов {c.emptyPlacesOnMap}</span>
          )}
        </div>
      </div>

      {mode === "live" ? (
        <LiveMap points={points} {...(tiles ? { tiles } : {})} />
      ) : (
        <PlaceScheme points={points} />
      )}

      <div style={{ padding: "8px 6px 2px", fontSize: 11.5, color: "var(--tx-3)", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span>автоматов на карте {c.machinesOnMap} из {c.machinesTotal}</span>
        {c.machinesOnPlacesNoCoords > 0 && (
          <span style={{ color: "#FF6B1A" }}>{c.machinesOnPlacesNoCoords} стоят на местах без координат</span>
        )}
        {c.machinesNoPlace > 0 && (
          <span style={{ color: "#FF6B1A" }}>{c.machinesNoPlace} без места в «Где стоит»</span>
        )}
      </div>
    </div>
  );
}
