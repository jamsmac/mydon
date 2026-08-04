import type {
  CurrencyAmount,
  FinanceBucket,
  FinanceCounterparty,
  FinanceFlow,
  FinanceSummary,
} from "../lib/core";
import { moneyByCurrency, when } from "../lib/format";
import { fmtDay } from "../lib/globerent";
import { categoryLabel, flowStatusLabel, methodLabel } from "../lib/finance-labels";
import { MiniBars } from "./mini-bars";
import { FlowRowActions, FxForm, NewFlowForm } from "./finance-forms";

/**
 * Вкладка «Финансы» рабочего места направления — перенос финконтура PROMACH:
 * агинг дебиторки, «к сроку ≤ 7 дней», термометр концентрации, кэш-флоу,
 * курс валют и ввод денег (единственная дверь money-домена).
 *
 * Валюты нигде не складываются между собой: каждая корзина показывает суммы
 * по валютам, а сумовой эквивалент — отдельно и только по курсу записи.
 */

const nfmt = (n: number): string => Math.round(n).toLocaleString("ru-RU");

function byCur(list: CurrencyAmount[]): string {
  if (list.length === 0) return "—";
  return moneyByCurrency(list);
}

/** Сумма просроченных корзин: 1–30 + 31–60 + 61–90 + 90+. */
function overdueOf(a: { d0_30: FinanceBucket; d31_60: FinanceBucket; d61_90: FinanceBucket; d90plus: FinanceBucket }): FinanceBucket {
  const merged: FinanceBucket = { count: 0, byCurrency: [], uzs: 0, unconverted: 0 };
  for (const b of [a.d0_30, a.d31_60, a.d61_90, a.d90plus]) {
    merged.count += b.count;
    merged.uzs += b.uzs;
    merged.unconverted += b.unconverted;
    for (const c of b.byCurrency) {
      const found = merged.byCurrency.find((m) => m.currency === c.currency);
      if (found) {
        found.amount += c.amount;
        found.count += c.count;
      } else {
        merged.byCurrency.push({ ...c });
      }
    }
  }
  merged.byCurrency.sort((a2, b2) =>
    a2.currency === "UZS" ? -1 : b2.currency === "UZS" ? 1 : a2.currency.localeCompare(b2.currency),
  );
  return merged;
}

function flowTitle(f: FinanceFlow): string {
  const who = f.counterpartyEntityName ?? f.counterparty;
  const what = f.purpose ?? categoryLabel(f.category) ?? (f.direction === "in" ? "нам" : "мы");
  return who !== null ? `${who} — ${what}` : what;
}

/** Строка записи: одна и та же в «к сроку» и в ленте. */
function FlowRow({ domain, f, today }: { domain: string; f: FinanceFlow; today: string }) {
  const late = f.status === "planned" && f.dueDate !== null && f.dueDate < today;
  const meta = [
    f.direction === "in" ? "нам должны" : "мы должны",
    categoryLabel(f.category),
    methodLabel(f.method),
    f.docNo !== null ? `док ${f.docNo}` : null,
    f.dueDate !== null ? `срок ${fmtDay(f.dueDate)}` : null,
    flowStatusLabel(f.status),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`trow ${late ? "hot" : ""}`}>
      <div className="tb">
        <div className="tt">{flowTitle(f)}</div>
        <div className="tm">{meta}</div>
      </div>
      <span className={`due ${late ? "hot" : ""}`} style={{ whiteSpace: "nowrap" }}>
        {moneyByCurrency([{ amount: f.amount, currency: f.currency }])}
      </span>
      <FlowRowActions domain={domain} id={f.id} status={f.status} />
    </div>
  );
}

const AGING_ROWS: { key: keyof Pick<FinanceSummary["receivables"], "notDue" | "d0_30" | "d31_60" | "d61_90" | "d90plus" | "noDue">; label: string }[] = [
  { key: "notDue", label: "срок не наступил" },
  { key: "d0_30", label: "просрочка 1–30 дней" },
  { key: "d31_60", label: "31–60 дней" },
  { key: "d61_90", label: "61–90 дней" },
  { key: "d90plus", label: "дольше 90 дней" },
  { key: "noDue", label: "без срока" },
];

