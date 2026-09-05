import { Inject, Injectable } from "@nestjs/common";
import { auditLog, entity, stockMovement, vendingAlias, vendingProduct, vendingStock, vendingStockCount } from "@mydon/db";
import { normalizeProductName, productIndex, resolveCatalogName } from "@mydon/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { settingValue } from "../system/settings";
import { assembleGoodsStock, parityRows, type GoodsStock, type VendingParityRow } from "./goods-stock";
export type { GoodsStock, GoodsStockRow, VendingParityRow, VendingParityStatus } from "./goods-stock";

/**
 * `vending_stock` как проекция складского леджера (R-PU-10, У6).
 *
 * До катовера — двойная запись: каждое изменение строки `vending_stock`
 * (приёмка накладной, заливка, отмена, пересчёт) параллельно ложится
 * движением `stock_movement` по карточке товара на центральном складе.
 * Сверка `vendingParity()` показывает расхождения; когда неделя нулевая —
 * тумблер VENDING_STOCK_SOURCE=ledger переключает чтение на леджер.
 *
 * Функции принимают транзакцию вызывающего: двойная запись живёт в той же
 * транзакции, что и строка проекции, — иначе сбой между ними разводил бы их.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Writer = Tx | Db;

export interface VendingMovementInput {
  productId: string | null;
  productName: string;
  kind: "intake" | "consumption" | "adjustment";
  /** Штуки; у `adjustment` со знаком (стало − было). */
  qty: number;
  dt?: string;
  note?: string | null;
  /** Ключ идемпотентности — повтор той же операции движения не плодит. */
  clientKey: string;
  createdBy?: string | null;
  source?: string;
}

/**
 * Центральный склад: помеченный «приём по умолчанию»; нет пометки, но склад
 * один — он. Несколько без пометки — null (двойная запись молча пропускается,
 * сверка это покажет).
 */
export async function centralWarehouseId(tx: Writer): Promise<string | null> {
  const whs = await tx.select({ id: entity.id, attrs: entity.attrs }).from(entity).where(eq(entity.type, "warehouse"));
  const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && ["да", "yes", "true", "1"].includes(v.trim().toLowerCase()));
  const flagged = whs.find((w) => truthy((w.attrs as Record<string, unknown> | null)?.["приём по умолчанию"]));
  if (flagged) return flagged.id;
  return whs.length === 1 ? whs[0].id : null;
}

function tashkentDay(d: Date): string {
  return new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Карточка реестра для товара прайса: мост `vending_product.entity_id`.
 * Движения леджера живут по карточкам `entity`, а `vending_stock.product_id`
 * указывает на прайс — без моста класть движение некуда.
 */
export async function cardIdOf(tx: Writer, vendingProductId: string): Promise<string | null> {
  const [row] = await tx.select({ entityId: vendingProduct.entityId }).from(vendingProduct).where(eq(vendingProduct.id, vendingProductId)).limit(1);
  return row?.entityId ?? null;
}

/** Остаток по леджеру на складе, шт: `cardId` — карточка реестра (не прайс). */
export async function ledgerQty(tx: Writer, warehouseId: string, cardId: string): Promise<number> {
  const [row] = await tx
    .select({
      q: sql<string>`coalesce(sum(case
        when ${stockMovement.kind} in ('intake','return') then ${stockMovement.qty}
        when ${stockMovement.kind} = 'consumption' then -${stockMovement.qty}
        when ${stockMovement.kind} = 'adjustment' then ${stockMovement.qty}
        when ${stockMovement.kind} = 'transfer' and ${stockMovement.warehouseId} = ${warehouseId} then -${stockMovement.qty}
        when ${stockMovement.kind} = 'transfer' and ${stockMovement.counterpartyId} = ${warehouseId} then ${stockMovement.qty}
        else 0 end), 0)`,
    })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.ingredientId, cardId),
        sql`(${stockMovement.warehouseId} = ${warehouseId} or ${stockMovement.counterpartyId} = ${warehouseId})`,
      ),
    );
  return Number(row?.q ?? 0);
}

