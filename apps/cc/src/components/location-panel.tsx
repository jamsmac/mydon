"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import {
  DEFAULT_MACHINE_STATUS,
  MACHINE_STATUSES,
  PLACE_TYPES,
  MACHINE_STATUS_LABELS,
  isMachineStatus,
  machineIsOperational,
  placeStatusConflict,
  placeTypeLabel,
  STATUS_FOR_PLACE_TYPE,
  isPlaceType,
  type MachineStatus,
} from "@mydon/shared";
import { saveLocation, setMachineStatus } from "../app/card/actions";
import type { MapTiles } from "../lib/map-tiles";

// Карта тянет leaflet — грузим только когда владелец её открыл.
const MapPicker = dynamic(() => import("./map-picker").then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <p className="hint">Карта загружается…</p>,
});

export interface LocationPeriod {
  id: string;
  /** Карточка места — ею форма «Где стоит» подставляет текущее место. */
  locationId: string;
  locationName: string;
  startDate: string | null;
  endDate: string | null;
  note: string | null;
}

/** Место, куда автомат можно поставить: точка продаж, склад, мастерская. */
export interface PlaceOption {
  id: string;
  name: string;
  type: string;
}

/**
 * Локация автомата: ГДЕ СТОИТ — одной формой, плюс координаты, адрес и история.
 *
 * ОДНА ЗАПИСЬ ВМЕСТО ЧЕТЫРЁХ (решение владельца 09.09.2026). До этого «где
 * стоит» вводилось в трёх разных экранах и ни один не был полным: место
 * записывалось ТОЛЬКО вместе со сменой состояния во вкладке «Обслуживание»
 * (а пилюля текущего состояния там отключена — значит переставить работающий
 * автомат с точки на точку было нельзя в принципе), отдельно существовала
 * привязка в «Кофе → Настройки», и отдельно — текстовое поле «точка» в
 * паспорте. Отсюда и «локация не записана» у аппарата, у которого всё
 * остальное заполнено верно: состояние закрывало период, а нового никто не
 * открывал.
 *
 * Теперь место и состояние — одна форма и одно сохранение: они и в данных
 * одна транзакция Core (`setMachineStatus` закрывает старый период, открывает
 * новый, пересчитывает сроки ТО и отменяет задачи). Состояние подставляется
 * по виду места (`STATUS_FOR_PLACE_TYPE`), но остаётся явным полем: «в
 * ремонте» бывает и на точке продаж.
 */
