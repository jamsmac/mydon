"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PLACE_TYPES, PLACE_TYPE_HINTS, PLACE_TYPE_LABELS, type PlaceType } from "@mydon/shared";
import dynamic from "next/dynamic";
import { createEntity } from "../app/card/actions";
import type { MapTiles } from "../lib/map-tiles";

// Leaflet трогает window — только на клиенте, как и карта автоматов рядом.
// `"use client"` серверный рендер не отменяет, а страница объявлена
// force-dynamic — поэтому сборка её не отрисовывала и падало лишь на живом
// запросе.
const MapPicker = dynamic(() => import("./map-picker").then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <p className="hint">Карта загружается…</p>,
});

/**
 * Заведение места: имя, вид, точка на карте.
 *
 * Место — обычная карточка реестра, поэтому создание идёт тем же
 * `createEntity`, что и товар или контрагент. Отдельная форма нужна из-за
 * двух вещей, которых нет у остальных типов: выбора вида и координат.
 *
 * Вид спрашивается ПЕРВЫМ и обязателен. Он определяет смысл места — на точке
 * продаж автомат торгует, на складе хранится, в мастерской чинится — и от него
 * зависит, считать ли сюда выручку. Выводить вид из названия («если в имени
 * есть „склад“…») значило бы повторить ошибку, на которой уже дважды
 * обожглись с видом и состоянием автомата.
 */
export function NewPlaceForm({
  domain = "vendhub",
  tiles,
}: {
  domain?: string;
  /** Подложка карты с сервера (MAP_TILES_URL); без пропа — бесключевой OSM. */
  tiles?: MapTiles;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PlaceType>("location");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    form.set("lat", lat);
    form.set("lng", lng);
    start(async () => {
      const res = await createEntity(domain, kind, form);
      if (res.ok) {
        setOpen(false);
        setLat("");
        setLng("");
        setError(null);
        router.refresh();
      } else {
        setError(res.error ?? "Не удалось создать");
      }
    });
  }

  if (!open) {
    return (
      <button type="button" className="btn pri" onClick={() => setOpen(true)}>
        + Новое место
      </button>
    );
  }

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget));
      }}
    >
      <p className="eyebrow">Вид места</p>
      <div className="chips" style={{ marginBottom: 4 }}>
        {PLACE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`chip ${kind === t ? "active" : ""}`}
            onClick={() => setKind(t)}
            disabled={pending}
          >
            {PLACE_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginBottom: 12 }}>
        {PLACE_TYPE_HINTS[kind]}
      </p>

      <label>
        Название
        <input name="name" placeholder="Olma склад, Мастерская на Чиланзаре" required disabled={pending} />
      </label>

      <label>
        Адрес
        <input name="address" placeholder="улица, дом — необязательно" disabled={pending} />
      </label>

        <label>
          Широта
          <input
            name="lat"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="41.299500"
            inputMode="decimal"
            disabled={pending}
          />
        </label>
        <label>
          Долгота
          <input
            name="lng"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            placeholder="69.240100"
            inputMode="decimal"
            disabled={pending}
          />
        </label>

      <MapPicker
        lat={lat}
        lng={lng}
        onChange={(a, b) => {
          setLat(a);
          setLng(b);
        }}
        {...(tiles ? { tiles } : {})}
      />

      <div className="form-actions" style={{ marginTop: 12 }}>
        <button type="submit" className="btn pri" disabled={pending}>
          {pending ? "Создаю…" : "Создать место"}
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)} disabled={pending}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}
