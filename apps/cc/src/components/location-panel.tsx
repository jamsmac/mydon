"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { saveLocation } from "../app/card/actions";

// Карта тянет leaflet — грузим только когда владелец её открыл.
const MapPicker = dynamic(() => import("./map-picker").then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <p className="hint">Карта загружается…</p>,
});

export interface LocationPeriod {
  id: string;
  locationName: string;
  startDate: string | null;
  endDate: string | null;
  note: string | null;
}

/**
 * Локация автомата: где стоит, координаты и адрес — плитками, как всё
 * остальное в карточке. Координаты правятся здесь же: руками или кликом по
 * карте. Периоды размещения читаются ниже — их ведёт перестановка аппарата,
 * а не эта форма: место меняется во вкладке «Обслуживание», иначе история
 * стоянок разошлась бы с состоянием.
 */
export function LocationPanel({
  machineId,
  periods,
  lat,
  lng,
  address,
  sourceStays,
  sourceMoves,
}: {
  machineId: string;
  periods: LocationPeriod[];
  lat: string | null;
  lng: string | null;
  address: string | null;
  /** История стоянок, восстановленная из заказов источника (если она есть). */
  sourceStays?: ReactNode;
  sourceMoves?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [la, setLa] = useState(lat ?? "");
  const [ln, setLn] = useState(lng ?? "");
  const [addr, setAddr] = useState(address ?? "");

  const текущая = periods.find((p) => p.endDate === null) ?? null;
  const естьТочка = lat !== null && lng !== null;
  const mapHref = естьТочка ? `https://maps.google.com/?q=${lat},${lng}` : null;

  const save = () => {
    setMsg(null);
    start(async () => {
      const res = await saveLocation(machineId, { lat: la, lng: ln, address: addr });
      if (res.ok) {
        setMsg({ ok: true, text: "Локация сохранена" });
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
    setAddr(address ?? "");
    setMsg(null);
    setEdit(false);
  };

  return (
    <>
      <div className="sect" id="location">
        <div className="sect-h">
          <h3 className="h2">Локация</h3>
          {периодовChip(periods.length)}
          <span className="sp" />
          {!edit && (
            <button type="button" className="btn ghost" onClick={() => setEdit(true)}>
              ✎ Координаты и адрес
            </button>
          )}
        </div>

        {edit ? (
          <div className="form loc-form">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label style={{ flex: "1 1 150px" }}>
                <span>Широта</span>
                <input
                  value={la}
                  onChange={(e) => setLa(e.target.value)}
                  placeholder="41.311081"
                  inputMode="decimal"
                />
              </label>
              <label style={{ flex: "1 1 150px" }}>
                <span>Долгота</span>
                <input
                  value={ln}
                  onChange={(e) => setLn(e.target.value)}
                  placeholder="69.240562"
                  inputMode="decimal"
                />
              </label>
            </div>
            <label>
              <span>Адрес</span>
              <input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="Ташкент, ул. Олмачи, 2 этаж"
              />
            </label>
            <MapPicker lat={la} lng={ln} onChange={(a, b) => { setLa(a); setLn(b); }} />
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
        ) : (
          <>
            <div className="mc-tiles">
              <div className={`mct mct-wide${текущая === null ? " mct-empty" : ""}`}>
                <span className="lb">Стоит сейчас</span>
                <b className="vl">{текущая?.locationName ?? "локация не записана"}</b>
              </div>
              <div
                className={`mct${address === null ? " mct-empty" : ""}`}
                onClick={() => setEdit(true)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setEdit(true)}
              >
                <span className="lb">Адрес</span>
                <b className="vl">{address ?? "＋ указать"}</b>
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
                <b className="vl mono">{естьТочка ? `${lat}, ${lng}` : "＋ отметить"}</b>
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
        )}
      </div>

      {/* История — свёрнута и БЕЗ нашего списка периодов: где стоит сейчас
          сказано плитками выше, и повтор той же строки читался как дубль.
          Здесь хронология из заказов источника: где стоял, с какой по какую
          дату и сколько заказов. Наш учёт периодов показываем только когда
          источник по этому аппарату молчит — иначе истории не было бы вовсе. */}
      <details className="sect loc-hist" id="periods">
        <summary>
          <span className="loc-hist-t">История</span>
          {typeof sourceMoves === "number" && sourceMoves > 0 ? (
            <span className="chip b">переездов: {sourceMoves}</span>
          ) : (
            <span className="chip">{periods.length}</span>
          )}
        </summary>

        <div className="loc-hist-body">
          {sourceStays ? (
            <>
              {sourceStays}
              <p className="hint" style={{ marginTop: 10 }}>
                Восстановлено из заказов источника: адрес и время есть в каждом заказе.
                Локация — период, а не одно значение: переставили аппарат — начался новый отрезок.
              </p>
            </>
          ) : periods.length === 0 ? (
            <div className="empty">
              <b>Локация не записана</b>
              Неизвестно, где этот аппарат. Поставьте его на место во вкладке «Обслуживание»
              (склад, мастерская или локация продаж) — тогда он появится на карте и в отчётах
              по локации.
            </div>
          ) : (
            <>
              <div className="rows">
                {periods.map((p) => (
                  <div className="row" key={p.id}>
                    <div className="t">
                      <b>{p.locationName}</b>
                      <small>
                        {p.startDate ?? "с неизвестной даты"} — {p.endDate ?? "сейчас"}
                        {p.note ? ` · ${p.note}` : ""}
                      </small>
                    </div>
                    <span className={`pill ${p.endDate === null ? "ok" : ""}`}>
                      {p.endDate === null ? "стоит сейчас" : "история"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                По заказам источника истории нет — показан наш учёт перестановок.
              </p>
            </>
          )}
        </div>
      </details>
    </>
  );
}

function периодовChip(n: number) {
  return n > 0 ? <span className="chip b">периодов: {n}</span> : null;
}

/** Ссылка на карточку места — если периодов нет, показывать нечего. */
export function LocationLink({ id, name }: { id: string; name: string }) {
  return <Link href={`/card/${id}`}>{name}</Link>;
}
