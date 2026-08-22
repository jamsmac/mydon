import Link from "next/link";
import type { NormFactPeriodRow, NormFactReport } from "../lib/core";
import { plural } from "../lib/format";
import { fmtDay } from "../lib/globerent";

/**
 * Подписи полноты периода бункера (срез F, задача 5; R-F2 + R-F3). `полнота`
 * — главная колонка листа, не техническая пометка: она объясняет, ПОЧЕМУ у
 * строки нет разницы, а не намекает на недостачу. Норма надёжна (сходится с
 * закупками по счетам на 95%, задача 1), факт занижен, потому что часть
 * заливок физически не записана в журнал (`bunker-period.ts`) — поэтому ни у
 * одной причины здесь нет цвета тревоги (правило 1 брифа этой задачи).
 *
 * Ровно два значения из `Coverage` (`@mydon/shared`) здесь НЕ перечислены —
 * «нет заливки» и «нет возврата». `NormFactService` строит
 * `тараОткалибрована` из калибровки тары (`fillNet`/`returnNet` не `null`), поэтому
 * этот конкретный эндпоинт их физически не выдаёт (ревью 1.4, см. комментарий
 * у `NormFactPeriodRow`) — держать в словаре подписи для состояний, которых
 * не бывает, значило бы намекать на проверку, которой здесь нет.
 *
 * «Рецепт неизвестен» — тоже не про недостачу: среди проданных чашек
 * попались такие, чей товар не опознан, чей состав не разобран, или чей
 * состав — не в граммах (ревью 1.1/1.2). Раньше такая чашка молча добавляла
 * к норме ноль и выглядела как перерасход — теперь период честно уходит сюда.
 */
const COVERAGE_LABEL: Record<NormFactPeriodRow["полнота"], string> = {
  "полный": "полный",
  "нет тары": "тара набора не откалибрована — нетто посчитать нельзя",
  "размещение неполно": "размещение автомата покрывает интервал не целиком — часть проданных чашек к этой точке не привязана, норма заведомо занижена",
  "тара не откалибрована": "тара не откалибрована — возврат тяжелее заливки, числа не сходятся",
  "позиция неоднозначна": "позиция неоднозначна — неизвестно, к какому ингредиенту относить",
  "рецепт неизвестен": "рецепт неизвестен — среди чашек есть неопознанный товар, неразобранный состав или состав не в граммах",
  "нормы нет": "нормы нет — за интервал не выдано ни одной подходящей чашки",
};

/** Порядок причин «вне итога» — от самой фундаментальной к самой частной, как в `bunkerPeriod()` (`@mydon/shared`). */
const COVERAGE_ORDER: readonly Exclude<NormFactPeriodRow["полнота"], "полный">[] = [
  "нет тары",
  "тара не откалибрована",
  "позиция неоднозначна",
  "размещение неполно",
  "рецепт неизвестен",
  "нормы нет",
];

/** Вес в граммах — голое число, без оценки (правило 1: никаких порогов и красного). */
function grams(n: number | null): string {
  if (n === null) return "—";
  return `${n.toLocaleString("ru-RU")} г`;
}

