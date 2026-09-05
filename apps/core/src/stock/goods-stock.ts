import { normalizeProductName } from "@mydon/shared";

/**
 * Остатки товаров — ОДНА ДВЕРЬ (R-GS-1, спека 2026-09-05).
 *
 * Здесь только сборка и правила: список позиций — прайс (R-GS-2), «неизвестно»
 * ≠ ноль (R-GS-3), дата — из истории пересчётов (R-GS-6). SQL живёт рядом, в
 * `vending-ledger.ts`, и проверяется на настоящем Postgres в CI; правила —
 * здесь, на заглушке, потому что их можно и нужно читать без базы.
 */
export interface GoodsStockRow {
  productName: string;
  productId: string;
  cardId: string | null;
  /** Остаток по леджеру; null — неизвестно: нет карточки склада или не выбран центральный склад. */
  quantity: number | null;
  /** Последний пересчёт из истории (`vending_stock_count`), null — ни разу не считали. */
  countedAt: Date | null;
  isActive: boolean;
}

export interface GoodsStock {
  warehouseId: string | null;
  rows: GoodsStockRow[];
  asOf: Date | null;
}

export interface GoodsStockInput {
  warehouseId: string | null;
  products: { id: string; name: string; entityId: string | null; isActive: boolean }[];
  qtyByCard: Map<string, number>;
  countedById: Map<string, Date>;
  countedByName: Map<string, Date>;
  includeInactive?: boolean;
}

export function assembleGoodsStock(input: GoodsStockInput): GoodsStock {
  const rows: GoodsStockRow[] = [];
  for (const p of input.products) {
    if (!p.isActive && !input.includeInactive) continue;
    // Ноль — «карточка есть, склад выбран, движений нет». Без карточки или без
    // склада остаток НЕИЗВЕСТЕН, и закуп не имеет права вычитать ноль.
    const quantity = input.warehouseId && p.entityId ? (input.qtyByCard.get(p.entityId) ?? 0) : null;
    const countedAt = input.countedById.get(p.id) ?? input.countedByName.get(normalizeProductName(p.name)) ?? null;
    rows.push({ productName: p.name, productId: p.id, cardId: p.entityId, quantity, countedAt, isActive: p.isActive });
  }
  rows.sort((a, b) => a.productName.localeCompare(b.productName, "ru"));
  const asOf = rows.reduce<Date | null>((acc, r) => (r.countedAt && (!acc || r.countedAt > acc) ? r.countedAt : acc), null);
  return { warehouseId: input.warehouseId, rows, asOf };
}

export type VendingParityStatus = "ok" | "mismatch" | "no_row" | "no_card" | "inactive_with_stock" | "no_warehouse";

export interface VendingParityRow {
  productName: string;
  productId: string | null;
  cardId: string | null;
  table: number | null;
  ledger: number | null;
  diff: number | null;
  status: VendingParityStatus;
  isMismatch: boolean;
}

export interface TableStockRow {
  productName: string;
  productId: string | null;
  quantity: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Сверка по ОБЪЕДИНЕНИЮ прайса и строк таблицы (R-GS-5).
 *
 * Строка таблицы ищет свою позицию по `product_id`, без него — через ДВЕРЬ
 * имени `resolveId` (тот же резолвер, что кладёт движения в леджер; R-G-1).
 * Позиция без строки —
 * `no_row`: это факт о таблице, он виден всегда; расхождением считается только
 * когда в леджере не ноль. Пустая таблица при непустом леджере поэтому не может
 * дать «расхождений 0» — гейт катовера снова что-то проверяет.
 */
export function parityRows(goods: GoodsStock, table: TableStockRow[], resolveId: (raw: string) => string | null): VendingParityRow[] {
  const byId = new Map(goods.rows.map((r) => [r.productId, r]));
  // Строка без `product_id` ложится ТУДА ЖЕ, куда дверь кладёт движения по
  // этому имени. Своего правила сопоставления у сверки нет намеренно: при двух
  // позициях прайса с одним нормализованным ключом «первая по коллации» или
  // «активная» — это уже другое правило, и строка с леджером разъезжались бы по
  // разным позициям: сходящаяся таблица давала бы пару фантомных расхождений.
  // Спор и промах у двери — `null`: строка остаётся сиротой, видимой.
  //
  // Строка таблицы занимает позицию в ДВА прохода: сначала те, что связаны с
  // прайсом по `product_id`, потом остальные — через дверь имени. Иначе строка,
  // сопоставленная лишь по имени, могла бы занять позицию раньше строки с
  // настоящей связью, и та ушла бы в сироты. Вторая строка на ту же позицию —
  // сирота: видимая, а не потерянная.
  const tableByProduct = new Map<string, TableStockRow>();
  const orphans: TableStockRow[] = [];
  const claim = (t: TableStockRow, p: GoodsStockRow | undefined): boolean => {
    if (!p || tableByProduct.has(p.productId)) return false;
    tableByProduct.set(p.productId, t);
    return true;
  };
  const byName: TableStockRow[] = [];
  for (const t of table) {
    if (t.productId && byId.has(t.productId)) {
      if (!claim(t, byId.get(t.productId))) orphans.push(t);
    } else byName.push(t);
  }
  for (const t of byName) {
    const id = resolveId(t.productName);
    if (!claim(t, id === null ? undefined : byId.get(id))) orphans.push(t);
  }
  const out: VendingParityRow[] = [];
  for (const p of goods.rows) {
    const t = tableByProduct.get(p.productId) ?? null;
    const ledger = p.quantity;
    // Неактивная позиция без остатка и без строки — не тема сверки (R-GS-2).
    if (!p.isActive && !t && !(ledger !== null && ledger !== 0)) continue;
    let status: VendingParityStatus;
    let diff: number | null = null;
    if (goods.warehouseId === null && p.cardId !== null) status = "no_warehouse";
    else if (p.cardId === null) status = "no_card";
    else if (t === null) status = "no_row";
    else if (!p.isActive && ledger !== null && ledger !== 0) status = "inactive_with_stock";
    else {
      diff = ledger === null ? null : round3(t.quantity - ledger);
      status = diff === 0 ? "ok" : "mismatch";
    }
    const isMismatch = status === "mismatch" || status === "inactive_with_stock" || (status === "no_row" && ledger !== null && ledger !== 0);
    out.push({ productName: p.productName, productId: p.productId, cardId: p.cardId, table: t?.quantity ?? null, ledger, diff, status, isMismatch });
  }
  for (const o of orphans) {
    // `productId` сироты — либо висячий (позиции нет в прайсе), либо дубль на
    // уже занятую позицию: в обоих случаях это НЕ позиция прайса, и счётчик
    // `products` её не считает.
    out.push({ productName: o.productName, productId: null, cardId: null, table: o.quantity, ledger: null, diff: null, status: "no_card", isMismatch: false });
  }
  return out.sort((a, b) => a.productName.localeCompare(b.productName, "ru"));
}
