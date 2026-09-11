import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { POINT_COLOR, type PlacePoint } from "../lib/place-points";
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

function point(id: string, name: string, kind: PlacePoint["kind"], machines: { id: string; name: string }[] = []): PlacePoint {
  return { id, name, lat: 41.3111, lng: 69.2797, kind, address: "Ташкент, ул. Олмачи", machines };
}

describe("карта парка (LiveMap): точка — место", () => {
  it("без настройки рисует бесключевой OSM с атрибуцией contributors", () => {
    render(<LiveMap points={[point("p1", "Olma", "coffee")]} />);
    const tiles = screen.getByTestId("tile-layer");
    expect(tiles).toHaveAttribute("data-url", "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(tiles.getAttribute("data-attribution")).toContain("OpenStreetMap");
    expect(tiles.getAttribute("data-attribution")).toContain("contributors");
    expect(tiles.getAttribute("data-attribution")).not.toContain("CARTO");
  });

  it("настроенная подложка приходит пропом и уходит в TileLayer", () => {
    render(<LiveMap points={[]} tiles={{ url: "https://tiles.example.uz/{z}/{x}/{y}.png", attribution: "проверка" }} />);
    const tiles = screen.getByTestId("tile-layer");
    expect(tiles).toHaveAttribute("data-url", "https://tiles.example.uz/{z}/{x}/{y}.png");
    expect(tiles).toHaveAttribute("data-attribution", "проверка");
  });

  it("цвет точки — по виду автоматов на месте; пустое место — своим цветом", () => {
    render(
      <LiveMap
        points={[point("p1", "Кофейная", "coffee"), point("p2", "Снековая", "snack"), point("p3", "Склад", "empty")]}
        tiles={OSM_TILES}
      />,
    );
    expect(screen.getAllByTestId("marker").map((m) => m.getAttribute("data-color"))).toEqual([
      POINT_COLOR.coffee,
      POINT_COLOR.snack,
      POINT_COLOR.empty,
    ]);
  });

  it("во всплывашке — место и его автоматы со ссылками на карточки", () => {
    render(<LiveMap points={[point("p1", "KIUT Библиотека", "coffee", [{ id: "m1", name: "KIUT Библиотека" }])]} />);
    expect(screen.getByRole("link", { name: "Открыть место →" })).toHaveAttribute("href", "/card/p1");
    expect(screen.getByRole("link", { name: "KIUT Библиотека" })).toHaveAttribute("href", "/card/m1");
  });
});
