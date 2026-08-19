import Link from "next/link";
import {
  FISCAL_FIELDS,
  fiscalGaps,
  partLocationLabel,
  productKind,
  PRODUCT_KIND_LABELS,
  resaleGaps,
} from "@mydon/shared";
import type { FinanceFlow, GrContract, PartHistoryRow as PartHistoryRowT, UnmatchedSaleName } from "../lib/core";
import { SaleAliasBinder } from "./sale-alias-binder";

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

// ── Товар: продажи (связь по имени) ──────────────────────────────────────────

export function ProductSalesSection({
  sales,
  days,
  entityId,
  unmatched,
}: {
  sales: import("../lib/core").ProductSales | null;
  days: number;
  entityId: string;
  /** Несвязанные имена продаж — кандидаты на привязку к этой карточке. */
  unmatched: UnmatchedSaleName[];
}) {
  return (
    <div className="sect" id="sales" data-toc="Продажи">
      <div className="sect-h">
        <h3 className="h2">Продажи за {days} дней</h3>
        <span className="chip">{sales?.machines.length ?? 0}</span>
        <span className="sp" />
      </div>
      {sales === null || sales.machines.length === 0 ? (
        // Связь по ИМЕНИ: sale.product — текст из источника, FK на карточку
        // нет. «Не найдено» ≠ «не продаётся» — и это сказано словами.
        <div className="empty">
          <b>Продаж с таким именем не найдено</b>
          Продажи связываются по точному имени карточки. Если товар продаётся, но здесь
          пусто — в источнике (Ourvend) он назван иначе.
        </div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="lab">Штук</span>
              <span className="v">{sales.total.qty.toLocaleString("ru-RU")}</span>
            </div>
            <div className="tile">
              <span className="lab">Выручка</span>
              <span className="v">{сум(Math.round(sales.total.amount))}</span>
            </div>
          </div>
          <div className="rows" style={{ marginTop: 10 }}>
            {sales.machines.map((m) => (
              <div className="row" key={m.machineId ?? m.serial}>
                <div className="t">
                  {m.machineId ? (
                    <Link href={`/card/${m.machineId}`}>{m.machineName ?? m.serial}</Link>
                  ) : (
                    <span className="mono">{m.serial}</span>
                  )}
                </div>
                <span className="pill">{m.qty.toLocaleString("ru-RU")} шт</span>
                <span className="pill mono">{сум(Math.round(m.amount))}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <SaleAliasBinder entityId={entityId} aliases={sales?.aliases ?? []} unmatched={unmatched} />
    </div>
  );
}

// ── Склад: лента движений ────────────────────────────────────────────────────

const ДВИЖЕНИЕ: Record<string, string> = {
  intake: "приход",
  consumption: "расход",
  transfer: "перемещение",
  adjustment: "инвентаризация",
};

export function WarehouseMovements({
  movements,
}: {
  movements: import("../lib/core").WarehouseStock["movements"];
}) {
  return (
    <div className="sect" id="moves" data-toc="Движения">
      <div className="sect-h">
        <h3 className="h2">Движения склада</h3>
        <span className="chip">{movements.length}</span>
        <span className="sp" />
      </div>
      {movements.length === 0 ? (
        <div className="empty">
          <b>Движений нет</b>
          Приходы, списания и перемещения по этому складу появятся здесь.
        </div>
      ) : (
        <div className="rows">
          {movements.map((m) => (
            <div className="row" key={m.id}>
              <span className="when">{m.dt}</span>
              <span className="pill">{ДВИЖЕНИЕ[m.kind] ?? m.kind}</span>
              <div className="t">
                <Link href={`/card/${m.ingredientId}`}>{m.ingredientName}</Link>
                {m.supplier ? ` · ${m.supplier}` : ""}
                {m.note ? ` — ${m.note}` : ""}
              </div>
              <span className="pill mono">
                {m.qty.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} {m.unit}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Место: аппараты на точке ─────────────────────────────────────────────────

export interface PlacementRow {
  id: string;
  entityId: string;
  machineName: string;
  machineRef: string | null;
  startDate: string | null;
  endDate: string | null;
}

export function PlacePlacements({ rows }: { rows: PlacementRow[] }) {
  const сейчас = rows.filter((r) => r.endDate === null);
  const история = rows.filter((r) => r.endDate !== null);
  return (
    <div className="sect" id="placements" data-toc="Аппараты">
      <div className="sect-h">
        <h3 className="h2">Аппараты на точке</h3>
        <span className="chip">{сейчас.length}</span>
        <span className="sp" />
      </div>
      {сейчас.length === 0 && история.length === 0 ? (
        <div className="empty">
          <b>Аппаратов не было</b>
          Привязка аппарата к точке делается с его карточки или из «Кофе-бункеров».
        </div>
      ) : (
        <>
          <div className="rows">
            {сейчас.map((r) => (
              <div className="row" key={r.id}>
                <div className="t">
                  <Link href={`/card/${r.entityId}`}>{r.machineName}</Link>
                  {r.machineRef && <span className="pill mono"> {r.machineRef}</span>}
                </div>
                <span className="when">с {r.startDate ?? "неизвестной даты"}</span>
              </div>
            ))}
          </div>
          {история.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="hint">Стояли раньше · {история.length}</summary>
              <div className="rows">
                {история.map((r) => (
                  <div className="row" key={r.id}>
                    <div className="t">
                      <Link href={`/card/${r.entityId}`}>{r.machineName}</Link>
                    </div>
                    <span className="when">
                      {r.startDate ?? "?"} → {r.endDate}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

// ── Поставщик: что поставляет ────────────────────────────────────────────────

export interface SupplierProductRow {
  productId: string;
  productName: string;
  purchasePrice: number | null;
}

export function SupplierProducts({ rows }: { rows: SupplierProductRow[] }) {
  return (
    <div className="sect" id="supplies" data-toc="Поставки">
      <div className="sect-h">
        <h3 className="h2">Что поставляет</h3>
        <span className="chip">{rows.length}</span>
        <span className="sp" />
      </div>
      {rows.length === 0 ? (
        // Поставщик в карточке товара — текстовое поле; связь по имени.
        <div className="empty">
          <b>Товары не привязаны</b>
          У товара поставщик указывается полем «поставщик» — совпадение по имени
          свяжет его с этой карточкой.
        </div>
      ) : (
        <div className="rows">
          {rows.map((r) => (
            <div className="row" key={r.productId}>
              <div className="t">
                <Link href={`/card/${r.productId}`}>{r.productName}</Link>
              </div>
              <span className="pill mono">
                {r.purchasePrice !== null ? сум(r.purchasePrice) : "цена покупки не заведена"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Запчасть: экземпляры на автоматах ────────────────────────────────────────

export function ComponentInstances({ rows }: { rows: PartHistoryRowT[] }) {
  const сейчас = rows.filter((r) => r.removedOn === null);
  const история = rows.filter((r) => r.removedOn !== null);
  return (
    <div className="sect" id="instances" data-toc="Экземпляры">
      <div className="sect-h">
        <h3 className="h2">Экземпляры в учёте</h3>
        <span className="chip">{сейчас.length}</span>
        <span className="sp" />
      </div>
      {rows.length === 0 ? (
        // Связь — по серийнику (поле «серийник») и модели (поле «модель» или
        // имя карточки): появится сама, как только узел этой модели пройдёт
        // через замену/установку у техника или с карточки автомата.
        <div className="empty">
          <b>Экземпляров в учёте нет</b>
          Учёт экземпляров ведут замены и установки узлов. Совпадение по серийнику
          или модели свяжет их с этой карточкой автоматически.
        </div>
      ) : (
        <>
          <div className="rows">
            {сейчас.map((r) => (
              <div className="row" key={r.id}>
                <div className="t">
                  {r.machineId ? (
                    <Link href={`/card/${r.machineId}`}>{r.machineName ?? "автомат"}</Link>
                  ) : (
                    partLocationLabel(r.location)
                  )}
                  {r.serialNumber && <span className="pill mono"> {r.serialNumber}</span>}
                  {r.slot !== null && <span className="pill">№{r.slot}</span>}
                </div>
                <span className="when">с {r.installedOn}</span>
              </div>
            ))}
          </div>
          {история.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="hint">Прошлые периоды · {история.length}</summary>
              <div className="rows">
                {история.map((r) => (
                  <div className="row" key={r.id}>
                    <div className="t">
                      {r.machineId ? (
                        <Link href={`/card/${r.machineId}`}>{r.machineName ?? "автомат"}</Link>
                      ) : (
                        partLocationLabel(r.location)
                      )}
                      {r.serialNumber && <span className="pill mono"> {r.serialNumber}</span>}
                    </div>
                    <span className="when">
                      {r.installedOn} → {r.removedOn}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
