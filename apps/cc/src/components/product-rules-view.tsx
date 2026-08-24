import { core, type VendingProductRow } from "../lib/core";
import { ProductRulesPanel } from "./product-rules-panel";

/**
 * Лист «Правила закупа» (П5a): один поход в Core за прайсом с правилами
 * закупа — расчёт и хранение целиком в ядре, здесь только форма правки
 * (см. `PurchasePlanView` для того же приёма — try/catch → «недоступен»).
 */
export async function ProductRulesView({ domain }: { domain: string }) {
  let products: VendingProductRow[];
  try {
    products = await core.vendingProducts();
  } catch {
    return (
      <div className="empty">
        <b>Правила недоступны</b>
        Core не ответил — обнови страницу.
      </div>
    );
  }
  return <ProductRulesPanel domain={domain} products={products} />;
}
