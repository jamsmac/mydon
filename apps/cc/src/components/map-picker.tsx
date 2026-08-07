"use client";

import { useState } from "react";
import { MapContainer, TileLayer, CircleMarker, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";

// Центр по умолчанию — Ташкент, как и на карте автоматов.
const TASHKENT: [number, number] = [41.2995, 69.2401];

/**
 * Точность координат — шесть знаков после запятой.
 *
 * Это примерно 11 см на экваторе: больше не нужно даже для двери в подъезд, а
 * колонки `geo_point.lat/lng` объявлены как numeric(9,6) и всё равно округлят.
 * Писать в карточку двенадцать знаков значило бы показывать владельцу мусор,
 * который база молча обрежет.
 */
const ЗНАКОВ = 6;
const округлить = (n: number): string => n.toFixed(ЗНАКОВ);

/** Клик по карте ставит точку. Отдельный компонент — useMapEvents живёт внутри карты. */
function ЛовительКлика({ onPick }: { onPick: (lat: string, lng: string) => void }) {
  useMapEvents({
    click(e) {
      onPick(округлить(e.latlng.lat), округлить(e.latlng.lng));
    },
  });
  return null;
}

/**
 * Выбор точки на карте: кликнул — координаты в форме.
 *
 * ЗАЧЕМ. До этого координаты вводились только руками, двумя числами. Владелец
 * знает, ГДЕ стоит автомат, но не знает его широту — и место оставалось без
 * точки, а значит без карты.
 *
 * Клик, а не перетаскиваемый маркер: перетаскивание требует, чтобы маркер
 * сначала где-то появился, то есть координаты уже были. Клик работает с
 * чистого листа — именно то, что нужно новому месту.
 *
 * Поля ввода остаются рядом и остаются главными: координаты можно вставить из
 * навигатора, а карта тогда просто показывает, куда это попало. Карта —
 * второй способ, а не замена первому.
 */
export function MapPicker({
  lat,
  lng,
  onChange,
}: {
  lat: string;
  lng: string;
  onChange: (lat: string, lng: string) => void;
}) {
  const [показать, setПоказать] = useState(false);

  const число = (v: string): number | null => {
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const la = число(lat);
  const ln = число(lng);
  const точкаЕсть = la !== null && ln !== null && (la !== 0 || ln !== 0);
  const центр: [number, number] = точкаЕсть ? [la, ln] : TASHKENT;

  return (
    <div>
      <div className="form-actions" style={{ marginBottom: 8 }}>
        <button type="button" className="btn ghost sm" onClick={() => setПоказать((v) => !v)}>
          {показать ? "Свернуть карту" : "📍 Отметить на карте"}
        </button>
        {точкаЕсть && (
          <span className="hint">
            {la.toFixed(ЗНАКОВ)}, {ln.toFixed(ЗНАКОВ)}
          </span>
        )}
        {точкаЕсть && (
          <button type="button" className="btn ghost sm" onClick={() => onChange("", "")}>
            Убрать точку
          </button>
        )}
      </div>

      {показать && (
        <>
          <p className="hint" style={{ marginBottom: 6 }}>
            Клик по карте ставит точку. Координаты попадут в поля выше — их можно поправить руками.
          </p>
          <MapContainer
            center={центр}
            zoom={точкаЕсть ? 16 : 11}
            scrollWheelZoom
            style={{ height: 320, width: "100%", borderRadius: 12, background: "#0A1628" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />
            <ЛовительКлика onPick={onChange} />
            {точкаЕсть && (
              <CircleMarker
                center={[la, ln]}
                radius={9}
                pathOptions={{ color: "#F0883E", fillColor: "#F0883E", fillOpacity: 0.85, weight: 2 }}
              />
            )}
          </MapContainer>
        </>
      )}
    </div>
  );
}
