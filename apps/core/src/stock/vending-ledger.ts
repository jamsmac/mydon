import { Inject, Injectable } from "@nestjs/common";
import { auditLog, entity, stockMovement, vendingProduct, vendingStock } from "@mydon/db";
import { and, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { settingValue } from "../system/settings";

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

export interface VendingParityRow {
  productName: string;
  productId: string | null;
  cardId: string | null;
  table: number;
  ledger: number | null;
  diff: number | null;
}

/** Сверка проекции с леджером — по каждому товару; `mismatched` — сколько разошлось, `unlinked` — без карточки. */
export async function vendingParity(db: Writer): Promise<{ warehouseId: string | null; rows: VendingParityRow[]; mismatched: number; unlinked: number }> {
  const warehouseId = await centralWarehouseId(db);
  const table = await db.select().from(vendingStock);
  const rows: VendingParityRow[] = [];
  for (const r of table) {
    const cardId = r.productId ? await cardIdOf(db, r.productId) : null;
    const ledger = warehouseId && cardId ? await ledgerQty(db, warehouseId, cardId) : null;
    rows.push({
      productName: r.productName,
      productId: r.productId,
      cardId,
      table: r.quantity,
      ledger,
      diff: ledger === null ? null : Math.round((r.quantity - ledger) * 1000) / 1000,
    });
  }
  rows.sort((a, b) => a.productName.localeCompare(b.productName, "ru"));
  return {
    warehouseId,
    rows,
    mismatched: rows.filter((r) => r.diff !== null && r.diff !== 0).length,
    unlinked: rows.filter((r) => r.cardId === null).length,
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
