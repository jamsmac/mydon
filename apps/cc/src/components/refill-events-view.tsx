import { core, CoreUnavailable, type VendingRefillEvent } from "../lib/core";
import { CoreDown } from "./core-down";
import { ReportWindow } from "./report-window";
import { count, plural, when } from "../lib/format";

/** Окна — ровно те, что сервер отдаёт целиком после поднятия `LIST_DAYS_MAX` (R-H-5). */
export const REFILL_EVENT_WINDOWS = [14, 30, 90] as const;

const TAB = "reports:refill_events";

/**
 * Подпись автомата. `list()` кладёт в `name` сам серийник, когда карточки нет
 * (`nameBySerial.get(канон) ?? r.machineSerial`), и владельцу надо сказать это
 * словами — ТЕМ ЖЕ текстом, что печатает маржа (`margin-view.tsx`): два отчёта
 * об одном факте обязаны говорить одно.
 */
function автомат(e: VendingRefillEvent): { title: string; hint: string | null } {
  return e.name === e.serial ? { title: e.serial, hint: "карточки автомата нет" } : { title: e.name, hint: e.serial };
}

/**
 * Источник факта. «Только снимки» — НЕ ошибка и не тревога: заливка ЕСТЬ факт
 * снимка (R-P4-2), а запись оператора — уточнение (`matched_refill_id`).
 * Красить её как проблему значило бы будить владельца о нормальном ходе дел.
 */
function источник(e: VendingRefillEvent): string {
  return e.matchedRefillId === null ? "только снимки" : "снимки + запись оператора";
}

export function RefillEventsTable({ rows }: { rows: VendingRefillEvent[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <b>Заливок за окно не найдено</b>
        {"Детектор смотрит снимки слотов каждые 3 часа и пишет событие при приходе от порога REFILL_DETECT_MIN_UNITS — пусто значит «не привозили», а не «не считали»."}
      </div>
    );
  }
  return (
    <div className="rows">
      {rows.map((e) => {
        const м = автомат(e);
        return (
          <div className="row" key={e.id}>
            <div className="t">
              <b>{м.title}</b>
              <small>
                {[м.hint, `${when(e.windowFrom)} — ${when(e.windowTo)}`].filter((v): v is string => v !== null).join(" · ")}
              </small>
              {/* Источник — своим текстовым узлом: панель различает «только снимки» и
                  «снимки + запись оператора» точным текстом, а не подстрокой строки с датой. */}
              <small>{источник(e)}</small>
              {e.slots.length === 0 ? (
                <small>слоты не записаны</small>
              ) : (
                e.slots.map((s) => (
                  <small key={s.coilId}>{`${s.coilId} · ${s.product} · +${count(s.delta)} (${count(s.before)} → ${count(s.after)})`}</small>
                ))
              )}
            </div>
            <span className="pill">{`${count(e.units)} ${plural(e.units, "единица", "единицы", "единиц")}`}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Лист «Журнал заливок»: один поход в ядро, окно — из адреса (`?days=`). */
export async function RefillEventsView({ domain, days }: { domain: string; days: number }) {
  let rows: VendingRefillEvent[];
  try {
    rows = await core.vendingRefillEvents(days);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  return (
    <>
      <ReportWindow domain={domain} tab={TAB} days={days} windows={REFILL_EVENT_WINDOWS} />
      <p className="lead">
        {`Журнал заливок · приход по снимкам за ${count(days)} дн. · ${count(rows.length)} ${plural(rows.length, "событие", "события", "событий")}`}
      </p>
      <RefillEventsTable rows={rows} />
    </>
  );
}
