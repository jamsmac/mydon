import Link from "next/link";
import { core, CoreUnavailable, type VendingParity } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { VendingCardsButton } from "../../../components/vending-cards-button";

export const dynamic = "force-dynamic";

/**
 * Товары на складе (У6): сверка строки `vending_stock` с леджером по карточке
 * товара на центральном складе. Нулевая неделю — можно переключать
 * VENDING_STOCK_SOURCE=ledger в настройках системы.
 */
export default async function StockGoodsPage() {
  let parity: VendingParity;
  let source = "table";
  try {
    const [p, config] = await Promise.all([core.vendingParity(), core.systemConfig().catch(() => [])]);
    parity = p;
    const item = config.find((c) => c.key === "VENDING_STOCK_SOURCE");
    source = item ? (item.effective ?? item.value) : "table";
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  const ledgerMode = source.trim() === "ledger";
  return (
    <>
      <div className="page-head">
        <Link href="/parts" className="back">
          ← Узлы
        </Link>
        <h1>Товары на складе: сверка с леджером</h1>
        <p>
          Источник остатка сейчас: <b>{ledgerMode ? "леджер (катовер сделан)" : "строка vending_stock (двойная запись)"}</b>.
          {parity.warehouseId ? "" : " Центральный склад не выбран — пометь склад «приём по умолчанию» в карточке склада."}{" "}
          Расхождений: {parity.mismatched} · без карточки реестра: {parity.unlinked} · товаров: {parity.rows.length}.
        </p>
      </div>

      <section className="group-block">
        <div className="section-title">Карточки реестра для прайса</div>
        <p className="hint">Движения леджера живут по карточкам реестра (товар «на перепродажу»); прайс вендинга ключуется именем. Мост заводится один раз.</p>
        <VendingCardsButton />
      </section>

      <section className="group-block">
        <div className="section-title">
          Сверка по товарам
          <span className="group-count">{parity.rows.length}</span>
        </div>
        {parity.rows.length === 0 ? (
          <div className="empty">
            <b>Строк склада нет</b>
            Первый пересчёт — из бота («🧮 Инвентаризация», вкладка «Товары») или импортом `tools/import-warehouse-json.mjs`.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>vending_stock</th>
                  <th>леджер</th>
                  <th>разница</th>
                </tr>
              </thead>
              <tbody>
                {parity.rows.map((r) => (
                  <tr key={r.productName}>
                    <td>{r.cardId ? <Link href={`/card/${r.cardId}`}>{r.productName}</Link> : r.productName}</td>
                    <td className="mono">{r.table}</td>
                    <td className="mono">{r.ledger ?? "—"}</td>
                    <td>
                      {r.diff === null ? (
                        <span className="pill act">{r.cardId ? "склад не выбран" : "нет карточки"}</span>
                      ) : r.diff === 0 ? (
                        <span className="pill ok">сходится</span>
                      ) : (
                        <span className="pill bad">{r.diff > 0 ? `+${r.diff}` : r.diff}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Разница = строка − леджер. Ненулевая после первого пересчёта значит ручное движение мимо проекции или заливку до заведения карточки — второй пересчёт выравнивает.
        </p>
      </section>
    </>
  );
}
