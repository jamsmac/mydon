import type { Entity } from "./core";

export type MachineKind = "coffee" | "snack" | "unknown";

export interface MachinePoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: MachineKind;
  address: string | null;
}

/**
 * Цвета точек по виду — единые для схемы и настоящей карты.
 *
 * Значения, а не токены: их читает Leaflet и canvas, где CSS-переменные не
 * применимы. Подобраны под светлый холст `#f4f4ee`, все читаются на нём как
 * заливка с тёмной обводкой. Умышленно НЕ совпадают ни с брендом, ни с
 * тревогой: вид техники — это классификация, а не состояние, и путать её с
 * «нажми» нельзя.
 */
export const KIND_COLOR: Record<MachineKind, string> = {
  coffee: "#275e58",
  snack: "#627719",
  unknown: "#8b9689",
};

/**
 * Точки автоматов из карточек. Координаты берём числами и проверяем диапазон
 * Узбекистана: это ловит перепутанные местами широту/долготу (у них lat≈69
 * не пройдёт по 30..55, lng≈41 не пройдёт по 55..80) — раньше такие точки
 * молча исчезали с карты (находка аудита 2026-07-30).
 *
 * Тип — только из заполненного поля. Пустая категория = «не указан»,
 * а не «снеки»: выдавать незаполненное за факт нельзя.
 */
export function machinePoints(machines: Entity[]): MachinePoint[] {
  const out: MachinePoint[] = [];
  for (const m of machines) {
    const a = m.attrs ?? {};
    // Источник истины — типизированная точка (проверена на записи). Пока
    // карточка не мигрировала — берём координаты из attrs, как раньше.
    const lat = m.geo ? m.geo.lat : Number(a["широта"]);
    const lng = m.geo ? m.geo.lng : Number(a["долгота"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < 30 || lat > 55) continue;
    if (lng < 55 || lng > 80) continue;
    const raw = a["категория"];
    const kind: MachineKind =
      raw === undefined || raw === null || raw === ""
        ? "unknown"
        : Number(raw) === 10
          ? "coffee"
          : "snack";
    const addr = m.geo?.address ?? a["адрес"] ?? a["точка"] ?? a["локация"];
    out.push({
      id: m.id,
      name: m.name,
      lat,
      lng,
      kind,
      address: typeof addr === "string" && addr.length > 0 ? addr : null,
    });
  }
  return out;
}

/** Сколько автоматов по типам + сколько без координат (для честной подписи). */
export function machineCounts(machines: Entity[]) {
  const pts = machinePoints(machines);
  return {
    total: machines.length,
    onMap: pts.length,
    coffee: pts.filter((p) => p.kind === "coffee").length,
    snack: pts.filter((p) => p.kind === "snack").length,
    unknown: pts.filter((p) => p.kind === "unknown").length,
    noCoords: machines.length - pts.length,
  };
}
