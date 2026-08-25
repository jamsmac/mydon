import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type VendingShrinkageItem,
  type VendingShrinkageMachine,
  type VendingShrinkageReport,
} from "../lib/core";
import { CoreDown } from "./core-down";
import { money, plural } from "../lib/format";

/** Окна расчёта, между которыми переключается лист. Ядро зажимает своё. */
export const SHRINKAGE_WINDOWS = [7, 14, 30] as const;
/** Окно секции на вкладке «Снек»: подпись и запрос обязаны быть одним числом. */
export const SHRINKAGE_PANEL_DAYS = 14;

const n = (v: number): string => v.toLocaleString("ru-RU");
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

const адресЛиста = (domain: string): string =>
  `/domain/${domain}?tab=${encodeURIComponent("reports:shrinkage")}`;

/** Подпись позиции: излишек виден, но в деньги не входит (R-P4-3). */
function строкаПозиции(i: VendingShrinkageItem): string {
  const части = [`потеря ${n(i.lossUnits)} шт`];
  if (i.surplusUnits > 0) части.push(`излишек ${n(i.surplusUnits)} шт`);
  части.push(`дней ${n(i.daysCounted)}`);
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
  const естьПотери = report.machines.some((m) => m.summary.items.length > 0);
  const всего = report.machines.reduce((a, m) => a + m.summary.lossValue, 0);
  // Ядро складывает предупреждения по автоматам, и одна общая причина
  // приходит столько раз, сколько автоматов её задело.
  const предупреждения = [...new Set(report.warnings.map((w) => w.message))];

  return (
    <>
      <p className="lead">
        {`Период ${дата(report.from)} — ${дата(report.to)} · порог ${money(report.threshold)} на позицию`}
        {естьПотери ? ` · всего ≈ ${money(всего)}` : ""}
      </p>

      {/* «Потерь нет» говорим ТОЛЬКО когда отчёт полный. При живых
          предупреждениях это было бы обещание, которого расчёт не давал:
          часть дней в него не вошла. */}
      {!естьПотери && предупреждения.length === 0 && (
        <div className="empty">
          <b>Потерь за период нет</b>
          Остатки сошлись с продажами во все дни без заливок.
        </div>
      )}
      {!естьПотери && предупреждения.length > 0 && (
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
            {m.name} · дней посчитано {n(m.summary.daysCounted)}, пропущено {n(m.summary.daysSkipped)}
          </div>

          {m.summary.items.length === 0 ? (
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
                    <span className="pill">{i.noPrice ? `${n(i.lossUnits)} шт` : `≈ ${money(i.lossValue)}`}</span>
                  </div>
                ))}
              </div>
              <p className="muted">{`Итого ≈ ${money(m.summary.lossValue)}`}</p>
            </>
          )}

          {m.refillDays.length > 0 && (
            <>
              <p className="hint">Заливки по снимкам — эти дни в усушку не входят</p>
              <div className="rows">
                {m.refillDays.map((d) => (
                  <div className="row" key={d.date}>
                    <div className="t">
                      <b>{`${день(d.date)} · +${n(d.detectedUnits)} ед`}</b>
                    </div>
                    {/* «записано 0» приглушено намеренно: это не тревога, а
                        обычное дело — заливку поймал детектор, человек до бота
                        не дошёл. Красным это было бы криком на каждый выезд. */}
                    <span className={d.recordedUnits === 0 ? "pill muted" : "pill"}>
                      {`записано ${n(d.recordedUnits)}`}
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

/**
 * Секция «Усушка» на вкладке «Снек»: только то, что перешагнуло порог.
 *
 * Весь отчёт сюда не тащим — вкладка про пополнение, а не про разбор потерь;
 * за подробностями ведёт ссылка на лист.
 */
export function ShrinkageAlerts({ report, domain }: { report: VendingShrinkageReport; domain: string }) {
  const top = topShrinkAlerts(report);
  return (
    <>
      <div className="section-title">
        {`Усушка за ${SHRINKAGE_PANEL_DAYS} ${plural(SHRINKAGE_PANEL_DAYS, "день", "дня", "дней")}`}
      </div>
      {top.length === 0 ? (
        // Молчать нельзя: пропавшая секция означала бы «не считали», а мы
        // считали — и порог никто не перешагнул.
        <p className="muted">Порог не превышен</p>
      ) : (
        <div className="rows">
          {top.map(({ machine, item }) => (
            <div className="row" key={`${machine.serial}:${item.product}`}>
              <div className="t">
                <small>{`${machine.name} · ${item.product} −${n(item.lossUnits)} шт ≈ ${money(item.lossValue)}`}</small>
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
