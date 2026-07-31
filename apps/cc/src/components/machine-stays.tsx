import Link from "next/link";
import type { MachineStays } from "../lib/core";

/** Дата без времени: в истории переездов секунды не нужны. */
function day(v: string): string {
  const d = v.slice(0, 10).split("-");
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : v;
}

/**
 * Лента стоянок одного автомата.
 *
 * Точка — не поле карточки, а период: переставили автомат, начался новый
 * отрезок. История восстановлена из заказов, поэтому охватывает весь период
 * выгрузки, а не только то, что кто-то не забыл записать.
 */
export function StayTimeline({ stays }: { stays: MachineStays["stays"] }) {
  if (stays.length === 0) {
    return (
      <div className="empty">
        <b>Где стоял — пока неизвестно</b>
        История появится, когда будет загружена выгрузка заказов с адресами.
      </div>
    );
  }
  const last = stays.length - 1;
  return (
    <div className="stays">
      {stays.map((s, i) => (
        <div className={`stay ${s.overlaps ? "bad" : ""} ${i === last ? "now" : ""}`} key={`${s.point}-${s.from}`}>
          <div className="stayp">
            {s.point}
            {i === last && <span className="chip g">сейчас</span>}
            {s.overlaps && <span className="chip h">пересечение</span>}
          </div>
          <div className="stayd mono">
            {day(s.from)} — {i === last ? "по сей день" : day(s.to)}
          </div>
          <div className="stayn mono">{s.orders.toLocaleString("ru-RU")} заказов</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Сквозной срез: все автоматы и их переезды.
 *
 * Сверху те, кто переезжал чаще — там и вопросов больше: где стоял, сколько
 * там наторговал, и не путает ли источник адреса.
 */
export function MachineStaysView({ machines }: { machines: MachineStays[] }) {
  if (machines.length === 0) {
    return (
      <div className="empty">
        <b>Истории переездов пока нет</b>
        Для неё нужна выгрузка, где у заказа есть и автомат, и адрес, и время.
      </div>
    );
  }

  const moved = machines.filter((m) => m.moves > 0).length;
  const messy = machines.filter((m) => m.stays.some((s) => s.overlaps)).length;

  return (
    <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile mini">
          <div className="lab">Автоматов в истории</div>
          <div className="v">{machines.length}</div>
          <div className="foot"><span className="mk" />по заказам источника</div>
        </div>
        <div className={`tile mini ${moved === 0 ? "zero" : ""}`}>
          <div className="lab">Переезжали</div>
          <div className="v">{moved}</div>
          <div className="foot"><span className="mk" />меняли точку хотя бы раз</div>
        </div>
        <div className={`tile mini ${messy > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Адреса путаются</div>
          <div className="v">{messy}</div>
          <div className="foot">
            <span className="mk" />
            {messy > 0 ? "периоды пересекаются — не переезд" : "все переезды чистые"}
          </div>
        </div>
      </div>

      <p className="hint" style={{ marginBottom: 12 }}>
        История восстановлена из заказов: в каждом есть автомат, адрес и время.
        Журнала переездов никто не вёл — факт всё равно записан. Пересечение
        периодов переездом не считается: это путаница в источнике.
      </p>

      {machines.map((m) => (
        <div className="sect" key={m.serial} style={{ marginTop: 18 }}>
          <div className="sect-h">
            <h3 className="h2">
              {m.entityId ? (
                <Link href={`/card/${m.entityId}`} style={{ color: "var(--accent)" }}>
                  {m.entityName}
                </Link>
              ) : (
                m.serial
              )}
            </h3>
            <span className="chip mono">{m.serial}</span>
            {m.moves > 0 ? (
              <span className="chip b">переездов: {m.moves}</span>
            ) : (
              <span className="chip">не переезжал</span>
            )}
            {m.entityId === null && <span className="chip h">нет карточки</span>}
          </div>
          <StayTimeline stays={m.stays} />
        </div>
      ))}
    </>
  );
}
