"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { Entity } from "../lib/core";
import { machineCounts, KIND_COLOR } from "../lib/machine-points";
import { MachineMap } from "./machine-map";

// Leaflet трогает window — только на клиенте. Пока грузится, показываем схему.
const LiveMap = dynamic(() => import("./live-map"), {
  ssr: false,
  loading: () => (
    <div style={{ height: 420, display: "grid", placeItems: "center", color: "var(--tx-3)" }}>
      Загружаю карту…
    </div>
  ),
});

/**
 * Панель карты автоматов. Два вида одних и тех же точек:
 *  • «Карта» — настоящая карта с дорогами (Leaflet, тёмная подложка);
 *  • «Схема» — наша SVG-сетка, работает без интернета (запас на сбой подложки).
 * Переключатель наверху. Ни маршрутов, ни денег — только отображение (этап интерфейса).
 */
export function MapPanel({ machines }: { machines: Entity[] }) {
  const [mode, setMode] = useState<"live" | "scheme">("live");
  const c = machineCounts(machines);

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
          <span><span style={{ color: KIND_COLOR.coffee }}>●</span> кофе {c.coffee}</span>
          <span><span style={{ color: KIND_COLOR.snack }}>●</span> снеки и напитки {c.snack}</span>
          {c.unknown > 0 && <span><span style={{ color: KIND_COLOR.unknown }}>○</span> тип не указан {c.unknown}</span>}
        </div>
      </div>

      {mode === "live" ? <LiveMap machines={machines} /> : <MachineMap machines={machines} />}

      <div style={{ padding: "8px 6px 2px", fontSize: 11.5, color: "var(--tx-3)", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span>на карте {c.onMap} из {c.total}</span>
        {c.noCoords > 0 && <span style={{ color: "#FF6B1A" }}>без координат {c.noCoords} — добавьте адрес в карточке</span>}
        <span style={{ marginLeft: "auto" }}>маршруты — следующий этап</span>
      </div>
    </div>
  );
}