export function FinancePanel({
  domain,
  summary,
  flows,
  counterparties,
  units = [],
}: {
  domain: string;
  summary: FinanceSummary;
  flows: FinanceFlow[];
  counterparties: FinanceCounterparty[];
  /** Единицы техники — для привязки расхода к себестоимости. */
  units?: { id: string; label: string }[];
}) {
  const r = summary.receivables;
  const p = summary.payables;
  const overdueIn = overdueOf(r);
  const conc = summary.concentration;

  return (
    <>
      {/* ── Плитки: открытая дебиторка, просрочено, к сроку, кредиторка ── */}
      <div className="tiles">
        <div className={`tile ${r.total.count > 0 ? "" : "zero"}`}>
          <div className="lab">Нам должны · открыто</div>
          <div className="v" style={{ fontSize: 20 }}>{byCur(r.total.byCurrency)}</div>
          <div className="foot"><span className="mk" />
            {r.total.count > 0 ? `записей: ${r.total.count}` : "долгов не заведено"}
          </div>
        </div>
        <div className={`tile ${overdueIn.count > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Из них просрочено</div>
          <div className="v" style={{ fontSize: 20 }}>{overdueIn.count > 0 ? byCur(overdueIn.byCurrency) : "0"}</div>
          <div className="foot"><span className="mk" />
            {overdueIn.count > 0 ? `записей: ${overdueIn.count}` : "просрочек нет"}
          </div>
        </div>
        <div className={`tile ${summary.dueSoonIn.length > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">К сроку ≤ 7 дней · нам</div>
          <div className="v">{summary.dueSoonIn.length}</div>
          <div className="foot"><span className="mk" />
            {summary.dueSoonIn.length > 0 ? "напомни клиентам" : "неделя спокойна"}
          </div>
        </div>
        <div className={`tile ${summary.dueSoonOut.length > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">К сроку ≤ 7 дней · мы</div>
          <div className="v">{summary.dueSoonOut.length}</div>
          <div className="foot"><span className="mk" />
            {p.total.count > 0 ? `мы должны: ${byCur(p.total.byCurrency)}` : "своих долгов нет"}
          </div>
        </div>
      </div>

      {/* ── Ввод денег — единственная дверь money-домена ── */}
      <div style={{ marginTop: 12 }}>
        <NewFlowForm domain={domain} counterparties={counterparties} fx={summary.fx} units={units} />
      </div>

      {/* ── К сроку на неделе (паттерн notifications.ts PROMACH) ── */}
      {(summary.dueSoonIn.length > 0 || summary.dueSoonOut.length > 0) && (
        <div className="sect">
          <div className="sect-h">
            <h3 className="h2">К сроку на неделе</h3>
            <span className="chip h">{summary.dueSoonIn.length + summary.dueSoonOut.length}</span>
          </div>
          {[...summary.dueSoonIn, ...summary.dueSoonOut].map((f) => (
            <FlowRow domain={domain} f={f} today={summary.today} key={f.id} />
          ))}
        </div>
      )}

      {/* ── Агинг дебиторки: корзины из плана интеграции PROMACH ── */}
      <div className="sect">
        <div className="sect-h">
          <h3 className="h2">Дебиторка по возрасту</h3>
          {r.total.unconverted > 0 && (
            <span className="chip">без курса · {r.total.unconverted}</span>
          )}
        </div>
        {r.total.count === 0 ? (
          <div className="empty">
            <b>Открытой дебиторки нет</b>
            Заведи обязательство со сроком — здесь появится раскладка по возрасту долга.
          </div>
        ) : (
          <div className="book">
            <div className="th">
              <span>Корзина</span>
              <span>Записей</span>
              <span style={{ textAlign: "right" }}>Сумма</span>
            </div>
            {AGING_ROWS.map(({ key, label }) => {
              const b = r[key];
              return (
                <div className="tr" key={key}>
                  <span className="nm">{label}</span>
                  <span className="cd">{b.count > 0 ? `×${b.count}` : "—"}</span>
                  <span className="pr">{b.count > 0 ? byCur(b.byCurrency) : "—"}</span>
                </div>
              );
            })}
          </div>
        )}
        {r.total.uzs > 0 && (
          <p className="hint" style={{ marginTop: 8 }}>
            В сумовом эквиваленте открыто ≈ {nfmt(r.total.uzs)} сум (по курсу каждой записи
            {r.total.unconverted > 0 ? `; ${r.total.unconverted} записей без курса в эквивалент не вошли` : ""}).
          </p>
        )}
      </div>

      {/* ── Термометр концентрации: ≥60% на одном должнике — красный ── */}
      {conc.rows.length > 0 && (
        <div className="sect">
          <div className="sect-h">
            <h3 className="h2">Концентрация долга</h3>
            {conc.alarm && conc.topShare !== null && (
              <span className="chip h">{Math.round(conc.topShare * 100)}% на одном должнике</span>
            )}
          </div>
          {conc.rows.slice(0, 5).map((row) => (
            <div className="trow" key={row.key}>
              <div className="tb">
                <div className="tt">{row.name}</div>
                <div className="tm">
                  {byCur(row.byCurrency)}
                  {row.share !== null ? ` · ${Math.round(row.share * 100)}% долга` : ""}
                </div>
                {row.share !== null && (
                  <div style={{ height: 4, background: "var(--surf-2)", borderRadius: 2, marginTop: 6 }}>
                    <div
                      style={{
                        height: 4,
                        width: `${Math.min(100, Math.round(row.share * 100))}%`,
                        borderRadius: 2,
                        background: row.share >= 0.6 ? "var(--hot)" : "var(--accent)",
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
          {conc.unconverted > 0 && (
            <p className="hint">Записей без курса: {conc.unconverted} — в доли они не вошли, но долг существует.</p>
          )}
        </div>
      )}

      {/* ── Кэш-флоу по месяцам (by_month из PROMACH, сумовой эквивалент) ── */}
      {summary.months.length > 1 && (
        <div className="sect">
          <div className="sect-h"><h3 className="h2">Деньги по месяцам</h3></div>
          <p className="hint" style={{ marginBottom: 0 }}>Приход (факт, сумовой эквивалент):</p>
          <MiniBars
            bars={summary.months.map((m) => ({
              label: m.month.slice(5),
              value: m.inflowUzs,
              title: `${m.month}: приход ≈ ${nfmt(m.inflowUzs)} сум`,
            }))}
          />
          <p className="hint" style={{ marginBottom: 0, marginTop: 8 }}>Расход:</p>
          <MiniBars
            hot
            bars={summary.months.map((m) => ({
              label: m.month.slice(5),
              value: m.outflowUzs,
              title: `${m.month}: расход ≈ ${nfmt(m.outflowUzs)} сум`,
            }))}
          />
        </div>
      )}

      {/* ── Курс валют: ручной ввод, история в Core (паттерн PROMACH) ── */}
      <div className="sect">
        <div className="sect-h"><h3 className="h2">Курс валют</h3></div>
        {summary.fx.length === 0 ? (
          <p className="hint">
            Курс не задан. Записи в валюте без курса не входят в сумовые итоги —
            задай курс, и новые записи посчитаются сами.
          </p>
        ) : (
          <div className="rows" style={{ marginBottom: 10 }}>
            {summary.fx.map((r2) => (
              <div className="row" key={r2.currency}>
                <div className="t">
                  <b>1 {r2.currency} = {Number(r2.rate).toLocaleString("ru-RU")} сум</b>
                  <small>{r2.source === "manual" ? "вручную" : r2.source}{r2.setBy !== null ? ` · ${r2.setBy}` : ""}</small>
                </div>
                <span className="when">{when(r2.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
        <FxForm domain={domain} />
        <p className="hint" style={{ marginTop: 8 }}>
          Курс фиксируется в каждой записи на дату операции — исторические суммы не «плавают»
          при смене курса (правило из PROMACH).
        </p>
      </div>

      {/* ── Лента записей ── */}
      <div className="sect">
        <div className="sect-h"><h3 className="h2">Последние записи</h3></div>
        {flows.length === 0 ? (
          <div className="empty">
            <b>Записей пока нет</b>
            Кнопка «+ Долг или платёж» выше — единственная дверь: деньги вводятся только через панель.
          </div>
        ) : (
          flows.map((f) => <FlowRow domain={domain} f={f} today={summary.today} key={f.id} />)
        )}
      </div>
    </>
  );
}
