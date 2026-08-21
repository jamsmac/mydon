import Link from "next/link";
import type {
  CashReconcileReport,
  CashReconcilePeriod,
  ReconcileResult,
  ReconcileRow,
  ReconcileInterval,
} from "../lib/core";
import { money, plural } from "../lib/format";
import { fmtDay } from "../lib/globerent";

/**
 * Подписи статуса строки «по автоматам» (R-K11) — словами, не красным
 * минусом (правило 2 брифа задачи 6): «инкассаций нет вовсе» у снек-автомата
 * с выручкой 17 061 000 читается как недостача, если её не назвать пробелом
 * ввода. Итог (`итог`) уже считает только строки «обычный» — это сделано в
 * ядре (правило 1), здесь только подпись.
 */
const ROW_STATUS_LABEL: Record<ReconcileRow["статус"], string> = {
  обычный: "обычный",
  "инкассаций нет вовсе": "инкассаций нет вовсе — пробел ввода, не недостача",
  "выручки нет": "выручки нет — пробел данных о продажах",
  "ждёт приёма": "все сборы периода ждут приёма — сумма ещё не введена, не недостача",
};

/** Статус периода между сборами (R-K11) — «пробел в журнале» доказан на 14 живых окнах (факт 11), это дисциплина ввода, не воровство. */
const INTERVAL_STATUS_LABEL: Record<ReconcileInterval["статус"], string> = {
  обычный: "обычный",
  "пробел в журнале": "пробел в журнале — сборы шли, в систему не внесли",
  "ждёт приёма": "ждёт приёма — сумма сбора ещё не введена (этап 2 не пройден)",
};

/** Статус календарного месяца сверки с банком (R-K6) — признак ДАННЫХ, не разница. */
const PERIOD_STATUS_LABEL: Record<CashReconcilePeriod["status"], string> = {
  ok: "сходится",
  empty: "тихий месяц — операций не было",
  noWithdrawn: "банк принял взнос, инкассаций в системе нет",
  noDeposit: "инкассации есть, взноса в банке не видно",
  pendingReceipt: "инкассации есть, все ждут приёма — сумма ещё не введена",
};

