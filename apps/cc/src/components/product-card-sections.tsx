import Link from "next/link";
import {
  FISCAL_FIELDS,
  fiscalGaps,
  productKind,
  PRODUCT_KIND_LABELS,
  resaleGaps,
} from "@mydon/shared";
import type { FinanceFlow, GrContract } from "../lib/core";

/**
 * Секции карточек каталога: товар (фискальная готовность · экономика · в каких
 * автоматах), ингредиент (в каких рецептах), контрагент (договоры и деньги).
 *
 * До них карточка товара была пустой — плоский список attrs. Правило
 * «незаполнено» (isIncomplete) жило только в СПИСКЕ товаров: владелец видел
 * метку в журнале, открывал карточку — и не находил там, что именно не так.
 *
 * Все секции серверные и читающие: правка полей остаётся в «Полях»
 * (EntityEditor) — одна точка записи, чтобы история правок не расползлась.
 */

const число = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v.replace(/[\s\u00A0\u202F]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const сум = (n: number): string => `${n.toLocaleString("ru-RU")} сум`;

// ── Товар: фискальная готовность ─────────────────────────────────────────────

export function ProductFiscal({ attrs }: { attrs: Record<string, unknown> }) {
  const gaps = fiscalGaps(attrs);
  const поля: { key: string; mono: boolean }[] = [
    ...FISCAL_FIELDS.map((f) => ({ key: f as string, mono: f !== "НДС" })),
    { key: "штрихкод", mono: true },
  ];

  return (
    <div className="sect" id="fiscal" data-toc="Чек">
      <div className="sect-h">
        <h3 className="h2">Фискальная готовность</h3>
        <span className={`chip ${gaps.length === 0 ? "" : "h"}`}>
          {gaps.length === 0 ? "чек соберётся" : `дыр: ${gaps.length}`}
        </span>
        <span className="sp" />
      </div>
      <div className="pass">
        {поля.map(({ key, mono }) => {
          const raw = attrs[key];
          const пусто = raw === undefined || raw === null || String(raw).trim() === "";
          return (
            <div className="f" key={key}>
              <span className="k">{key}</span>
              <span className={`val${mono ? " mono" : ""}`}>{пусто ? "—" : String(raw)}</span>
            </div>
          );
        })}
      </div>
      {gaps.length > 0 && (
        <ul className="hint" style={{ marginTop: 8 }}>
          {gaps.map((g) => (
            <li key={g.field} className="err-text">
              {g.field} — {g.flaw}: {g.why}
            </li>
          ))}
        </ul>
      )}
      {gaps.length > 0 && (
        <p className="hint">Заполняется в секции «Поля» ниже — здесь только диагноз.</p>
      )}
    </div>
  );
}

// ── Товар: экономика ─────────────────────────────────────────────────────────

export function ProductEconomy({
  attrs,
  recipeCost,
}: {
  attrs: Record<string, unknown>;
  /** Себестоимость рецептурного товара; null — не рецепт или не посчиталась. */
  recipeCost: { total: number; unresolved: number } | null;
}) {
  const вид = productKind(attrs);
  const продажа = число(attrs["цена продажи"]) ?? число(attrs["цена"]);
  const покупка = вид === "рецепт" ? (recipeCost?.total ?? null) : число(attrs["цена покупки"]);
  const наценка = продажа !== null && покупка !== null && покупка > 0 ? продажа - покупка : null;
  const gaps = resaleGaps(attrs);
  const история = attrs["история цены покупки"];

  return (
    <div className="sect" id="economy" data-toc="Экономика">
      <div className="sect-h">
        <h3 className="h2">Экономика</h3>
        {вид !== null && <span className="chip">{PRODUCT_KIND_LABELS[вид]}</span>}
        <span className="sp" />
      </div>

      {вид === null ? (
        <div className="empty">
          <b>Принцип карточки не выбран</b>
          «На перепродажу» или «С рецептом» — поле «вид» в секции «Поля». Пока он не выбран,
          себестоимость считать не из чего.
        </div>
      ) : (
        <div className="tiles">
          <div className="tile">
            <span className="lab">{вид === "рецепт" ? "Себестоимость" : "Цена покупки"}</span>
            <span className="v">{покупка !== null ? сум(покупка) : "—"}</span>
            {вид === "рецепт" && recipeCost !== null && recipeCost.unresolved > 0 && (
              <span className="foot">не посчитано строк: {recipeCost.unresolved} — итог неполон</span>
            )}
          </div>
          <div className="tile">
            <span className="lab">Цена продажи</span>
            <span className="v">{продажа !== null ? сум(продажа) : "—"}</span>
          </div>
          <div className={`tile ${наценка !== null && наценка < 0 ? "is-hot" : ""}`}>
            <span className="lab">Наценка</span>
            <span className="v">
              {наценка !== null && покупка !== null
                ? `${сум(наценка)} · ${Math.round((наценка / покупка) * 100)}%`
                : "—"}
            </span>
            {наценка !== null && наценка < 0 && <span className="foot">продаём дешевле, чем берём</span>}
          </div>
        </div>
      )}

      {gaps.length > 0 && (
        <ul className="hint" style={{ marginTop: 8 }}>
          {gaps.map((g) => (
            <li key={g.field} className="err-text">
              {g.field}: {g.why}
            </li>
          ))}
        </ul>
      )}

      {typeof история === "string" && история.trim().length > 0 && (
        <p className="hint" style={{ marginTop: 8, whiteSpace: "pre-line" }}>
          История цены покупки: {история}
        </p>
      )}
    </div>
  );
}

// ── Товар: в каких автоматах стоит ───────────────────────────────────────────

export interface ProductMachineRow {
  machineId: string;
  machineName: string;
  slot: string;
}

export function ProductMachines({ rows }: { rows: ProductMachineRow[] }) {
  return (
    <div className="sect" id="machines" data-toc="Автоматы">
      <div className="sect-h">
        <h3 className="h2">В каких автоматах стоит</h3>
        <span className="chip">{rows.length}</span>
        <span className="sp" />
      </div>
      {rows.length === 0 ? (
        // Пустой блок показывается нарочно: «ни в одном автомате» — это ответ,
        // а не отсутствие данных. Товар без слота не продаётся.
        <div className="empty">
          <b>Ни в одном автомате</b>
          Товар не расставлен по слотам. Раскладка задаётся на карточке автомата
          (секция «Планограмма»).
        </div>
      ) : (
        <div className="rows">
          {rows.map((r) => (
            <div className="row" key={`${r.machineId}:${r.slot}`}>
              <div className="t">
                <Link href={`/card/${r.machineId}`}>{r.machineName}</Link>
              </div>
              <span className="pill mono">слот {r.slot}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Ингредиент: в каких рецептах используется ────────────────────────────────

export interface IngredientUsageRow {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
}

export function IngredientUsage({ rows }: { rows: IngredientUsageRow[] }) {
  return (
    <div className="sect" id="usage" data-toc="Рецепты">
      <div className="sect-h">
        <h3 className="h2">В каких рецептах</h3>
        <span className="chip">{rows.length}</span>
        <span className="sp" />
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <b>Ни в одном рецепте</b>
          Состав задаётся на карточке товара с принципом «С рецептом».
        </div>
      ) : (
        <div className="rows">
          {rows.map((r) => (
            <div className="row" key={r.productId}>
              <div className="t">
                <Link href={`/card/${r.productId}`}>{r.productName}</Link>
              </div>
              <span className="pill">
                {r.quantity} {r.unit} на порцию
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Контрагент: договоры и деньги ────────────────────────────────────────────

export function ContractorFinance({
  contracts,
  flows,
}: {
  contracts: GrContract[];
  flows: FinanceFlow[];
}) {
  const пришло = flows
    .filter((f) => f.direction === "in" && f.uzs !== null)
    .reduce((s, f) => s + (f.uzs ?? 0), 0);
  const ушло = flows
    .filter((f) => f.direction === "out" && f.uzs !== null)
    .reduce((s, f) => s + (f.uzs ?? 0), 0);
  const последние = flows.slice(0, 15);

  return (
    <div className="sect" id="finance" data-toc="Деньги">
      <div className="sect-h">
        <h3 className="h2">Договоры и деньги</h3>
        <span className="chip">{contracts.length + flows.length}</span>
        <span className="sp" />
      </div>

      {contracts.length === 0 && flows.length === 0 ? (
        <div className="empty">
          <b>Движений нет</b>
          Договоры и платежи этого контрагента появятся здесь, как только будут заведены
          в финансовом контуре.
        </div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="lab">Пришло</span>
              <span className="v">{сум(пришло)}</span>
            </div>
            <div className="tile">
              <span className="lab">Ушло</span>
              <span className="v">{сум(ушло)}</span>
            </div>
            <div className="tile">
              <span className="lab">Договоров</span>
              <span className="v">{contracts.length}</span>
            </div>
          </div>

          {contracts.length > 0 && (
            <div className="rows" style={{ marginTop: 10 }}>
              {contracts.map((c) => (
                <div className="row" key={c.id}>
                  <div className="t">
                    <Link href={`/contracts/${c.id}`}>
                      Договор {c.contractNo} от {c.contractDate}
                    </Link>
                  </div>
                  <span className="pill mono">{Number(c.totalWithVat).toLocaleString("ru-RU")}</span>
                  <span className="pill">{c.status}</span>
                </div>
              ))}
            </div>
          )}

          {последние.length > 0 && (
            <div className="rows" style={{ marginTop: 10 }}>
              {последние.map((f) => (
                <div className="row" key={f.id}>
                  <div className="t">
                    {f.direction === "in" ? "→ приход" : "← расход"}
                    {f.purpose ? ` · ${f.purpose}` : ""}
                  </div>
                  <span className="pill mono">
                    {f.uzs !== null ? сум(f.uzs) : `${f.amount} ${f.currency}`}
                  </span>
                  <span className="when">{f.date}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