/**
 * Остатки по МНОГИМ карточкам одним запросом (R-GS-7): план закупа зовёт
 * выдачу на каждую сводку, и 52 запроса по одной карточке — это 52 обращения
 * к базе там, где хватает одного `group by`. Арифметика та же, что у `ledgerQty`.
 */
export async function ledgerQtyMany(tx: Writer, warehouseId: string, cardIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (cardIds.length === 0) return out;
  const rows = await tx
    .select({
      cardId: stockMovement.ingredientId,
      q: sql<string>`coalesce(sum(case
        when ${stockMovement.kind} in ('intake','return') then ${stockMovement.qty}
        when ${stockMovement.kind} = 'consumption' then -${stockMovement.qty}
        when ${stockMovement.kind} = 'adjustment' then ${stockMovement.qty}
        when ${stockMovement.kind} = 'transfer' and ${stockMovement.warehouseId} = ${warehouseId} then -${stockMovement.qty}
        when ${stockMovement.kind} = 'transfer' and ${stockMovement.counterpartyId} = ${warehouseId} then ${stockMovement.qty}
        else 0 end), 0)`,
    })
    .from(stockMovement)
    .where(
      and(
        inArray(stockMovement.ingredientId, [...cardIds]),
        sql`(${stockMovement.warehouseId} = ${warehouseId} or ${stockMovement.counterpartyId} = ${warehouseId})`,
      ),
    )
    .groupBy(stockMovement.ingredientId);
  for (const r of rows) if (r.cardId) out.set(r.cardId, Number(r.q ?? 0));
  return out;
}

/**
 * Последний пересчёт по товару — из истории `vending_stock_count` (R-GS-6):
 * без сторно и без отменённых сторно строк (то же условие «видимой строки», что у
 * `GET /vending/stock-counts`). По `product_id`, и отдельно по имени — для строк
 * истории до бэкфилла П4, у которых `product_id` пуст.
 */
export async function lastCountedByProduct(tx: Writer): Promise<{ byId: Map<string, Date>; byName: Map<string, Date> }> {
  const видимая = and(
    ne(vendingStockCount.source, "storno"),
    sql`not exists (select 1 from ${vendingStockCount} s2 where s2.source = 'storno' and s2.reverses_id = ${vendingStockCount.id})`,
  );
  const rows = await tx
    .select({
      productId: vendingStockCount.productId,
      productName: vendingStockCount.productName,
      // `::text` уравнивает драйверы: postgres-js отдаёт `date` JS-объектом
      // `Date` (String(...) даёт «Wed Sep 02 2026 …», .slice(0,10) — мусор,
      // и дальше Invalid Date), pglite — строкой; текстом оба возвращают строку.
      last: sql<string>`max(${vendingStockCount.dt})::text`,
    })
    .from(vendingStockCount)
    .where(видимая)
    .groupBy(vendingStockCount.productId, vendingStockCount.productName);
  const byId = new Map<string, Date>();
  const byName = new Map<string, Date>();
  const later = (m: Map<string, Date>, k: string, d: Date) => {
    const prev = m.get(k);
    if (!prev || d > prev) m.set(k, d);
  };
  for (const r of rows) {
    // `dt` — ташкентские сутки. Берём ПОЛДЕНЬ этих суток по Ташкенту (07:00Z):
    // полночь +05:00 — это 19:00Z предыдущего дня, и `toISOString().slice(0, 10)`
    // у панели и смоука показывал бы «вчера». Для сторожа давности (дни) разницы нет.
    const d = new Date(`${String(r.last).slice(0, 10)}T12:00:00+05:00`);
    if (r.productId) later(byId, r.productId, d);
    later(byName, normalizeProductName(r.productName), d);
  }
  return { byId, byName };
}

/**
 * Одна дверь к остаткам товаров (R-GS-1): список — прайс, остаток — леджер по
 * центральному складу, дата — история пересчётов. Три запроса на выдачу.
 */
