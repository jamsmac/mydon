import { productKind } from "@mydon/shared";
import type { CoreClient, EntityRow } from "./core-client";

/**
 * Вкладки «Сырьё / Товары» для складских мастеров (приход, инвентаризация) —
 * спека vendhub-parts, R-PU-10, У6. Один леджер для сырья и товаров на
 * перепродажу; рецептурные товары сюда не попадают — их не приходуют.
 */
export type StockTab = "ing" | "prod";

export const STOCK_TAB_LABELS: Record<StockTab, string> = { ing: "🥛 Сырьё", prod: "🍫 Товары" };

/** Карточки вкладки: ингредиенты или товары на перепродажу. */
export async function stockTabItems(core: CoreClient, tab: StockTab): Promise<EntityRow[]> {
  if (tab === "ing") return core.ingredients();
  const products = await core.searchEntities({ domain: "vendhub", type: "product" });
  return products.filter((p) => productKind(p.attrs) === "перепродажа");
}

/** Ряд переключателя вкладок: текущая помечена точкой, callback — `<prefix>:tab:<tab>`. */
export function stockTabRow(prefix: string, current: StockTab): { text: string; callback_data: string }[] {
  return (["ing", "prod"] as StockTab[]).map((t) => ({
    text: `${t === current ? "• " : ""}${STOCK_TAB_LABELS[t]}`,
    callback_data: `${prefix}:tab:${t}`,
  }));
}

export function parseStockTab(prefix: string, data: string): StockTab | null {
  const m = new RegExp(`^${prefix}:tab:(ing|prod)$`).exec(data);
  return m ? (m[1] as StockTab) : null;
}

/** Слово для сообщений: «ингредиент» / «товар». */
export function stockTabNoun(tab: StockTab): string {
  return tab === "prod" ? "товар" : "ингредиент";
}