function fmtMonth(period: string): string {
  const d = new Date(`${period}-01T00:00:00+05:00`);
  if (Number.isNaN(d.getTime())) return period;
  const s = d.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "Asia/Tashkent" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Доля уже посчитана в ядре как проценты (-2.2 значит -2,2%) — здесь только формат, не пересчёт. */
function pct(n: number | null): string {
  if (n === null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
}

/**
 * Лист «Сверка кассы» (срез К, задача 6; R-K9 + R-K11): одна цепочка денег —
 * автомат → касса → счёт, три секции по образцу `expiry-book.tsx`.
 *
 * `reconcile` и `cash` приходят с ДВУХ разных эндпоинтов ядра (R-K9) и могут
 * не отвечать независимо друг от друга — секция «по автоматам»/«по периодам»
 * и секция «изъято против сданного в банк» показывают свой честный статус
 * каждая, а не гаснут вместе. `итог` — ИЗ ЯДРА (не считается здесь): правило
 * «что считать сходимостью» живёт в одном месте (Task 3).
 */
export function CashReconcile({
  reconcile,
  cash,
  hrefBase,
  tab,
  from,
  to,
  defaultFrom,
  defaultTo,
  isDefaultPeriod,
  q,
}: {
  /** null — ядро не ответило на /collections/reconcile. НЕ «сборов не было». */
  reconcile: ReconcileResult | null;
  /** null — ядро не ответило на /finance/cash-reconcile. */
  cash: CashReconcileReport | null;
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
  const matches = (имя: string | null) => (имя ?? "").toLowerCase().includes(query);

  const allRows = reconcile?.rows ?? [];
  const shownRows = query ? allRows.filter((r) => matches(r.имя)) : allRows;
  const allIntervals = reconcile?.intervals ?? [];
  const shownIntervals = query ? allIntervals.filter((r) => matches(r.имя)) : allIntervals;

  return (
    <div className="sect" style={{ marginTop: 0 }}>
      {/* ── Период + поиск по автомату: общий фильтр секций 1 и 2 ── */}
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
          Автомат
          <input type="search" name="q" defaultValue={q} placeholder="имя автомата…" />
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

      {reconcile === null ? (
        // Пустое состояние 1/3 (обе секции 1 и 2 разом): ядро не ответило на
        // /collections/reconcile — НЕ «сборов не было».
        <div className="empty" style={{ marginBottom: 22 }}>
          <b>Не удалось проверить сверку по автоматам</b>
          Core не ответил на /collections/reconcile — обнови страницу. Это не значит, что
          расхождений нет: показатели ниже сейчас просто не посчитаны.
        </div>
      ) : (
        <>
          {/* ── Секция 1: по автоматам за период ── */}
          <div className="sect-h">
            <h3 className="h2">По автоматам</h3>
            <span className="chip">
              {fmtDay(from)} – {fmtDay(to)}
            </span>
          </div>
          {allRows.length === 0 ? (
            isDefaultPeriod ? (
              // Пустое состояние 2/3: данных нет вовсе (за всю историю).
              <div className="empty" style={{ marginBottom: 22 }}>
                <b>Данных нет</b>
                За всю известную историю в этом направлении нет ни наличной выручки, ни
                инкассации — сверять пока нечего.
              </div>
            ) : (
              // Пустое состояние 3/3: фильтр (период) сузил список до пусто —
              // данные есть, просто не в этом окне.
              <div className="empty" style={{ marginBottom: 22 }}>
                <b>В выбранном периоде пусто</b>
                За {fmtDay(from)}–{fmtDay(to)} нет ни выручки, ни инкассаций.{" "}
                <Link href={periodHref(defaultFrom, defaultTo, q)}>Показать всю историю</Link>.
              </div>
            )
          ) : (
            <>
              <div className="tiles" style={{ marginBottom: 14 }}>
                <div className="tile">
                  <div className="lab">Выручка (обычные)</div>
                  <div className="v">{money(reconcile.итог.выручка)}</div>
                  <div className="foot">
                    <span className="mk" />
                    {reconcile.итог.автоматов} {plural(reconcile.итог.автоматов, "автомат", "автомата", "автоматов")} в итоге
                  </div>
                </div>
                <div className="tile">
                  <div className="lab">Изъято</div>
                  <div className="v">{money(reconcile.итог.изъято)}</div>
                </div>
                <div
                  className={`tile ${reconcile.итог.доля !== null && Math.abs(reconcile.итог.доля) > 10 ? "is-hot" : ""}`}
                >
                  <div className="lab">Разница · доля</div>
                  <div className="v">{money(reconcile.итог.разница)}</div>
                  <div className="foot">
                    <span className="mk" />
                    {pct(reconcile.итог.доля)}
                  </div>
                </div>
                <div className={`tile ${reconcile.внеИтога.автоматов > 0 ? "is-hot" : "zero"}`}>
                  <div className="lab">Вне итога</div>
                  <div className="v">{reconcile.внеИтога.автоматов}</div>
                  <div className="foot">
                    <span className="mk" />
                    {reconcile.внеИтога.автоматов > 0
                      ? `${money(reconcile.внеИтога.выручка)} — пробел ввода, не недостача`
                      : "все автоматы в итоге"}
                  </div>
                </div>
              </div>

              {shownRows.length === 0 ? (
                <div className="empty" style={{ marginBottom: 22 }}>
                  <b>Ничего не нашлось</b>
                  По автомату «{q}» совпадений нет — <Link href={periodHref(from, to, "")}>сбросить поиск</Link>.
                </div>
              ) : (
                <div style={{ marginBottom: 22 }}>
                  {shownRows.map((r) => {
                    const isNormal = r.статус === "обычный";
                    const isHot = isNormal && r.доля !== null && Math.abs(r.доля) > 10;
                    return (
                      <div className={`trow ${isHot ? "hot" : ""}`} key={r.machineId}>
                        <div className="tb">
                          <div className="tt">{r.имя ?? "автомат без карточки"}</div>
                          <div className="tm">
                            <span>выручка {money(r.выручка)}</span>
                            <span>изъято {money(r.изъято)}</span>
                            <span>
                              {r.инкассаций} {plural(r.инкассаций, "инкассация", "инкассации", "инкассаций")}
                            </span>
                            {r.медианныйИнтервалДней !== null && <span>интервал ~{r.медианныйИнтервалДней} дн.</span>}
                            {r.медианныйЛагДней !== null && <span>лаг ~{r.медианныйЛагДней} дн.</span>}
                            {!isNormal && <span className="chip b">{ROW_STATUS_LABEL[r.статус]}</span>}
                          </div>
                        </div>
                        <span className={`due ${isHot ? "hot" : ""}`}>
                          {isNormal ? `${money(r.разница)} · ${pct(r.доля)}` : money(r.разница)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ── Секция 2: по периодам между сборами — вся история, период выше не сужает ── */}
          <div className="sect-h">
            <h3 className="h2">По периодам между сборами</h3>
            <span className="chip">вся история</span>
          </div>
          <p className="hint" style={{ marginBottom: 14 }}>
            Первая инкассация каждого автомата не входит в разрез — у неё нет известного начала
            периода: исключено {reconcile.первыхИсключено}{" "}
            {plural(reconcile.первыхИсключено, "автомат", "автомата", "автоматов")}.
          </p>
          {allIntervals.length === 0 ? (
            <div className="empty">
              <b>Данных нет</b>
              Ни у одного автомата ещё не было двух инкассаций подряд — периода между сборами
              посчитать не из чего.
            </div>
          ) : shownIntervals.length === 0 ? (
            <div className="empty">
              <b>Ничего не нашлось</b>
              По автомату «{q}» совпадений среди периодов нет.
            </div>
          ) : (
            <div>
              {shownIntervals.map((iv) => {
                const isNormal = iv.статус === "обычный";
                return (
                  <div className="trow" key={iv.id}>
                    <div className="tb">
                      <div className="tt">{iv.имя ?? "автомат без карточки"}</div>
                      <div className="tm">
                        <span>
                          {fmtDay(iv.с)} – {fmtDay(iv.по)}
                        </span>
                        <span>
                          {iv.дней} {plural(Math.round(iv.дней), "день", "дня", "дней")}
                        </span>
                        <span>ожидалось {money(iv.ожидалось)}</span>
                        <span>изъято {iv.изъято === null ? "ждёт приёма" : money(iv.изъято)}</span>
                        {!isNormal && <span className="chip b">{INTERVAL_STATUS_LABEL[iv.статус]}</span>}
                      </div>
                    </div>
                    <span className="due">{iv.разница === null ? "—" : money(iv.разница)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── Секция 3: изъято против сданного в банк ── */}
      <div className="sect-h" style={{ marginTop: 26 }}>
        <h3 className="h2">Изъято против сданного в банк</h3>
      </div>
      {cash === null ? (
        <div className="empty">
          <b>Не удалось проверить сверку с банком</b>
          Core не ответил на /finance/cash-reconcile — обнови страницу. Это не значит, что
          расхождений нет.
        </div>
      ) : (
        <>
          {/* Лаг 2–7 дней даёт ложные расхождения на границе месяцев — показываем предупреждение ядра, а не прячем его (правило брифа). */}
          <p className="hint" style={{ marginBottom: 14 }}>{cash.note}</p>
          <div className="tiles" style={{ marginBottom: 14 }}>
            <div className={`tile ${!cash.hasWithdrawn ? "zero" : ""}`}>
              <div className="lab">Изъято (инкассации)</div>
              <div className="v">{money(cash.withdrawn)}</div>
              <div className="foot">
                <span className="mk" />
                {cash.withdrawnCount} {plural(cash.withdrawnCount, "запись", "записи", "записей")}
                {cash.withdrawnPendingCount > 0 &&
                  ` · ещё ${cash.withdrawnPendingCount} ${plural(cash.withdrawnPendingCount, "ждёт", "ждут", "ждут")} приёма`}
              </div>
            </div>
            <div className={`tile ${!cash.hasDeposited ? "zero" : ""}`}>
              <div className="lab">Сдано в банк (символ 0200)</div>
              <div className="v">{money(cash.deposited)}</div>
              <div className="foot">
                <span className="mk" />
                {cash.depositedCount} {plural(cash.depositedCount, "взнос", "взноса", "взносов")}
              </div>
            </div>
            <div className="tile">
              <div className="lab">Разница за период</div>
              <div className="v">{money(cash.diff)}</div>
            </div>
          </div>
          <div>
            {cash.periods.map((p) => (
              <div className="trow" key={p.period}>
                <div className="tb">
                  <div className="tt">{fmtMonth(p.period)}</div>
                  <div className="tm">
                    <span>
                      изъято {money(p.withdrawn)} ({p.withdrawnCount}
                      {p.withdrawnPending > 0 ? `, ждут приёма: ${p.withdrawnPending}` : ""})
                    </span>
                    <span>
                      сдано {money(p.deposited)} ({p.depositedCount})
                    </span>
                    {p.status !== "ok" && <span className="chip b">{PERIOD_STATUS_LABEL[p.status]}</span>}
                  </div>
                </div>
                <span className="due">{money(p.diff)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
