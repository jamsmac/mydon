"use client";

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
import { setMachineStatus } from "../app/card/actions";

export interface LocationPeriod {
  id: string;
  /** Карточка места — ею форма «Где стоит» подставляет текущее место. */
  locationId: string;
  locationName: string;
  startDate: string | null;
  endDate: string | null;
  note: string | null;
}

/**
 * Координаты и адрес ТЕКУЩЕГО МЕСТА автомата (М-4). Координата принадлежит
 * месту: автомат переезжает, место стоит на земле. Поэтому здесь они только
 * показываются, а правятся в карточке места — один вход в одни данные.
 */
export interface CurrentPlaceGeo {
  placeId: string;
  lat: string | null;
  lng: string | null;
  address: string | null;
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
  placeGeo,
  sourceStays,
  sourceMoves,
}: {
  machineId: string;
  periods: LocationPeriod[];
  /** Куда автомат можно поставить. Пусто — выбор скрыт (направление не задано). */
  places: PlaceOption[];
  status: string | null;
  statusNote: string | null;
  /** Координаты текущего места; `null` — автомат нигде не стоит. */
  placeGeo: CurrentPlaceGeo | null;
  /** История стоянок, восстановленная из заказов источника (если она есть). */
  sourceStays?: ReactNode;
  sourceMoves?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const текущая = periods.find((p) => p.endDate === null) ?? null;
  const lat = placeGeo?.lat ?? null;
  const lng = placeGeo?.lng ?? null;
  const address = placeGeo?.address ?? null;
  const естьТочка = lat !== null && lng !== null;
  const mapHref = естьТочка ? `https://maps.google.com/?q=${lat},${lng}` : null;
  /** Координаты и адрес правятся в карточке места — туда и ведут плитки. */
  const placeHref = placeGeo ? `/card/${placeGeo.placeId}#geo` : null;

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
          {placeHref && (
            <Link href={placeHref} className="btn ghost">
              ✎ Координаты места
            </Link>
          )}
        </div>

        <div className="mc-tiles">
          <div className={`mct mct-wide${текущая === null ? " mct-empty" : ""}`}>
            <span className="lb">Стоит сейчас</span>
            <b className="vl">
              {текущая && placeGeo ? <Link href={`/card/${placeGeo.placeId}`}>{текущая.locationName}</Link> : "локация не записана"}
            </b>
          </div>
          <div className={`mct${address === null ? " mct-empty" : ""}`}>
            <span className="lb">Адрес места</span>
            <b className="vl">{address ?? (placeGeo ? "не указан — в карточке места" : "—")}</b>
          </div>
          <div className={`mct${естьТочка ? "" : " mct-empty"}`}>
            <span className="lb">Координаты места</span>
            <b className="vl mono">{естьТочка ? `${lat}, ${lng}` : placeGeo ? "не отмечены — в карточке места" : "—"}</b>
          </div>
          {mapHref && (
            <a className="mct mct-link" href={mapHref} target="_blank" rel="noreferrer">
              <span className="lb">На карте</span>
              <b className="vl">открыть</b>
              <span className="act">↗</span>
            </a>
          )}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Координаты и адрес принадлежат месту, а не автомату: при переезде их не нужно вводить заново.
        </p>
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
