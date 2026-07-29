import Link from "next/link";
import type { Entity } from "../lib/core";

/**
 * Карта автоматов — по настоящим координатам из карточек, без внешних сервисов.
 *
 * Точки спроецированы на рамку по широте/долготе: взаимное расположение
 * честное (север сверху). Синие — кофе, зелёные — снеки. Клик — карточка
 * автомата, там же кнопка «Открыть на карте» с настоящей картой города.
 */
export function MachineMap({ machines }: { machines: Entity[] }) {
  const pts = machines
    .map((m) => {
      const a = m.attrs ?? {};
      const lat = Number(a["широта"]);
      const lng = Number(a["долгота"]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 30 || lat > 55) return null;
      return { id: m.id, name: m.name, lat, lng, coffee: Number(a["категория"]) === 10 };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  if (pts.length === 0) return null;

  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const pad = 0.008;
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad;
  const maxLng = Math.max(...lngs) + pad;
  const W = 700;
  const H = 340;
  const x = (lng: number) => ((lng - minLng) / (maxLng - minLng)) * (W - 40) + 20;
  const y = (lat: number) => H - (((lat - minLat) / (maxLat - minLat)) * (H - 50) + 30);

  return (
    <div className="card" style={{ padding: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <pattern id="mgrid" width="35" height="35" patternUnits="userSpaceOnUse">
            <path d="M35 0H0V35" fill="none" stroke="#1E3350" strokeWidth="0.5" opacity="0.5" />
          </pattern>
        </defs>
        <rect width={W} height={H} rx="8" fill="url(#mgrid)" />
        {pts.map((p) => (
          <Link href={`/card/${p.id}`} key={p.id}>
            <g style={{ cursor: "pointer" }}>
              <circle
                cx={x(p.lng)}
                cy={y(p.lat)}
                r="7"
                fill={p.coffee ? "rgba(26,107,255,.22)" : "rgba(43,217,160,.2)"}
                stroke={p.coffee ? "#1A6BFF" : "#2BD9A0"}
                strokeWidth="1.6"
              />
              <circle cx={x(p.lng)} cy={y(p.lat)} r="2.2" fill={p.coffee ? "#1A6BFF" : "#2BD9A0"} />
              <text
                x={x(p.lng) + 11}
                y={y(p.lat) + 4}
                fontSize="10.5"
                fill="#8494A8"
                fontFamily="var(--fu)"
              >
                {p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name}
              </text>
            </g>
          </Link>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 14, padding: "8px 6px 2px", fontSize: 11.5, color: "var(--tx-2)" }}>
        <span><span style={{ color: "#1A6BFF" }}>●</span> кофе</span>
        <span><span style={{ color: "#2BD9A0" }}>●</span> снеки и напитки</span>
        <span style={{ marginLeft: "auto", color: "var(--tx-3)" }}>клик по точке — карточка автомата</span>
      </div>
    </div>
  );
}
