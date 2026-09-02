/**
 * Подложка карт: откуда берутся тайлы и чья атрибуция.
 *
 * ЗАЧЕМ. Панель рисовала подложку CARTO без ключа — CARTO закрыл анонимный
 * доступ, и вместо города дашборд показывал плашки «API KEY REQUIRED».
 * Урок: источник тайлов — внешняя зависимость со своими правилами, и он
 * обязан (а) переживать смену этих правил настройкой, а не правкой кода,
 * (б) по умолчанию работать без ключа вовсе.
 *
 * Дефолт — стандартные тайлы OpenStreetMap: бесключевые, а трафик панели
 * (один владелец, десятки автоматов) заведомо в рамках их tile usage policy.
 * Обязательное условие той же политики — видимая атрибуция
 * «© OpenStreetMap contributors»; она зашита рядом с URL, чтобы их нельзя
 * было разнести.
 *
 * Переопределение — `MAP_TILES_URL` в .env (см. .env.example). Переменную
 * читает СЕРВЕР (страницы Next), а компонентам карты она приходит пропом:
 * cc читает env в рантайме (как CORE_API_URL), NEXT_PUBLIC_* же вшивается на
 * сборке — в Docker-образ без build-args такая настройка не попала бы вовсе.
 */

export interface MapTiles {
  /** Шаблон тайлов Leaflet: обязательно с {z}/{x}/{y}. */
  url: string;
  /** HTML-атрибуция источника — Leaflet показывает её в углу карты. */
  attribution: string;
}

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Тайлы CARTO — отрисовка поверх данных OSM: их политика требует обе подписи.
const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION}, &copy; <a href="https://carto.com/attributions">CARTO</a>`;

/** Бесключевой дефолт — им же живут компоненты карты, если проп не передан. */
export const OSM_TILES: MapTiles = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: OSM_ATTRIBUTION,
};

/**
 * Разбирает значение MAP_TILES_URL. Пусто — дефолт OSM без шума (это
 * штатная настройка). Непустое, но не похожее на шаблон тайлов (нет
 * {z}/{x}/{y} или не http/https) — тоже дефолт OSM, карта с дорогами лучше
 * пустой из-за опечатки в env, но с console.warn: иначе опечатка неотличима
 * от «настройка вовсе не дошла до контейнера». Атрибуция подбирается по
 * источнику: cartocdn — подпись CARTO поверх OSM, всё остальное считаем
 * отрисовкой OSM.
 */
export function resolveMapTiles(raw: string | undefined): MapTiles {
  const url = (raw ?? "").trim();
  if (url === "") return OSM_TILES;
  const isTemplate =
    /^https?:\/\//.test(url) && url.includes("{z}") && url.includes("{x}") && url.includes("{y}");
  if (!isTemplate) {
    console.warn(
      `MAP_TILES_URL отбракован (нужен http(s)-шаблон с {z}/{x}/{y}), подложка откатилась на OSM: ${url}`,
    );
    return OSM_TILES;
  }
  return {
    url,
    attribution: url.includes("cartocdn") ? CARTO_ATTRIBUTION : OSM_ATTRIBUTION,
  };
}

/** Для серверных страниц: настройка из env одним вызовом. */
export function mapTilesFromEnv(): MapTiles {
  return resolveMapTiles(process.env.MAP_TILES_URL);
}