export async function goodsStock(tx: Writer, opts: { includeInactive?: boolean } = {}): Promise<GoodsStock> {
  const warehouseId = await centralWarehouseId(tx);
  const products = await tx
    .select({ id: vendingProduct.id, name: vendingProduct.name, entityId: vendingProduct.entityId, isActive: vendingProduct.isActive })
    .from(vendingProduct);
  const cardIds = products.map((p) => p.entityId).filter((x): x is string => x !== null);
  const [qtyByCard, counted] = await Promise.all([
    warehouseId ? ledgerQtyMany(tx, warehouseId, cardIds) : Promise.resolve(new Map<string, number>()),
    lastCountedByProduct(tx),
  ]);
  return assembleGoodsStock({
    warehouseId,
    products,
    qtyByCard,
    countedById: counted.byId,
    countedByName: counted.byName,
    ...(opts.includeInactive ? { includeInactive: true } : {}),
  });
}

/**
 * Двойная запись одного изменения проекции. Без карточки товара или без
 * центрального склада — ничего не пишет и возвращает причину: строка
 * `vending_stock` ключуется именем, а леджер — карточкой, и без связи
 * движение положить некуда.
 */
export async function projectVendingMovement(
  tx: Writer,
  input: VendingMovementInput,
): Promise<{ written: boolean; movementId: string | null; reason: string | null }> {
  if (!input.productId) return { written: false, movementId: null, reason: `«${input.productName}»: товара нет в прайсе` };
  if (input.qty === 0) return { written: false, movementId: null, reason: null };
  const cardId = await cardIdOf(tx, input.productId);
  if (!cardId) return { written: false, movementId: null, reason: `«${input.productName}»: у товара нет карточки реестра (POST /stock/vending-cards)` };
  const warehouseId = await centralWarehouseId(tx);
  if (!warehouseId) return { written: false, movementId: null, reason: "центральный склад не выбран («приём по умолчанию»)" };
  // Приход/расход — модулем, знак задаёт вид; корректировка — как есть.
  const qty = input.kind === "adjustment" ? input.qty : Math.abs(input.qty);
  const [row] = await tx
    .insert(stockMovement)
    .values({
      kind: input.kind,
      ingredientId: cardId,
      warehouseId,
      dt: input.dt ?? tashkentDay(new Date()),
      qty: String(qty),
      unit: "шт",
      source: input.source ?? "vending",
      note: input.note ?? null,
      clientKey: input.clientKey,
      createdBy: input.createdBy ?? "system",
    })
    .onConflictDoNothing({ target: stockMovement.clientKey })
    .returning({ id: stockMovement.id });
  return { written: !!row, movementId: row?.id ?? null, reason: null };
}

/**
 * Пересчёт как корректировка леджера: дельта считается от ОСТАТКА ЛЕДЖЕРА,
 * а не строки проекции — до катовера они законно расходятся, и первый
 * пересчёт кладёт в леджер стартовый остаток целиком.
 */
export async function projectVendingCount(
  tx: Writer,
  input: { productId: string | null; productName: string; counted: number; dt?: string; clientKey: string; createdBy?: string | null; note?: string | null },
): Promise<{ written: boolean; delta: number; reason: string | null }> {
  if (!input.productId) return { written: false, delta: 0, reason: `«${input.productName}»: товара нет в прайсе` };
  const cardId = await cardIdOf(tx, input.productId);
  if (!cardId) return { written: false, delta: 0, reason: `«${input.productName}»: у товара нет карточки реестра (POST /stock/vending-cards)` };
  const warehouseId = await centralWarehouseId(tx);
  if (!warehouseId) return { written: false, delta: 0, reason: "центральный склад не выбран («приём по умолчанию»)" };
  const before = await ledgerQty(tx, warehouseId, cardId);
  const delta = Math.round((input.counted - before) * 1000) / 1000;
  if (delta === 0) return { written: false, delta: 0, reason: null };
  const res = await projectVendingMovement(tx, {
    productId: input.productId,
    productName: input.productName,
    kind: "adjustment",
    qty: delta,
    dt: input.dt,
    note: input.note ?? `пересчёт: было ${before}, стало ${input.counted}`,
    clientKey: input.clientKey,
    createdBy: input.createdBy ?? null,
    source: "vending-count",
  });
  return { written: res.written, delta, reason: res.reason };
}

