import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type VendingShrinkageItem,
  type VendingShrinkageMachine,
  type VendingShrinkageReport,
} from "../lib/core";
import { CoreDown } from "./core-down";
import { amount, count, plural } from "../lib/format";

/** Окна расчёта, между которыми переключается лист. Ядро зажимает своё. */
export const SHRINKAGE_WINDOWS = [7, 14, 30] as const;
/** Окно секции на вкладке «Снек»: подпись и запрос обязаны быть одним числом. */
export const SHRINKAGE_PANEL_DAYS = 14;

/** Дата периода целиком: отчёт живёт неделями, год в нём не лишний. */
const дата = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};
/** День заливки — коротко, как в боте: «18.08». */
const день = (iso: string): string => {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
};

/**
 * Длина периода в сутках включительно — та же формула, что в Core
 * (`dates.length` в `shrinkage.service.ts`) и в боте (`periodDays` в
 * `shrinkage-brief.ts`). `daysSkipped` для этого не годится: дни без снимков
 * на границах и дни без продаж уходят в `continue` до накопления
 * `daysSkipped`, поэтому при `daysCounted=0` из-за несобранных снимков
 * `daysSkipped` может остаться нулём — и карточка сказала бы «все 0 дн.».
 */
function периодДней(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

const адресЛиста = (domain: string): string =>
  `/domain/${domain}?tab=${encodeURIComponent("reports:shrinkage")}`;

/** Подпись позиции: излишек виден, но в деньги не входит (R-P4-3). */
function строкаПозиции(i: VendingShrinkageItem): string {
  const части = [`потеря ${count(i.lossUnits)} шт`];
  if (i.surplusUnits > 0) части.push(`излишек ${count(i.surplusUnits)} шт`);
  части.push(`дней ${count(i.daysCounted)}`);
  return части.join(" · ");
}

/**
 * Позиции за порогом по всему парку, дороже — выше.
 *
 * Считается по всем автоматам сразу: владельцу важно, ГДЕ течёт сильнее, а не
 * какой автомат в отчёте идёт первым.
 */
export function topShrinkAlerts(
  report: VendingShrinkageReport,
  limit = 5,
): { machine: VendingShrinkageMachine; item: VendingShrinkageItem }[] {
  return report.machines
    .flatMap((machine) => machine.summary.items.filter((i) => i.alert).map((item) => ({ machine, item })))
    .sort((a, b) => b.item.lossValue - a.item.lossValue)
    .slice(0, limit);
}

/**
 * Лист «Усушка» (П4, R-P4-3) — витрина готового отчёта, без единой формулы.
 *
 * Считает ядро по дням БЕЗ заливок: в день заливки приход и продажи гасятся
 * внутри трёхчасового окна снимков, и сходимость там ничего не значит.
 * Поэтому дни заливок показаны отдельным списком, а не строкой потерь: это
 * не потеря, это причина, по которой день из расчёта выкинут.
 */
export function ShrinkageTables({ report }: { report: VendingShrinkageReport }) {
  const нетАвтоматов = report.machines.length === 0;
  // «Потерь нет» — обещание, что все автоматы отчёта были посчитаны все дни
  // периода. Автомат, у которого daysCounted=0 (все дни ушли в заливку),
  // в этой сумме — «не считали», а не «ноль потерь»: молчание о нём было бы
  // тем же враньём, что и пустой отчёт при живом сборе.
  const всеПосчитаны = !нетАвтоматов && report.machines.every((m) => m.summary.daysCounted > 0);
  const естьПотери = report.machines.some((m) => m.summary.items.length > 0);
  const всего = report.machines.reduce((a, m) => a + m.summary.lossValue, 0);
  // Ядро складывает предупреждения по автоматам, и одна общая причина
  // приходит столько раз, сколько автоматов её задело.
  const предупреждения = [...new Set(report.warnings.map((w) => w.message))];
  const днейПериода = периодДней(report.from, report.to);

  return (
    <>
      <p className="lead">
        {`Период ${дата(report.from)} — ${дата(report.to)} · порог ${amount(report.threshold)} на позицию`}
        {естьПотери ? ` · всего ≈ ${amount(всего)}` : ""}
      </p>

      {/* Ноль автоматов в отчёте — это НЕ «потерь нет»: сбор мог лежать весь
          период, или все автоматы оказались не в строю. Молчание здесь
          читалось бы как «сошлось», хотя считать было не по чему. */}
      {нетАвтоматов && (
        <div className="empty">
          <b>Данных нет</b>
          Ни одного автомата в отчёте.
        </div>
      )}

      {/* «Потерь нет» говорим ТОЛЬКО когда отчёт полный: есть автоматы, у
          КАЖДОГО посчитан хотя бы один день. При живых предупреждениях или
          автомате с daysCounted=0 это было бы обещание, которого расчёт
          не давал: часть отчёта в него не вошла. */}
      {!нетАвтоматов && !естьПотери && всеПосчитаны && предупреждения.length === 0 && (
        <div className="empty">
          <b>Потерь за период нет</b>
          Остатки сошлись с продажами во все дни без заливок.
        </div>
      )}
      {!нетАвтоматов && !естьПотери && (!всеПосчитаны || предупреждения.length > 0) && (
        <div className="empty">
          <b>Потерь не насчитано</b>
          Но данные неполные — ниже сказано, какие дни и автоматы в расчёт не вошли.
        </div>
      )}

      {report.machines.map((m) => (
        <div className="sect" style={{ marginTop: 16 }} key={m.serial}>
          {/* Дни в заголовке — не украшение: «−9 шт» за 9 дней и за 2 дня
              означают разное, а пропущенные дни объясняют, почему сумма
              меньше ожидаемой. */}
          <div className="section-title">
            {`${m.name} · дней посчитано ${count(m.summary.daysCounted)}, не в счёт из-за заливки ${count(m.summary.daysSkipped)}`}
          </div>

          {m.summary.daysCounted === 0 ? (
            // Не «Расхождений нет» — это ноль дней, а не ноль потерь. Длина
            // периода, а не daysSkipped (см. периодДней выше) — тот же выбор,
            // что у Core (dates.length) и бота (periodDays).
            <p className="muted">{`Не считали — все ${count(днейПериода || m.summary.daysSkipped)} дн. периода были заливкой/пропущены`}</p>
          ) : m.summary.items.length === 0 ? (
            <p className="muted">Расхождений нет</p>
          ) : (
            <>
              <div className="rows">
                {m.summary.items.map((i) => (
                  <div className="row" key={i.product}>
                    <div className="t">
                      <b>{i.product}</b>
                      <small>{строкаПозиции(i)}</small>
                    </div>
                    {i.noPrice && <span className="pill bad">нет цены</span>}
                    {i.alert && <span className="pill bad">⚠️ порог</span>}
                    {/* Без цены показываем штуки: «0 сум» читалось бы как
                        «потеряли на ноль», хотя товар пропал. */}
                    <span className="pill">{i.noPrice ? `${count(i.lossUnits)} шт` : `≈ ${amount(i.lossValue)}`}</span>
                  </div>
                ))}
              </div>
              <p className="muted">{`Итого ≈ ${amount(m.summary.lossValue)}`}</p>
            </>
          )}

          {m.refillDays.length > 0 && (
            <>
              <p className="hint">Заливки по снимкам — эти дни в усушку не входят</p>
              <div className="rows">
                {m.refillDays.map((d) => (
                  <div className="row" key={d.date}>
                    <div className="t">
                      <b>{`${день(d.date)} · +${count(d.detectedUnits)} ед`}</b>
                    </div>
                    {/* «записано 0» приглушено намеренно: это не тревога, а
                        обычное дело — заливку поймал детектор, человек до бота
                        не дошёл. Красным это было бы криком на каждый выезд. */}
                    <span className={d.recordedUnits === 0 ? "pill muted" : "pill"}>
                      {`записано ${count(d.recordedUnits)}`}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ))}

      {предупреждения.length > 0 && (
        <>
          <div className="section-title">Почему данные неполные</div>
          <div className="rows">
            {предупреждения.map((сообщение) => (
              <div className="row" key={сообщение}>
                <div className="t">
                  <small>{`⚠️ ${сообщение}`}</small>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Заголовок секции — общий для «есть отчёт» и «Core не ответил» состояний. */
function заголовокСекции() {
  return (
    <div className="section-title">
      {`Усушка за ${SHRINKAGE_PANEL_DAYS} ${plural(SHRINKAGE_PANEL_DAYS, "день", "дня", "дней")}`}
    </div>
  );
}

/**
 * Секция «Усушка» на вкладке «Снек»: только то, что перешагнуло порог.
 *
 * Весь отчёт сюда не тащим — вкладка про пополнение, а не про разбор потерь;
 * за подробностями ведёт ссылка на лист.
 */
export function ShrinkageAlerts({ report, domain }: { report: VendingShrinkageReport; domain: string }) {
  const top = topShrinkAlerts(report);
  const нетАвтоматов = report.machines.length === 0;
  return (
    <>
      {заголовокСекции()}
      <p className="hint">Расхождение остатков с продажами, без дней заливки.</p>
      {нетАвтоматов ? (
        // Тот же принцип, что и на листе «Усушка»: ноль автоматов в отчёте —
        // это не «порог не превышен», а «считать было не по чему».
        <p className="muted">Данных нет — ни одного автомата в отчёте</p>
      ) : top.length === 0 ? (
        // Молчать нельзя: пропавшая секция означала бы «не считали», а мы
        // считали — и порог никто не перешагнул.
        <p className="muted">Порог не превышен</p>
      ) : (
        <div className="rows">
          {top.map(({ machine, item }) => (
            <div className="row" key={`${machine.serial}:${item.product}`}>
              <div className="t">
                <small>{`${machine.name} · ${item.product} −${count(item.lossUnits)} шт ≈ ${amount(item.lossValue)}`}</small>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="hint">
        <Link href={адресЛиста(domain)}>Усушка — весь отчёт</Link>
      </p>
    </>
  );
}

/**
 * Секция «Усушка» на вкладке «Снек» при сбое подзапроса к ядру.
 *
 * Вкладка «Снек» открывается по своему пакету запросов, а усушка тянется
 * отдельным (см. `vending-panel.tsx`) — сбой одной усушки не должен ронять
 * всю вкладку. Но молча убирать секцию тоже нельзя: пропавшая секция читалась
 * бы как «порог не превышен», хотя мы даже не спросили ядро.
 */
export function ShrinkageAlertsFailed() {
  return (
    <>
      {заголовокСекции()}
      <p className="muted">Усушка: не проверили (Core не ответил)</p>
    </>
  );
}

/**
 * Лист «Усушка»: один поход в ядро за готовым отчётом.
 *
 * Окно берётся из адреса (`?days=`) — 7/14/30. Провал ядра показываем тем же
 * экраном, что и остальные листы: нули при упавшем Core — ложь, на которую
 * можно положиться.
 */
export async function ShrinkageView({ domain, days }: { domain: string; days: number }) {
  let report: VendingShrinkageReport;
  try {
    report = await core.vendingShrinkage(days);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  return (
    <>
      <p className="hint">
        Окно расчёта:{" "}
        {SHRINKAGE_WINDOWS.map((d, idx) => (
          <span key={d}>
            {idx > 0 ? " · " : ""}
            {d === days ? (
              <b>{`${d} дн`}</b>
            ) : (
              <Link href={`${адресЛиста(domain)}&days=${d}`}>{`${d} дн`}</Link>
            )}
          </span>
        ))}
      </p>
      <ShrinkageTables report={report} />
    </>
  );
}
