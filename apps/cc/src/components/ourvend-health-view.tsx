import { core, type OurvendHealth } from "../lib/core";
import { count, plural, when } from "../lib/format";

/** Серия отказов, с которой сбор считается сломанным (правило `ourvend.sync_failed_streak`). */
export const HEALTH_FAILED_STREAK = 3;
/** Возраст снимка, после которого числа отчётов уже не про сегодня. */
export const HEALTH_LAG_HOURS = 6;
/** Сколько неудачных прогонов показываем: дальше это уже журнал, а не секция. */
const RUNS_SHOWN = 3;

/** Число с одним знаком после запятой: «10,7». */
const один = (v: number): string => v.toFixed(1).replace(".", ",");

/**
 * Пилюля свежести снимка. Молодой лаг — в минутах, взрослый — в часах: та же
 * шкала, что у бота (`лагМин` в analytics-brief.ts), чтобы «40 мин» в панели и
 * в «сверке» не превращались в «0,7 ч».
 *
 * `null` — снимков НЕТ вовсе, и это не «лаг ноль»: показывать «0 ч» значило бы
 * сказать «данные свежие» там, где данных нет ни одних.
 */
function LagPill({ hours, fine = false }: { hours: number | null; fine?: boolean }) {
  if (hours === null) return <span className="pill bad">снимков нет</span>;
  const текст = fine && hours * 60 < 90 ? `${один(hours * 60)} мин` : `${один(hours)} ч`;
  return <span className={`pill ${hours > HEALTH_LAG_HOURS ? "bad" : ""}`}>{текст}</span>;
}

/**
 * Секция «Здоровье сбора» (П5b, R-P5b-8) на вкладке «Снек».
 *
 * Живого запроса к OurVend отсюда нет и не будет: коннектор живёт в агентах по
 * крону, панель видит только его следы — прогоны, свежесть снимков и паритет с
 * учётной дорожкой. Смысл секции ровно один: 12 отказов подряд с 24.08 никто
 * не заметил, потому что смотреть было некуда.
 */
export function OurvendHealthCard({ health }: { health: OurvendHealth }) {
  const слотыЧ = health.slotsLagMin === null ? null : health.slotsLagMin / 60;
  // Отсутствие снимков (`null`) тревогой само по себе не считается: это уже
  // сказано красной пилюлей «снимков нет» в своей строке, и поднимать из-за
  // неё общий флаг на пустой базе (первый день сбора) значило бы кричать.
  const стар = (ч: number | null): boolean => ч !== null && ч > HEALTH_LAG_HOURS;
  const тревога =
    health.failedStreak >= HEALTH_FAILED_STREAK ||
    стар(слотыЧ) ||
    стар(health.salesLagH) ||
    стар(health.productSaleLagH);

  const успех =
    health.lastSuccessAt === null
      ? "успешных прогонов не было"
      : `последний успех ${when(health.lastSuccessAt)}`;
  const прогонов = `${count(health.runs.length)} ${plural(health.runs.length, "прогон", "прогона", "прогонов")} в журнале`;
  // Только упавшие и частичные: идущий прямо сейчас прогон (`running`) —
  // не отказ, а «ещё не знаем».
  const проблемные = health.runs
    .filter((r) => r.status === "failed" || r.status === "partial")
    .slice(0, RUNS_SHOWN);

  return (
    <>
      <div className="section-title">
        Здоровье сбора
        {тревога && (
          <span className="pill bad" style={{ marginLeft: 8 }}>
            тревога
          </span>
        )}
      </div>
      <p className="hint">Сбор OurVend: прогоны, свежесть снимков и паритет с учётной дорожкой.</p>
      <div className="rows">
        <div className="row">
          <div className="t">
            <b>Прогоны сбора</b>
            <small>{`${прогонов} · ${успех}`}</small>
          </div>
          <span className={`pill ${health.failedStreak >= HEALTH_FAILED_STREAK ? "bad" : ""}`}>
            {health.failedStreak > 0
              ? `${count(health.failedStreak)} ${plural(health.failedStreak, "отказ", "отказа", "отказов")} подряд`
              : "сбоев подряд нет"}
          </span>
        </div>

        <div className="row">
          <div className="t">
            <b>Снимки слотов</b>
            <small>остатки автоматов: планограмма, дефицит, усушка</small>
          </div>
          {/* `fine` — только у слотов: они снимаются каждые 3 часа, и «0,8 ч»
              вместо «48 мин» читалось бы хуже. Продажи меряются часами, как в
              боте (`лагЧ` в analytics-brief.ts). */}
          <LagPill hours={слотыЧ} fine />
        </div>

        <div className="row">
          <div className="t">
            <b>Снимки продаж</b>
            <small>деньги: маржа, цены, недельная сводка</small>
          </div>
          <LagPill hours={health.salesLagH} />
        </div>

        <div className="row">
          <div className="t">
            <b>Снимки витрины (product_sale)</b>
            {/* В деньги этот источник не идёт (скользящее окно 7 дней,
                суммирование по captured_at завышает ×36, R-P5b-1), но его
                возраст показывает, жив ли сбор целиком. */}
            <small>в деньги не идёт — окно 7 дней; показывает, жив ли сбор</small>
          </div>
          <LagPill hours={health.productSaleLagH} />
        </div>

        <div className="row">
          <div className="t">
            <b>Паритет со складским учётом</b>
            <small>
              {`продажи и остатки за ${count(health.parity.days)} дн.${health.parity.note ? ` · ${health.parity.note}` : ""}`}
            </small>
          </div>
          <span className={`pill ${health.parity.ok ? "" : "bad"}`}>
            {health.parity.ok ? "продажи сходятся" : `${count(health.parity.mismatches)} расхождений`}
          </span>
          <span className={`pill ${health.parity.stockOk ? "" : "bad"}`}>
            {health.parity.stockOk ? "остатки сходятся" : "остатки расходятся"}
          </span>
        </div>
      </div>

      {/* Последние отказы с текстом ошибки: «12 отказов подряд» без причины —
          это тревога без зацепки, а причина у прода одна и конкретная
          («аборт приёма слотов 10 с»). Тот же список показывает бот в
          «сверке». */}
      {проблемные.length > 0 && (
        <>
          <p className="hint">Последние отказы</p>
          <div className="rows">
            {проблемные.map((r) => (
              <div className="row" key={r.id}>
                <div className="t">
                  <small>{`${when(r.startedAt)} · автоматов ${count(r.machinesOk)}/${count(r.machinesTotal)} · ${r.error ?? "без текста ошибки"}`}</small>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Секция «Здоровье сбора» на вкладке «Снек»: свой запрос, свой отказ.
 *
 * Сбой не роняет вкладку и не убирает секцию: пропавшая секция читалась бы
 * как «со сбором всё в порядке», хотя ядро мы даже не дослушали — тот же
 * приём, что у `ShrinkageAlertsFailed`.
 */
export async function OurvendHealthSection() {
  const health = await core.ourvendHealth().catch(() => null);
  if (health === null) {
    return (
      <>
        <div className="section-title">Здоровье сбора</div>
        <p className="muted">Здоровье сбора: не проверили (Core не ответил)</p>
      </>
    );
  }
  return <OurvendHealthCard health={health} />;
}