export function LocationPanel({
  machineId,
  periods,
  places,
  status,
  statusNote,
  lat,
  lng,
  address,
  sourceStays,
  sourceMoves,
  tiles,
}: {
  machineId: string;
  periods: LocationPeriod[];
  /** Куда автомат можно поставить. Пусто — выбор скрыт (направление не задано). */
  places: PlaceOption[];
  status: string | null;
  statusNote: string | null;
  lat: string | null;
  lng: string | null;
  address: string | null;
  /** История стоянок, восстановленная из заказов источника (если она есть). */
  sourceStays?: ReactNode;
  sourceMoves?: number;
  /** Подложка карты с сервера (MAP_TILES_URL); без пропа — бесключевой OSM. */
  tiles?: MapTiles;
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

  // ── Форма «Где стоит»: место + состояние + причина, одно сохранение ──
  const состояние = isMachineStatus(status) ? status : DEFAULT_MACHINE_STATUS;
  const [placeId, setPlaceId] = useState(текущая?.locationId ?? "");
  const [st, setSt] = useState<MachineStatus>(состояние);
  const [note, setNote] = useState(statusNote ?? "");
  const [placeMsg, setPlaceMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const выбранное = places.find((p) => p.id === placeId) ?? null;
  /**
   * Подсказка состояния по виду места. Владелец назвал место — состояние
   * очевидно; переопределить его он всё равно может (сломанный автомат,
   * который ещё стоит на точке).
   */
  const выбратьМесто = (id: string) => {
    setPlaceId(id);
    setPlaceMsg(null);
    const место = places.find((p) => p.id === id);
    if (место && isPlaceType(место.type)) setSt(STATUS_FOR_PLACE_TYPE[место.type]);
  };

  const безИзменений =
    placeId === (текущая?.locationId ?? "") && st === состояние && note.trim() === (statusNote ?? "").trim();

  const поставить = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPlaceMsg(null);
    // «В эксплуатации» без места — то самое «локация не записана»: автомат
    // числится торгующим, а где — неизвестно. Склад и ремонт без места
    // допустимы: увезли, а куда именно — бывает, что ещё не знают.
    if (st === "in_service" && выбранное === null) {
      setPlaceMsg({ ok: false, text: "Для «в эксплуатации» нужно выбрать точку продаж — торговать нигде автомат не может" });
      return;
    }
    // Правило то же, что в Core (`placeStatusConflict`): владелец видит отказ
    // сразу, а не после круга к серверу.
    const конфликт = выбранное ? placeStatusConflict(st, выбранное.type, выбранное.name) : null;
    if (конфликт) {
      setPlaceMsg({ ok: false, text: конфликт });
      return;
    }
    start(async () => {
      const res = await setMachineStatus(machineId, st, note.trim() || undefined, placeId || undefined);
      if (res.ok) {
        setPlaceMsg({
          ok: true,
          text: выбранное
            ? `${выбранное.name} · ${MACHINE_STATUS_LABELS[st].toLowerCase()}`
            : `Состояние: ${MACHINE_STATUS_LABELS[st].toLowerCase()}`,
        });
        router.refresh();
      } else {
        // Поля сохраняют ввод: отказ Core не должен стирать выбор владельца.
        setPlaceMsg({ ok: false, text: res.error ?? "Не сохранилось" });
      }
    });
  };

  /** Что произойдёт помимо записи места — говорим до нажатия, а не после. */
  const последствие =
    st === состояние
      ? null
      : machineIsOperational(st)
        ? "Автомат вернётся в строй: сроки нормативов пересчитаются от сегодня."
        : "Автомат уйдёт из эксплуатации: открытые задачи по обслуживанию отменятся, а долг по срокам останется виден в «Обслуживании».";

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
      <div className="sect" id="where">
        <div className="sect-h">
          <h3 className="h2">Где стоит</h3>
          <span className={`chip ${machineIsOperational(status) ? "" : "h"}`}>
            {MACHINE_STATUS_LABELS[состояние]}
          </span>
          <span className="sp" />
        </div>

        {places.length === 0 ? (
          <div className="empty">
            <b>Мест ещё нет</b>
            Заведите точку продаж, склад или мастерскую в разделе «Места» — тогда автомат будет
            куда поставить.
          </div>
        ) : (
          <form className="form" onSubmit={поставить}>
            <p className="hint">
              Место и состояние записываются вместе, одним сохранением: «стоит на точке продаж» и
              «в ремонте» разом не бывает. Вид места подставляет состояние — если случай другой
              (сломан, но ещё стоит на точке), поменяйте его руками.
            </p>

            <label>
              Место
              <select
                value={placeId}
                onChange={(e) => выбратьМесто(e.target.value)}
                disabled={pending}
              >
                <option value="">— место не записано —</option>
                {PLACE_TYPES.map((t) => {
                  const список = places.filter((pl) => pl.type === t);
                  if (список.length === 0) return null;
                  return (
                    <optgroup key={t} label={placeTypeLabel(t)}>
                      {список.map((pl) => (
                        <option key={pl.id} value={pl.id}>
                          {pl.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </label>

            <p className="eyebrow" style={{ marginTop: 4 }}>
              Состояние
            </p>
            <div className="chips">
              {MACHINE_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip ${st === s ? "active" : ""}`}
                  onClick={() => {
                    setSt(s);
                    setPlaceMsg(null);
                  }}
                  disabled={pending}
                >
                  {MACHINE_STATUS_LABELS[s]}
                </button>
              ))}
            </div>

            <label>
              Причина / примечание
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="заявка №12, ждём плату"
                disabled={pending}
              />
            </label>

            {последствие && <p className="hint">{последствие}</p>}

            <div className="form-actions">
              <button type="submit" className="btn pri" disabled={pending || безИзменений}>
                {pending ? "Сохраняю…" : "Сохранить"}
              </button>
              {placeMsg && (
                <span className={placeMsg.ok ? "ok-text" : "err-text"}>{placeMsg.text}</span>
              )}
            </div>
          </form>
        )}
      </div>

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
            <MapPicker lat={la} lng={ln} onChange={(a, b) => { setLa(a); setLn(b); }} {...(tiles ? { tiles } : {})} />
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
              Неизвестно, где этот аппарат. Поставьте его на место формой «Где стоит» выше —
              тогда он появится на карте, в «Местах» и в отчётах по локации.
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