export interface VendingParityReport {
  warehouseId: string | null;
  rows: VendingParityRow[];
  /** Расхождений по правилу §6 спеки: mismatch, inactive_with_stock, no_row с ненулевым леджером. */
  mismatched: number;
  /** Строк без карточки реестра (как раньше). */
  unlinked: number;
  /** Позиций прайса без строки в таблице — факт о таблице, виден всегда. */
  missingRows: number;
  /** Позиций прайса в сверке. */
  products: number;
  /**
   * Карточных позиций без выбранного центрального склада (`status = "no_warehouse"`).
   * Без склада ВСЕ карточные строки не расхождение (`isMismatch=false`) и не
   * `missingRows` — сверка выглядит зелёной, ничего не проверив. Этот счётчик —
   * единственное место, где «склад не выбран» видно в самом отчёте.
   */
  noWarehouse: number;
}

/**
 * Сверка проекции с леджером по ОБЪЕДИНЕНИЮ прайса и таблицы (R-GS-5): пустая
 * таблица при непустом леджере даёт расхождения, а не «0 из 0».
 */
export async function vendingParity(db: Writer): Promise<VendingParityReport> {
  const [goods, table, products, aliases] = await Promise.all([
    goodsStock(db, { includeInactive: true }),
    // Порядок строк таблицы фиксирован именем: без него две строки на одну
    // позицию (легаси до бэкфилла П4) занимали бы её в случайном порядке.
    db
      .select({ productName: vendingStock.productName, productId: vendingStock.productId, quantity: vendingStock.quantity })
      .from(vendingStock)
      .orderBy(asc(vendingStock.productName)),
    db.select({ id: vendingProduct.id, name: vendingProduct.name }).from(vendingProduct),
    db.select({ productId: vendingAlias.productId, alias: vendingAlias.alias }).from(vendingAlias),
  ]);
  // Дверь имени — тот же индекс и то же правило, что у приёма и бэкфилла
  // (`productIdResolver`, R-G-1): строка таблицы без product_id должна найти
  // свою позицию там же, где лежат движения леджера по этому имени. Спор и
  // промах — одинаково `null`, как у двери, что пишет необратимое.
  const index = productIndex(products, aliases);
  const resolveId = (raw: string): string | null => {
    const r = resolveCatalogName(index, raw);
    return r.kind === "hit" ? r.id : null;
  };
  const rows = parityRows(goods, table, resolveId);
  return {
    warehouseId: goods.warehouseId,
    rows,
    mismatched: rows.filter((r) => r.isMismatch).length,
    unlinked: rows.filter((r) => r.status === "no_card").length,
    missingRows: rows.filter((r) => r.status === "no_row").length,
    products: rows.filter((r) => r.productId !== null).length,
    noWarehouse: rows.filter((r) => r.status === "no_warehouse").length,
  };
}

export interface EnsureCardsReport {
  linked: string[];
  created: string[];
  ambiguous: string[];
  already: number;
}

/**
 * Карточки реестра для всех активных товаров прайса: есть карточка того же
 * имени (product, «перепродажа») — связать; нет — завести (единица «шт»,
 * цена покупки из прайса). Двусмысленность (две карточки одного имени) —
 * не выбираем, называем. Идемпотентно: повторный прогон ничего не плодит.
 */
