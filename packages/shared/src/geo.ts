/**
 * Координаты: разбор и проверка диапазона в одном месте.
 *
 * Раньше широта/долгота жили в `attrs` строками без всякой проверки: можно было
 * записать «широта: 999» или перепутать её с долготой, и ошибка всплывала бы
 * позже — точка молча пропадала с карты. Здесь координата приводится к числу и
 * проверяется по мировому диапазону (−90..90 и −180..180). Узкий фильтр по
 * Узбекистану — отдельная забота карты (это отображение, а не хранение).
 */

/** Точка на карте. */
export interface Coord {
  lat: number;
  lng: number;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.length === 0) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Координата из пары значений (строк или чисел). Вне мирового диапазона или
 * непарсимое — `null`, а не молчаливая подстановка.
 */
export function parseCoord(lat: unknown, lng: unknown): Coord | null {
  const la = toNum(lat);
  const ln = toNum(lng);
  if (la === null || ln === null) return null;
  if (la < -90 || la > 90) return null;
  if (ln < -180 || ln > 180) return null;
  return { lat: la, lng: ln };
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === "";

/**
 * Координаты из attrs карточки (`широта`/`долгота`).
 *
 * `present` — заявлены ли обе величины (владелец ввёл координаты). `coord` —
 * разобранная точка или `null`, если введённое вне диапазона/непарсимо.
 * Различать «не вводил» и «ввёл неверно» важно: первое — норма, второе — ошибка,
 * которую надо не проглотить, а вернуть.
 */
export function coordFromAttrs(attrs: Record<string, unknown> | null | undefined): {
  present: boolean;
  coord: Coord | null;
} {
  const rawLat = attrs?.["широта"];
  const rawLng = attrs?.["долгота"];
  if (isEmpty(rawLat) && isEmpty(rawLng)) return { present: false, coord: null };
  return { present: true, coord: parseCoord(rawLat, rawLng) };
}

/** Адрес точки из attrs: первое непустое из «точка»/«адрес»/«локация». */
export function addressFromAttrs(attrs: Record<string, unknown> | null | undefined): string | null {
  for (const key of ["точка", "адрес", "локация"]) {
    const v = attrs?.[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}
