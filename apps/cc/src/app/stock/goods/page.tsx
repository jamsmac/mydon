import Link from "next/link";
import { core, CoreUnavailable, type VendingParity } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { VendingCardsButton } from "../../../components/vending-cards-button";
import { ParityStatusPill } from "../../../components/parity-status";

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
          {parity.warehouseId
            ? ""
            : ` Центральный склад не выбран — ${parity.noWarehouse} поз. без сверки; пометь склад «приём по умолчанию» в карточке склада.`}{" "}
          Позиций прайса: {parity.products} · без строки в таблице: {parity.missingRows} · расхождений: {parity.mismatched} · без карточки реестра: {parity.unlinked}.
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
            <b>Позиций прайса нет</b>
            Заведи товары в прайсе вендинга.
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
                    <td className="mono">{r.table ?? "—"}</td>
                    <td className="mono">{r.ledger ?? "—"}</td>
                    <td>
                      <ParityStatusPill status={r.status} diff={r.diff} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Разница = строка − леджер. Ненулевая после первого пересчёта значит ручное движение мимо проекции или заливку до заведения карточки — второй пересчёт выравнивает.
          Строка «нет строки в таблице» с ненулевым леджером — расхождение: таблицу восстанавливает пересчёт из бота или импорт.
        </p>
      </section>
    </>
  );
}
