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

/** Вердикт одной половины паритета: что написать на пилюле и красить ли её. */
interface ПоловинаПаритета {
  текст: string;
  bad: boolean;
}

/**
 * Паритет — ДВЕ независимые сверки под одним объектом: продажи (own ↔ stock) и
 * остатки. Общий `parity.ok` — И то, И другое (флаг переключения источника
 * учёта один, значит и разрешение одно), и печатать его на ПРОДАЖНОЙ пилюле
 * нельзя: на первом боевом прогоне снимков остатков в окне не было вовсе,
 * `ok` стал `false` при нуле расхождений продаж — панель сказала бы
 * «❌ 0 расхождений», строку, противоречащую самой себе
 * (`adversarial-prod-data.md` §3).
 *
 * Складское «сверять нечем» — НЕЙТРАЛЬНО, а не красно: красный зовёт чинить
 * расхождение, которого нет. Чинить надо сбор остатков, и ровно это говорит
 * примечание в той же строке.
 *
 * Обе половины читаются по СВОИМ счётчикам сравненных пар — `checked` для
 * продаж, `stockChecked` для остатков (контракт `OurvendHealth`, оба поля
 * обязательные), а НЕ по общему `ok` и НЕ разбором текста `note`: ноль пар —
 * не «сошлось» и не «разошлось», а «не считали», и это ортогонально другой
 * половине. Та же логика, что у бота (`паритетСтрока`,
 * `apps/bot/src/analytics-brief.ts`), чтобы обе витрины на одном payload
 * печатали один и тот же вердикт по обеим половинам.
 */
function разборПаритета(p: OurvendHealth["parity"]): { продажи: ПоловинаПаритета; остатки: ПоловинаПаритета } {
  const продажи: ПоловинаПаритета =
    p.checked === 0
      ? { текст: "продажи: сверять нечего", bad: false }
      : p.mismatches > 0
        ? {
            текст: `${count(p.mismatches)} ${plural(p.mismatches, "расхождение", "расхождения", "расхождений")}`,
            bad: true,
          }
        : { текст: "продажи сходятся", bad: false };
  const остатки: ПоловинаПаритета =
    p.stockChecked === 0
      ? { текст: "остатки: снимков за период нет", bad: false }
      : p.stockOk
        ? { текст: "остатки сходятся", bad: false }
        : { текст: "остатки расходятся", bad: true };
  return { продажи, остатки };
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
  // ПУСТОЙ ЖУРНАЛ — ТРЕТЬЕ СОСТОЯНИЕ, а не «здоров». `failedStreak` равен нулю
  // просто потому, что сбор ни разу не запускался, и зелёное «сбоев подряд
  // нет» здесь — те самые «нули как всё хорошо» (§7 спеки). Бот различает
  // ❓/❌/✅ (`состояниеСбора` в analytics-brief.ts) — панель обязана тоже.
  const прогоновНет = health.runs.length === 0;
  // Застой самого коллектора (R-P8a-6) — сигнал, независимый от свежести
  // снимков выше: `staleHours === null` значит «успешных прогонов не было ни
  // разу» вовсе, тревожнее любого числа часов. Порог — из ответа Core
  // (`staleThresholdH`, настройка `SYNC_STALE_HOURS`), своей шестёрки здесь
  // нет: сравни с `HEALTH_LAG_HOURS` выше — тот порог про снимки, не про сбор.
  const застой = health.staleHours === null || health.staleHours >= health.staleThresholdH;
  const тревога =
    !прогоновНет &&
    (health.failedStreak >= HEALTH_FAILED_STREAK ||
      стар(слотыЧ) ||
      стар(health.salesLagH) ||
      стар(health.productSaleLagH) ||
      застой);

  const успех =
    health.lastSuccessAt === null
      ? "успешных прогонов не было"
      : `последний успех ${when(health.lastSuccessAt)}`;
  const прогонов = прогоновНет
    ? "журнал прогонов пуст"
    : `${count(health.runs.length)} ${plural(health.runs.length, "прогон", "прогона", "прогонов")} в журнале`;
  const паритет = разборПаритета(health.parity);
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
        {/* Пустой журнал — не тревога и не «всё хорошо»: чип нейтральный,
            ровно как ❓ у бота. Красным здесь пугать не за что. */}
        {прогоновНет && (
          <span className="pill" style={{ marginLeft: 8 }}>
            не оценить
          </span>
        )}
      </div>
      <p className="hint">Сбор OurVend: прогоны, свежесть снимков и паритет с учётной дорожкой.</p>
      <div className="rows">
        {/* Пустой журнал остаётся нейтральным «не оценить» (см. `тревога`
            выше): красную пилюлю застоя показываем только когда есть журнал,
            по которому можно судить. */}
        {!прогоновНет && застой && (
          <div className="row">
            <div className="t">
              <b>Сбор данных</b>
            </div>
            <span className="pill bad">
              {health.staleHours === null ? "успехов не было" : `сбор стоит ${count(health.staleHours)} ч`}
            </span>
          </div>
        )}

        <div className="row">
          <div className="t">
            <b>Прогоны сбора</b>
            <small>{`${прогонов} · ${успех}`}</small>
          </div>
          <span className={`pill ${health.failedStreak >= HEALTH_FAILED_STREAK ? "bad" : ""}`}>
            {прогоновНет
              ? "прогонов нет — не оценить"
              : health.failedStreak > 0
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
            {/* Имя таблицы владельцу ничего не говорит: он читает отчёт с
                телефона, а не схему БД (адверсариал UX #5). */}
            <b>Снимки продаж по товарам (кабинет)</b>
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
          <span className={`pill ${паритет.продажи.bad ? "bad" : ""}`}>{паритет.продажи.текст}</span>
          <span className={`pill ${паритет.остатки.bad ? "bad" : ""}`}>{паритет.остатки.текст}</span>
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
