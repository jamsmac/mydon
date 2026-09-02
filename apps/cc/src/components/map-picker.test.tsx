import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MapPicker } from "./map-picker";

// Как в live-map.test: jsdom настоящий Leaflet не отрисует, подменяем
// react-leaflet и проверяем, какие URL/атрибуция уходят в TileLayer.
vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="map">{children}</div>
  ),
  TileLayer: ({ url, attribution }: { url: string; attribution?: string }) => (
    <div data-testid="tile-layer" data-url={url} data-attribution={attribution} />
  ),
  CircleMarker: () => <div data-testid="marker" />,
  useMapEvents: () => null,
}));

describe("выбор точки на карте (MapPicker)", () => {
  it("развёрнутая карта без настройки — бесключевой OSM с атрибуцией", async () => {
    const user = userEvent.setup();
    render(<MapPicker lat="" lng="" onChange={() => {}} />);

    // Карта свёрнута — тайлы не запрашиваются вовсе.
    expect(screen.queryByTestId("tile-layer")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "📍 Отметить на карте" }));
    const tiles = screen.getByTestId("tile-layer");
    expect(tiles).toHaveAttribute("data-url", "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(tiles.getAttribute("data-attribution")).toContain("OpenStreetMap");
    expect(tiles.getAttribute("data-attribution")).toContain("contributors");
  });

  it("подложка из пропа побеждает дефолт", async () => {
    const user = userEvent.setup();
    render(
      <MapPicker
        lat="41.311100"
        lng="69.279700"
        onChange={() => {}}
        tiles={{ url: "https://tiles.example.uz/{z}/{x}/{y}.png", attribution: "проверка" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "📍 Отметить на карте" }));
    const tiles = screen.getByTestId("tile-layer");
    expect(tiles).toHaveAttribute("data-url", "https://tiles.example.uz/{z}/{x}/{y}.png");
    expect(tiles).toHaveAttribute("data-attribution", "проверка");
    // Точка из полей формы по-прежнему рисуется поверх любой подложки.
    expect(screen.getByTestId("marker")).toBeInTheDocument();
  });
});
