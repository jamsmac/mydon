import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Entity } from "../lib/core";
import { KIND_COLOR } from "../lib/machine-points";
import { OSM_TILES } from "../lib/map-tiles";
import LiveMap from "./live-map";

// Leaflet рисует в настоящий DOM с размерами — jsdom такого не умеет.
// Подменяем react-leaflet простыми элементами: тест проверяет, ЧТО карта
// просит рисовать (URL тайлов, атрибуцию, цвета точек), а не сам рендер.
vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="map">{children}</div>
  ),
  TileLayer: ({ url, attribution }: { url: string; attribution?: string }) => (
    <div data-testid="tile-layer" data-url={url} data-attribution={attribution} />
  ),
  CircleMarker: ({
    children,
    pathOptions,
  }: {
    children?: ReactNode;
    pathOptions?: { color?: string };
  }) => (
    <div data-testid="marker" data-color={pathOptions?.color}>
      {children}
    </div>
  ),
  Popup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useMap: () => ({ setView: vi.fn(), fitBounds: vi.fn() }),
}));

function machine(id: string, name: string, category: number | ""): Entity {
  return {
    id,
    type: "machine",
    name,
    externalRef: null,
    attrs: { категория: category },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    geo: { lat: 41.3111, lng: 69.2797, address: "Ташкент, ул. Олмачи" },
  };
}

describe("карта автоматов (LiveMap)", () => {
  it("без настройки рисует бесключевой OSM с атрибуцией contributors", () => {
    render(<LiveMap machines={[machine("m1", "Olma", 10)]} />);
    const tiles = screen.getByTestId("tile-layer");
    expect(tiles).toHaveAttribute("data-url", "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(tiles.getAttribute("data-attribution")).toContain("OpenStreetMap");
    expect(tiles.getAttribute("data-attribution")).toContain("contributors");
    expect(tiles.getAttribute("data-attribution")).not.toContain("CARTO");
  });

  it("настроенная подложка приходит пропом и уходит в TileLayer", () => {
    render(
      <LiveMap
        machines={[]}
        tiles={{ url: "https://tiles.example.uz/{z}/{x}/{y}.png", attribution: "проверка" }}
      />,
    );
    const tiles = screen.getByTestId("tile-layer");
    expect(tiles).toHaveAttribute("data-url", "https://tiles.example.uz/{z}/{x}/{y}.png");
    expect(tiles).toHaveAttribute("data-attribution", "проверка");
  });

  it("смена подложки не трогает точки: цвета кофе/снек и ссылка на карточку целы", () => {
    render(
      <LiveMap
        machines={[machine("m1", "Кофейный", 10), machine("m2", "Снековый", 20)]}
        tiles={OSM_TILES}
      />,
    );
    const markers = screen.getAllByTestId("marker");
    expect(markers.map((m) => m.getAttribute("data-color"))).toEqual([
      KIND_COLOR.coffee,
      KIND_COLOR.snack,
    ]);
    const links = screen.getAllByRole("link", { name: "Открыть карточку →" });
    expect(links[0]).toHaveAttribute("href", "/card/m1");
    expect(links[1]).toHaveAttribute("href", "/card/m2");
  });
});
