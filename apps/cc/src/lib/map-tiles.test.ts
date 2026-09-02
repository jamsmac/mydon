import { afterEach, describe, expect, it, vi } from "vitest";
import { OSM_TILES, mapTilesFromEnv, resolveMapTiles } from "./map-tiles";

describe("подложка карт (map-tiles)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("пустая настройка → бесключевой OSM с атрибуцией contributors, без предупреждений", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of [undefined, "", "   "]) {
      const t = resolveMapTiles(raw);
      expect(t.url).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
      expect(t.attribution).toContain("openstreetmap.org/copyright");
      expect(t.attribution).toContain("OpenStreetMap");
      expect(t.attribution).toContain("contributors");
      // Атрибуции CARTO у дефолта быть не должно — подложка больше не его.
      expect(t.attribution).not.toContain("CARTO");
    }
    // Пусто — штатный дефолт, а не опечатка: логи не засоряем.
    expect(warn).not.toHaveBeenCalled();
  });

  it("свой шаблон тайлов используется как есть", () => {
    const url = "https://tiles.example.uz/osm/{z}/{x}/{y}.png";
    const t = resolveMapTiles(url);
    expect(t.url).toBe(url);
    expect(t.attribution).toContain("OpenStreetMap");
  });

  it("URL cartocdn получает подпись CARTO поверх OSM", () => {
    const t = resolveMapTiles(
      "https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?api_key=k",
    );
    expect(t.attribution).toContain("CARTO");
    expect(t.attribution).toContain("OpenStreetMap");
  });

  it("мусор вместо шаблона откатывается на OSM с предупреждением в логах", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bads = [
      "https://tiles.example.uz/без-плейсхолдеров.png",
      "ftp://tiles.example.uz/{z}/{x}/{y}.png",
      "просто текст",
    ];
    for (const bad of bads) {
      expect(resolveMapTiles(bad)).toEqual(OSM_TILES);
    }
    // Опечатка в env иначе неотличима от «настройка не дошла до контейнера».
    expect(warn).toHaveBeenCalledTimes(bads.length);
    expect(String(warn.mock.calls[0]?.[0])).toContain("MAP_TILES_URL");
  });

  it("mapTilesFromEnv читает MAP_TILES_URL", () => {
    vi.stubEnv("MAP_TILES_URL", "https://tiles.example.uz/osm/{z}/{x}/{y}.png");
    expect(mapTilesFromEnv().url).toBe("https://tiles.example.uz/osm/{z}/{x}/{y}.png");
    vi.stubEnv("MAP_TILES_URL", "");
    expect(mapTilesFromEnv()).toEqual(OSM_TILES);
  });
});
