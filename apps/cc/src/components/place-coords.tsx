"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { reverseGeocode, saveLocation } from "../app/card/actions";
import type { MapTiles } from "../lib/map-tiles";

// Карта тянет leaflet — грузим только когда владелец открыл правку.
const MapPicker = dynamic(() => import("./map-picker").then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <p className="hint">Карта загружается…</p>,
});

/**
 * Координаты и адрес МЕСТА (М-4) — та же форма, что при создании места: два
 * поля плюс карта. У КАЖДОГО места свои координаты, даже если адрес совпадает с
 * соседним: у KIUT несколько корпусов по одному адресу (М-10).
 *
 * Клик по карте определяет адрес (М-5). Подсказка не затирает то, что человек
 * вписал руками: поле пустое или в нём ещё нетронутая подсказка — подставляем;
 * человек адрес правил — предлагаем кнопкой. Иначе второй клик по карте молча
 * стёр бы уточнение «2 этаж, у лифта».
 *
 * Пометки источника (R-H-8) видны рядом со значением: «по карте — проверить»,
 * «перенесено с автомата …». Человек сохранил своё — пометка снимается.
 */
export function PlaceCoords({
  entityId,
  lat,
  lng,
  address,
  addressSource,
  coordsSource,
  tiles,
}: {
  entityId: string;
  lat: string | null;
  lng: string | null;
  address: string | null;
  /** Пометка «источник адреса», если адрес не со слов человека. */
  addressSource: string | null;
  /** Пометка «источник координат» (перенос с автомата). */
  coordsSource: string | null;
  tiles?: MapTiles;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [la, setLa] = useState(lat ?? "");
  const [ln, setLn] = useState(lng ?? "");
  const [addr, setAddr] = useState(address ?? "");
  /** Адрес в поле — нетронутая подсказка геокодера («map») или слово человека. */
  const [addrFrom, setAddrFrom] = useState<"map" | "human">(addressSource ? "map" : "human");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [geoNote, setGeoNote] = useState<string | null>(null);
  /** Номер последнего клика: ответ на старый клик не перетирает новый. */
  const lastClick = useRef(0);
  /**
   * Актуальные адрес и его источник — для ответа геокодера. Ответ приходит
   * позже клика; сверка со значениями НА МОМЕНТ КЛИКА затёрла бы адрес, который
   * человек успел вписать, пока шёл запрос.
   */
  const current = useRef({ addr: address ?? "", from: addressSource ? ("map" as const) : ("human" as const) });
  const setAddress = (value: string, from: "map" | "human") => {
    current.current = { addr: value, from };
    setAddr(value);
    setAddrFrom(from);
  };

  const естьТочка = lat !== null && lng !== null;
  const mapHref = естьТочка ? `https://maps.google.com/?q=${lat},${lng}` : null;

  const onPick = (a: string, b: string) => {
    setLa(a);
    setLn(b);
    setSuggestion(null);
    setGeoNote("Определяю адрес…");
    const click = ++lastClick.current;
    void reverseGeocode(Number(a), Number(b)).then((res) => {
      if (click !== lastClick.current) return;
      if (!res.ok) {
        setGeoNote(res.error);
        return;
      }
      if (res.address === null) {
        setGeoNote("По этой точке адрес не нашёлся — впишите руками");
        return;
      }
      setGeoNote(null);
      if (current.current.addr.trim() === "" || current.current.from === "map") {
        setAddress(res.address, "map");
      } else {
        setSuggestion(res.address);
      }
    });
  };

  const save = () => {
    setMsg(null);
    start(async () => {
      const res = await saveLocation(entityId, { lat: la, lng: ln, address: addr, addressSource: addrFrom });
      if (res.ok) {
        setMsg({ ok: true, text: "Сохранено" });
        setEdit(false);
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Не получилось" });
      }
    });
  };

  const отменить = () => {
    setLa(lat ?? "");
    setLn(lng ?? "");
    setAddress(address ?? "", addressSource ? "map" : "human");
    setSuggestion(null);
    setGeoNote(null);
    setMsg(null);
    setEdit(false);
  };

  if (edit) {
    return (
      <div className="form loc-form">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label style={{ flex: "1 1 150px" }}>
            <span>Широта</span>
            <input value={la} onChange={(e) => setLa(e.target.value)} placeholder="41.311081" inputMode="decimal" />
          </label>
          <label style={{ flex: "1 1 150px" }}>
            <span>Долгота</span>
            <input value={ln} onChange={(e) => setLn(e.target.value)} placeholder="69.240562" inputMode="decimal" />
          </label>
        </div>
        <label>
          <span>Адрес</span>
          <input
            value={addr}
            onChange={(e) => setAddress(e.target.value, "human")}
            placeholder="Ташкент, ул. Олмачи, 2 этаж"
          />
          {addrFrom === "map" && addr.trim() !== "" && (
            <small className="hint">Адрес подставлен по карте — проверьте и поправьте, если нужно.</small>
          )}
        </label>
        {suggestion && (
          <p className="hint">
            По карте: {suggestion}{" "}
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setAddress(suggestion, "map");
                setSuggestion(null);
              }}
            >
              подставить
            </button>
          </p>
        )}
        {geoNote && <p className="hint">{geoNote}</p>}
        <MapPicker lat={la} lng={ln} onChange={onPick} {...(tiles ? { tiles } : {})} />
        <div className="form-actions">
          <button type="button" className="btn pri" onClick={save} disabled={pending}>
            {pending ? "Сохраняю…" : "Сохранить"}
          </button>
          <button type="button" className="btn ghost" onClick={отменить} disabled={pending}>
            Отмена
          </button>
          {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mc-tiles">
        <div
          className={`mct${address === null ? " mct-empty" : ""}`}
          onClick={() => setEdit(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && setEdit(true)}
        >
          <span className="lb">Адрес</span>
          <b className="vl">{address ?? "＋ указать"}</b>
          {address !== null && addressSource && <small className="hint">{addressSource}</small>}
          <span className="act">✎</span>
        </div>
        <div
          className={`mct${естьТочка ? "" : " mct-empty"}`}
          onClick={() => setEdit(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && setEdit(true)}
        >
          <span className="lb">Координаты</span>
          <b className="vl mono">{естьТочка ? `${lat}, ${lng}` : "＋ отметить на карте"}</b>
          {естьТочка && coordsSource && <small className="hint">{coordsSource}</small>}
          <span className="act">✎</span>
        </div>
        {mapHref && (
          <a className="mct mct-link" href={mapHref} target="_blank" rel="noreferrer">
            <span className="lb">На карте</span>
            <b className="vl">открыть</b>
            <span className="act">↗</span>
          </a>
        )}
      </div>
      {msg && (
        <p className={msg.ok ? "ok-text" : "err-text"} style={{ marginTop: 8 }}>
          {msg.text}
        </p>
      )}
    </>
  );
}
