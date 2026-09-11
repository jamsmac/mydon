import Link from "next/link";
import { POINT_COLOR, type PlacePoint, type PointKind } from "../lib/place-points";

/** Полупрозрачная заливка кружка — тот же вид, что обводка, светлее. */
const FILL: Record<PointKind, string> = {
  coffee: "rgba(39,94,88,.22)",
  snack: "rgba(98,119,25,.2)",
  unknown: "rgba(90,107,128,.18)",
  mixed: "rgba(107,90,142,.2)",
  empty: "rgba(179,184,174,.12)",
};

/**
 * Карта-схема мест — по настоящим координатам, без интернета.
 *
 * Точки спроецированы на рамку по широте/долготе: взаимное расположение
 * честное (север сверху). Клик — карточка места. Это запасной вид: работает,
 * даже если внешняя подложка не открылась.
 */
export function PlaceScheme({ points }: { points: PlacePoint[] }) {
  if (points.length === 0) return null;

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
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
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <defs>
        <pattern id="mgrid" width="35" height="35" patternUnits="userSpaceOnUse">
          <path d="M35 0H0V35" fill="none" stroke="#dce0d7" strokeWidth="0.5" opacity="0.5" />
        </pattern>
      </defs>
      <rect width={W} height={H} rx="8" fill="url(#mgrid)" />
      {points.map((p) => {
        const label = p.machines.length > 1 ? `${p.name} ×${p.machines.length}` : p.name;
        return (
          <Link href={`/card/${p.id}`} key={p.id}>
            <g style={{ cursor: "pointer" }}>
              <circle
                cx={x(p.lng)}
                cy={y(p.lat)}
                r="7"
                fill={FILL[p.kind]}
                stroke={POINT_COLOR[p.kind]}
                strokeWidth="1.6"
                strokeDasharray={p.kind === "unknown" || p.kind === "empty" ? "2 2" : undefined}
              />
              <circle cx={x(p.lng)} cy={y(p.lat)} r="2.2" fill={POINT_COLOR[p.kind]} />
              <text x={x(p.lng) + 11} y={y(p.lat) + 4} fontSize="10.5" fill="#4a554a" fontFamily="var(--fu)">
                {label.length > 24 ? `${label.slice(0, 23)}…` : label}
              </text>
            </g>
          </Link>
        );
      })}
    </svg>
  );
}