export async function ensureProductCards(db: Writer, opts: { dryRun?: boolean; actorRef?: string } = {}): Promise<EnsureCardsReport> {
  const actorRef = opts.actorRef ?? "owner";
  const products = await db.select().from(vendingProduct).where(eq(vendingProduct.isActive, true));
  const cards = await db.select({ id: entity.id, name: entity.name, attrs: entity.attrs }).from(entity).where(eq(entity.type, "product"));
  const byName = new Map<string, string[]>();
  for (const c of cards) {
    const kind = (c.attrs as Record<string, unknown> | null)?.["вид"];
    if (kind !== "перепродажа") continue;
    const key = c.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), c.id]);
  }
  const report: EnsureCardsReport = { linked: [], created: [], ambiguous: [], already: 0 };
  for (const p of products) {
    if (p.entityId) {
      report.already += 1;
      continue;
    }
    const found = byName.get(p.name.trim().toLowerCase()) ?? [];
    if (found.length > 1) {
      report.ambiguous.push(p.name);
      continue;
    }
    let cardId = found[0] ?? null;
    if (!cardId) {
      report.created.push(p.name);
      if (opts.dryRun) continue;
      const [card] = await db
        .insert(entity)
        .values({
          type: "product",
          name: p.name,
          attrs: {
            вид: "перепродажа",
            единица: "шт",
            ...(p.purchasePrice != null ? { "цена покупки": Number(p.purchasePrice) } : {}),
            ...(p.salePrice != null ? { "цена продажи": Number(p.salePrice) } : {}),
            ...(p.barcode ? { "штрих-код": p.barcode } : {}),
            источник: "прайс вендинга (У6)",
          },
        })
        .returning({ id: entity.id });
      cardId = card.id;
    } else {
      report.linked.push(p.name);
      if (opts.dryRun) continue;
    }
    await db.update(vendingProduct).set({ entityId: cardId }).where(eq(vendingProduct.id, p.id));
  }
  if (!opts.dryRun && (report.linked.length > 0 || report.created.length > 0)) {
    await db.insert(auditLog).values({
      actorKind: actorRef === "owner" ? "human" : "system",
      actorRef,
      action: "stock.vending_cards_ensured",
      target: "vending_product",
      after: { linked: report.linked.length, created: report.created.length, ambiguous: report.ambiguous },
    });
  }
  return report;
}

/**
 * Nest-обёртка над функциями проекции. Внедряется в вендинг как
 * `@Optional()`: сервисы вендинга в тестах строятся руками без неё, и
 * двойная запись тогда просто не происходит (как и апрувы у VendingService).
 */
@Injectable()
export class VendingLedgerService {
  constructor(@Inject(DB) private readonly db: Db) {}

  movement(tx: Writer, input: VendingMovementInput) {
    return projectVendingMovement(tx, input);
  }

  count(tx: Writer, input: Parameters<typeof projectVendingCount>[1]) {
    return projectVendingCount(tx, input);
  }

  qty(tx: Writer, warehouseId: string, cardId: string) {
    return ledgerQty(tx, warehouseId, cardId);
  }

  cardIdOf(tx: Writer, vendingProductId: string) {
    return cardIdOf(tx, vendingProductId);
  }

  centralWarehouseId(tx: Writer) {
    return centralWarehouseId(tx);
  }

  /** Одна дверь к остаткам товаров (R-GS-1). Внутри транзакции — передавать её `tx`. */
  goodsStock(tx: Writer = this.db, opts: { includeInactive?: boolean } = {}) {
    return goodsStock(tx, opts);
  }

  /**
   * Тумблер катовера VENDING_STOCK_SOURCE: `table` (проекция) или `ledger`.
   * Внутри транзакции — читать через её `tx`: на одном соединении запрос
   * мимо открытой транзакции ждёт её же и виснет.
   */
  async source(tx: Writer = this.db): Promise<"table" | "ledger"> {
    return (await settingValue(tx as Db, "VENDING_STOCK_SOURCE")).trim() === "ledger" ? "ledger" : "table";
  }

  parity() {
    return vendingParity(this.db);
  }

  ensureCards(opts: { dryRun?: boolean; actorRef?: string } = {}) {
    return ensureProductCards(this.db, opts);
  }
}
