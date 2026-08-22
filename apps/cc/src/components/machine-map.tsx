import Link from "next/link";
import type { Entity } from "../lib/core";
import { machinePoints, KIND_COLOR } from "../lib/machine-points";

/**
 * Карта-схема автоматов — по настоящим координатам из карточек, без интернета.
 *
 * Точки спроецированы на рамку по широте/долготе: взаимное расположение
 * честное (север сверху). Синие — кофе, зелёные — снеки. Клик — карточка
 * автомата. Это запасной вид: работает, даже если внешняя подложка не открылась.
 */
export function MachineMap({ machines }: { machines: Entity[] }) {
  const pts = machinePoints(machines);

  if (pts.length === 0) return null;

  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const pad = 0.008;
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad;
  const maxLng = Math.max(...lngs) + pad;
  const COLOR = KIND_COLOR;
  const FILL = {
    coffee: "rgba(26,107,255,.22)",
    snack: "rgba(43,217,160,.2)",
    unknown: "rgba(90,107,128,.18)",
  } as const;
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
        {pts.map((p) => (
          <Link href={`/card/${p.id}`} key={p.id}>
            <g style={{ cursor: "pointer" }}>
              <circle
                cx={x(p.lng)}
                cy={y(p.lat)}
                r="7"
                fill={FILL[p.kind]}
                stroke={COLOR[p.kind]}
                strokeWidth="1.6"
                strokeDasharray={p.kind === "unknown" ? "2 2" : undefined}
              />
              <circle cx={x(p.lng)} cy={y(p.lat)} r="2.2" fill={COLOR[p.kind]} />
              <text
                x={x(p.lng) + 11}
                y={y(p.lat) + 4}
                fontSize="10.5"
                fill="#4a554a"
                fontFamily="var(--fu)"
              >
                {p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name}
              </text>
            </g>
          </Link>
        ))}
    </svg>
  );
}
