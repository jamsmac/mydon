/**
 * Адрес по координатам — обратное геокодирование (М-5, волна 2).
 *
 * Источник — Nominatim (OpenStreetMap): бесключевой, тот же, чья подложка уже
 * стоит на карте. Правила пользования: осмысленный User-Agent, не чаще раза в
 * секунду, без массовых прогонов. Здесь запрос один на клик владельца по
 * карте — это ровно та нагрузка, для которой публичный сервер и существует.
 *
 * Адрес — ПОДСКАЗКА, а не факт: он подставляется в поле и остаётся правимым,
 * а в карточку ложится с пометкой источника (R-H-8). Слово «Узбекистан» и
 * почтовый индекс отбрасываем: по стране у нас все точки, индекс техник не
 * ищет.
 */

export const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";

/** Подпись запросов. Без почты владельца: её не отправляем стороннему сервису. */
export const GEOCODER_USER_AGENT = "MYDON-command-center/1.0 (+https://github.com/jamsmac/mydon)";

/** Значение пометки источника (`PLACE_ATTR.addressSource`) у адреса с карты. */
export const ADDRESS_SOURCE_MAP = "по карте (OpenStreetMap) — проверить";

interface NominatimAddress {
  road?: string;
  pedestrian?: string;
  house_number?: string;
  neighbourhood?: string;
  quarter?: string;
  suburb?: string;
  city_district?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
}

/**
 * Короткий адрес из ответа Nominatim: «улица, дом, район, город». Ничего
 * не нашлось — `null`, а не пустая строка: пустое поле честнее выдуманного.
 */
export function formatReverse(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const a = (json as { address?: NominatimAddress }).address;
  if (!a) return null;
  const street = a.road ?? a.pedestrian;
  const parts = [
    street && a.house_number ? `${street}, ${a.house_number}` : street,
    a.suburb ?? a.city_district ?? a.quarter ?? a.neighbourhood,
    a.city ?? a.town ?? a.village ?? a.county ?? a.state,
  ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  // Район и город у Nominatim иногда совпадают («Ташкент, Ташкент»).
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  return unique.length > 0 ? unique.join(", ") : null;
}