/** Разница со знаком — тоже просто число, не крашеное цветом. */
function diffGrams(n: number | null): string {
  if (n === null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("ru-RU")} г`;
}

/**
 * Лист «Норма и факт» (срез F, задача 5): периоды бункера «заливка → возврат»
 * против нормы состава проданных чашек. Три секции по образцу
 * `cash-reconcile.tsx` (итог из ядра сверху, разбивка неполноты отдельным
 * блоком, затем построчный список) — та же дисциплина, что и в срезе К:
 * правило «что считать сходимостью» уже решено в ядре (`bunkerPeriod()`,
 * `NormFactService`), здесь только витрина.
 */
export function NormFactBook({
  report,
  hrefBase,
  tab,
  from,
  to,
  defaultFrom,
  defaultTo,
  isDefaultPeriod,
  q,
}: {
  /** null — ядро не ответило на /coffee/norm-fact. НЕ «периодов нет». */
  report: NormFactReport | null;
  hrefBase: string;
  tab: string;
  from: string;
  to: string;
  defaultFrom: string;
  defaultTo: string;
  /** false — период задан вручную через форму: пустой список тогда значит «в
   *  этом окне пусто», а не «данных нет вовсе». */
  isDefaultPeriod: boolean;
  q: string;
}) {
  const periodHref = (nextFrom: string, nextTo: string, nextQ: string) => {
    const params = new URLSearchParams({ tab, from: nextFrom, to: nextTo });
    if (nextQ) params.set("q", nextQ);
    return `${hrefBase}?${params.toString()}`;
  };

  const query = q.trim().toLowerCase();
  const matches = (row: NormFactPeriodRow) =>
    (row.locationName ?? "").toLowerCase().includes(query) ||
    (row.ingredientName ?? "").toLowerCase().includes(query);

  const allPeriods = report?.periods ?? [];
  const shownPeriods = query ? allPeriods.filter(matches) : allPeriods;

  // Разбивка неполноты — числа берутся из `внеИтога.причины` (ядро), порядок
  // фиксирован здесь только для чтения, не для отбора: причины с нулём
  // периодов в этом окне просто не показываются.
  const причины = report
    ? COVERAGE_ORDER.map((причина) => ({
        причина,
        периодов: report.внеИтога.причины.find((c) => c.причина === причина)?.периодов ?? 0,
      })).filter((c) => c.периодов > 0)
    : [];

  return (
    <div className="sect" style={{ marginTop: 0 }}>
      {/* ── Период + поиск по точке/ингредиенту ── */}
      <form className="srcfr" action={hrefBase} method="get" style={{ marginBottom: 10 }}>
        <input type="hidden" name="tab" value={tab} />
        <label>
          С
          <input type="date" name="from" defaultValue={from} />
        </label>
        <label>
          По
          <input type="date" name="to" defaultValue={to} />
        </label>
        <label>
          Точка / ингредиент
          <input type="search" name="q" defaultValue={q} placeholder="точка или ингредиент…" />
        </label>
        <button className="btn sm" type="submit" style={{ alignSelf: "end" }}>
          Показать
        </button>
      </form>
      {!isDefaultPeriod && (
        <p className="hint" style={{ marginBottom: 14 }}>
          Период задан вручную ({fmtDay(from)} – {fmtDay(to)}) ·{" "}
          <Link href={periodHref(defaultFrom, defaultTo, q)}>показать всю историю</Link>
        </p>
      )}

      {report === null ? (
        // Честное состояние 1/3: ядро не ответило. НЕ «расхождений нет».
        <div className="empty">
          <b>Не удалось проверить норму и факт</b>
          Core не ответил на /coffee/norm-fact — обнови страницу. Показатели ниже сейчас просто не
          посчитаны, это не значит, что расхождений нет.
        </div>
      ) : allPeriods.length === 0 ? (
        isDefaultPeriod ? (
          // Честное состояние 2/3: данных нет вовсе (за всю историю).
          <div className="empty">
            <b>Данных нет</b>
            За всю известную историю нет ни одной пары «заливка → возврат» — сверять пока нечего.
          </div>
        ) : (
          // Честное состояние 2/3 (второй вариант): период сузил список до
          // пусто — данные есть, просто не в этом окне.
          <div className="empty">
            <b>В выбранном периоде пусто</b>
            За {fmtDay(from)}–{fmtDay(to)} нет ни одного периода бункера.{" "}
            <Link href={periodHref(defaultFrom, defaultTo, q)}>Показать всю историю</Link>.
          </div>
        )
      ) : (
        <>
          <div className="tiles" style={{ marginBottom: 14 }}>
            <div className="tile">
              <div className="lab">Факт (полные периоды)</div>
              <div className="v">{grams(report.итог.факт)}</div>
              <div className="foot">
                <span className="mk" />
                {report.итог.периодов} {plural(report.итог.периодов, "период", "периода", "периодов")} в итоге
              </div>
            </div>
            <div className="tile">
              <div className="lab">Норма (полные периоды)</div>
              <div className="v">{grams(report.итог.норма)}</div>
            </div>
            <div className="tile">
              <div className="lab">Разница</div>
              <div className="v">{diffGrams(report.итог.разница)}</div>
              <div className="foot">
                <span className="mk" />
                число, не признак недостачи
              </div>
            </div>
            <div className={`tile ${report.внеИтога.периодов === 0 ? "zero" : ""}`}>
              <div className="lab">Вне итога</div>
              <div className="v">{report.внеИтога.периодов}</div>
              <div className="foot">
                <span className="mk" />
                {report.внеИтога.периодов > 0 ? "не хватает данных, не расхождение" : "все периоды в итоге"}
              </div>
            </div>
          </div>

          {/* ── Разбивка неполноты по причинам — отдельным блоком, числом (правило 2) ── */}
          <div className="sect-h">
            <h3 className="h2">Вне итога — почему</h3>
            <span className="chip">
              {report.внеИтога.периодов} {plural(report.внеИтога.периодов, "период", "периода", "периодов")}
            </span>
          </div>
          {причины.length === 0 ? (
            <p className="hint" style={{ marginBottom: 22 }}>
              В этом окне все периоды бункера вошли в итог.
            </p>
          ) : (
            <div style={{ marginBottom: 22 }}>
              {причины.map((c) => (
                <div className="trow" key={c.причина}>
                  <div className="tb">
                    <div className="tt">{c.причина}</div>
                    <div className="tm">
                      <span>{COVERAGE_LABEL[c.причина]}</span>
                    </div>
                  </div>
                  <span className="due">
                    {c.периодов} {plural(c.периодов, "период", "периода", "периодов")}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="hint" style={{ marginBottom: 14 }}>
            Расхождение «выдан» / «попал в выручку» за период: {report.расхождениеDeliveredCountable}{" "}
            {plural(report.расхождениеDeliveredCountable, "заказ", "заказа", "заказов")} — расход сырья
            считается по факту выдачи, а не по тому, что засчиталось в выручку (R-F5).
          </p>

          <p className="hint" style={{ marginBottom: 14 }}>
            Непарные записи журнала (за всю историю, не только в этом окне; не входят ни в один период
            выше — знаменатель «периодов» сам неполон): {report.внеИтога.непарныхЗаливок}{" "}
            {plural(report.внеИтога.непарныхЗаливок, "заливка", "заливки", "заливок")} без возврата,{" "}
            {report.внеИтога.непарныхВозвратов} {plural(report.внеИтога.непарныхВозвратов, "возврат", "возврата", "возвратов")} без заливки.
          </p>

          {/* ── Периоды бункера: точка · позиция · ингредиент · интервал · залито
              · остаток · факт · норма · разница · полнота (главная колонка) ── */}
          <div className="sect-h">
            <h3 className="h2">Периоды бункера</h3>
            <span className="chip">
              {fmtDay(from)} – {fmtDay(to)}
            </span>
          </div>
          {shownPeriods.length === 0 ? (
            // Честное состояние 3/3: фильтр (поиск по точке/ингредиенту)
            // сузил список до пусто — периоды есть, просто не под этот запрос.
            <div className="empty">
              <b>Ничего не нашлось</b>
              По «{q}» совпадений среди периодов нет — <Link href={periodHref(from, to, "")}>сбросить поиск</Link>.
            </div>
          ) : (
            <div>
              {shownPeriods.map((p, i) => {
                const isFull = p.полнота === "полный";
                return (
                  <div className="trow" key={`${p.machineId}:${p.position}:${p.from}:${p.to}:${i}`}>
                    <div className="tb">
                      <div className="tt">
                        {p.locationName ?? "точка без карточки"} · бункер {p.position} ·{" "}
                        {p.ingredientName ?? "ингредиент не опознан"}
                      </div>
                      <div className="tm">
                        <span>
                          {fmtDay(p.from)} – {fmtDay(p.to)}
                        </span>
                        <span>залито {grams(p.залито)}</span>
                        <span>остаток {grams(p.возвращено)}</span>
                        <span>факт {grams(p.факт)}</span>
                        <span>норма {grams(p.норма)}</span>
                        <span>
                          {p.чашек} {plural(p.чашек, "чашка", "чашки", "чашек")}
                          {p.чашекБезНормы > 0 && ` (из них ${p.чашекБезНормы} без нормы)`}
                        </span>
                        <span className={`chip ${isFull ? "" : "b"}`}>{COVERAGE_LABEL[p.полнота]}</span>
                      </div>
                    </div>
                    <span className="due">{diffGrams(p.разница)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
