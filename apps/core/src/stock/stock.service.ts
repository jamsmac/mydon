import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { entity, rawLink, sale, stockMovement } from "@mydon/db";
import {
  consumptionReport,
  convertQty,
  isUnit,
  normalizeSourceKey,
  parseRecipe,
  productKind,
  recipeCost,
  stockBalance,
  type IngredientPrice,
  type RecipeLine,
  type SoldProduct,
  type StockMovement,
  type Unit,
} from "@mydon/shared";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/** Заявка на движение склада. */
export interface CreateMovementInput {
  kind: "intake" | "consumption" | "transfer";
  ingredientId: string;
  warehouseId: string;
  counterpartyId?: string | null;
  dt?: string;
  qty: number;
  unit: string;
  unitPrice?: number | null;
  supplier?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

type MovementRow = typeof stockMovement.$inferSelect;

/** Цена покупки ингредиента из его карточки: число-или-строка + единица. */
function readIngredientPrice(attrs: Record<string, unknown>): IngredientPrice {
  const raw = attrs["цена покупки"];
  const price =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : typeof raw === "string" && raw.trim().length > 0 && Number.isFinite(Number(raw))
        ? Number(raw)
        : null;
  const unit = isUnit(attrs["единица"]) ? (attrs["единица"] as Unit) : null;
  return { price, unit };
}

/**
 * Склад: движения сырья и остаток НА ЧТЕНИИ.
 *
 * Остаток не хранится полем — выводится из ленты движений при запросе, как и
 * себестоимость рецепта. Первый срез пишет только приход; расход (из журнала
 * продаж) и перемещение включатся своими срезами, но схема и подсчёт уже их
 * держат.
 */
@Injectable()
export class StockService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Базовая единица ингредиента: та, в которой заведена его цена покупки. */
  private baseUnitOf(attrs: Record<string, unknown>): Unit | null {
    return isUnit(attrs["единица"]) ? (attrs["единица"] as Unit) : null;
  }

  /** Проверить, что карточка есть и нужного типа. */
  private async cardOfType(id: string, type: string): Promise<typeof entity.$inferSelect> {
    const [card] = await this.db.select().from(entity).where(eq(entity.id, id));
    if (!card) throw new NotFoundException(`Карточки нет: ${id}`);
    if (card.type !== type) {
      throw new BadRequestException(`Карточка ${card.name} — не ${type}`);
    }
    return card;
  }

  /** Завести движение. Приход — с ценой; расход/перемещение пока не с экрана. */
  async createMovement(input: CreateMovementInput): Promise<MovementRow> {
    if (!(input.qty > 0)) throw new BadRequestException("Количество должно быть больше нуля");
    if (!isUnit(input.unit)) throw new BadRequestException(`Единица «${input.unit}» неизвестна`);
    const unit: Unit = input.unit;

    const ing = await this.cardOfType(input.ingredientId, "ingredient");
    await this.cardOfType(input.warehouseId, "warehouse");
    if (input.kind === "transfer") {
      if (!input.counterpartyId) {
        throw new BadRequestException("Перемещение требует встречный склад");
      }
      if (input.counterpartyId === input.warehouseId) {
        throw new BadRequestException("Склад-источник и встречный совпадают");
      }
      await this.cardOfType(input.counterpartyId, "warehouse");
    }

    // Единицу прихода сверяем с базовой единицей ингредиента: несводимую не
    // принимаем молча — иначе остаток нельзя будет посчитать честно.
    const base = this.baseUnitOf((ing.attrs ?? {}) as Record<string, unknown>);
    if (base && unit !== base && convertQty(input.qty, unit, base) === null) {
      throw new BadRequestException(
        `«${unit}» не перевести в базовую единицу ингредиента «${base}»`,
      );
    }

    const total =
      input.unitPrice != null && Number.isFinite(input.unitPrice)
        ? String(input.unitPrice * input.qty)
        : null;
    const [row] = await this.db
      .insert(stockMovement)
      .values({
        kind: input.kind,
        ingredientId: input.ingredientId,
        warehouseId: input.warehouseId,
        counterpartyId: input.kind === "transfer" ? input.counterpartyId : null,
        dt: input.dt ?? new Date().toISOString().slice(0, 10),
        qty: String(input.qty),
        unit: input.unit,
        unitPrice: input.unitPrice != null ? String(input.unitPrice) : null,
        total,
        supplier: input.supplier ?? null,
        source: "owner",
        note: input.note ?? null,
        createdBy: input.createdBy ?? "owner",
      })
      .returning();
    return row;
  }

  /** Удалить движение (правка ручного прихода). */
  async removeMovement(id: string): Promise<void> {
    const [row] = await this.db.delete(stockMovement).where(eq(stockMovement.id, id)).returning();
    if (!row) throw new NotFoundException("Движения нет");
  }

  /** Движения ингредиента: лента прихода/расхода со всеми складами. */
  private async movementsOf(where: ReturnType<typeof eq>): Promise<MovementRow[]> {
    return this.db.select().from(stockMovement).where(where).orderBy(desc(stockMovement.dt));
  }

  /** Привести строки БД к движениям для подсчёта; чужие единицы отбрасываем. */
  private toBalanceInput(rows: MovementRow[]): StockMovement[] {
    const out: StockMovement[] = [];
    for (const r of rows) {
      if (!isUnit(r.unit)) continue;
      out.push({
        kind: r.kind,
        warehouseId: r.warehouseId,
        counterpartyId: r.counterpartyId,
        qty: Number(r.qty),
        unit: r.unit,
      });
    }
    return out;
  }

  /**
   * Остаток ингредиента: сводный и по каждому складу. Считается на чтении из
   * движений; несводимые единицы честно помечены непосчитанными.
   */
  async ingredientStock(ingredientId: string): Promise<{
    ingredientId: string;
    ingredientName: string;
    baseUnit: Unit | null;
    total: number | null;
    unconvertible: number;
    warehouses: { warehouseId: string; warehouseName: string; qty: number; unconvertible: number }[];
    movements: {
      id: string;
      kind: string;
      dt: string;
      warehouseId: string;
      warehouseName: string | null;
      counterpartyId: string | null;
      counterpartyName: string | null;
      qty: number;
      unit: string;
      unitPrice: number | null;
      total: number | null;
      supplier: string | null;
      source: string;
      note: string | null;
    }[];
  }> {
    const ing = await this.cardOfType(ingredientId, "ingredient");
    const base = this.baseUnitOf((ing.attrs ?? {}) as Record<string, unknown>);
    const rows = await this.movementsOf(eq(stockMovement.ingredientId, ingredientId));

    // Имена складов, встретившихся в движениях.
    const whIds = [
      ...new Set(rows.flatMap((r) => [r.warehouseId, r.counterpartyId].filter(Boolean) as string[])),
    ];
    const whCards =
      whIds.length === 0 ? [] : await this.db.select().from(entity).where(inArray(entity.id, whIds));
    const whName = new Map(whCards.map((w) => [w.id, w.name]));

    const input = this.toBalanceInput(rows);
    const total = base ? stockBalance(input, base) : null;

    const warehouses = whIds.map((wid) => {
      const b = base ? stockBalance(input, base, wid) : { qty: 0, unconvertible: 0 };
      return {
        warehouseId: wid,
        warehouseName: whName.get(wid) ?? "склад",
        qty: b.qty,
        unconvertible: b.unconvertible,
      };
    });

    return {
      ingredientId,
      ingredientName: ing.name,
      baseUnit: base,
      total: total ? total.qty : null,
      unconvertible: total ? total.unconvertible : 0,
      warehouses,
      movements: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        dt: String(r.dt),
        warehouseId: r.warehouseId,
        warehouseName: whName.get(r.warehouseId) ?? null,
        counterpartyId: r.counterpartyId,
        counterpartyName: r.counterpartyId ? whName.get(r.counterpartyId) ?? null : null,
        qty: Number(r.qty),
        unit: r.unit,
        unitPrice: r.unitPrice != null ? Number(r.unitPrice) : null,
        total: r.total != null ? Number(r.total) : null,
        supplier: r.supplier,
        source: r.source,
        note: r.note,
      })),
    };
  }

  /**
   * Остаток склада: каждый ингредиент, что через него проходил, и сколько лежит
   * сейчас. Остаток в базовой единице ингредиента.
   */
  async warehouseStock(warehouseId: string): Promise<{
    warehouseId: string;
    warehouseName: string;
    items: {
      ingredientId: string;
      ingredientName: string;
      baseUnit: Unit | null;
      qty: number | null;
      unconvertible: number;
    }[];
  }> {
    const wh = await this.cardOfType(warehouseId, "warehouse");
    const rows = await this.movementsOf(
      or(eq(stockMovement.warehouseId, warehouseId), eq(stockMovement.counterpartyId, warehouseId))!,
    );

    const ingIds = [...new Set(rows.map((r) => r.ingredientId))];
    const ingCards =
      ingIds.length === 0 ? [] : await this.db.select().from(entity).where(inArray(entity.id, ingIds));
    const ingById = new Map(ingCards.map((i) => [i.id, i]));

    const items = ingIds.map((iid) => {
      const ing = ingById.get(iid);
      const base = ing ? this.baseUnitOf((ing.attrs ?? {}) as Record<string, unknown>) : null;
      const input = this.toBalanceInput(rows.filter((r) => r.ingredientId === iid));
      const b = base ? stockBalance(input, base, warehouseId) : null;
      return {
        ingredientId: iid,
        ingredientName: ing?.name ?? "ингредиент",
        baseUnit: base,
        qty: b ? b.qty : null,
        unconvertible: b ? b.unconvertible : 0,
      };
    });

    return { warehouseId, warehouseName: wh.name, items };
  }

  /**
   * Расход сырья за период: сколько ингредиентов списали продажи.
   *
   * Считается НА ЧТЕНИИ из журнала продаж и рецептов — не хранится и не пишется
   * движениями. Продажа товара-рецепта раскрывается в состав × количество и
   * приводится к базовой единице ингредиента. Товар из продажи сопоставляется с
   * карточкой так же, как в разборе источников: по имени и ручным связкам
   * (raw_link), чтобы владелец правил соответствие в одном месте.
   */
  async consumption(from: string, to: string): Promise<{
    from: string;
    to: string;
    soldRecipeUnits: number;
    totalCost: number;
    unresolved: number;
    ingredients: {
      ingredientId: string;
      ingredientName: string;
      approved: boolean;
      consumed: number | null;
      unit: string | null;
      cost: number | null;
      unconvertible: number;
      fromProducts: number;
    }[];
    products: { productId: string; productName: string; soldQty: number; cost: number | null }[];
    noRecipe: { productId: string; productName: string; soldQty: number }[];
    unmatched: { product: string; source: string; soldQty: number; revenue: number }[];
  }> {
    // Продажи за период, свёрнутые по источнику и названию товара.
    const rows = await this.db
      .select({
        source: sale.source,
        product: sale.product,
        qty: sql<string>`sum(${sale.qty})`,
        amount: sql<string>`sum(${sale.amount})`,
      })
      .from(sale)
      .where(and(gte(sale.dt, from), lte(sale.dt, to)))
      .groupBy(sale.source, sale.product);

    // Карточки товаров и ручные связки — для сопоставления имени с карточкой.
    const products = await this.db.select().from(entity).where(eq(entity.type, "product"));
    const byId = new Map(products.map((p) => [p.id, p]));
    const byName = new Map(products.map((p) => [normalizeSourceKey(p.name), p]));
    const links = await this.db.select().from(rawLink).where(eq(rawLink.kind, "product"));
    const linkByKey = new Map(links.map((l) => [`${l.sourceCode}::${l.externalKey}`, l]));

    const soldByProduct = new Map<string, number>();
    const noRecipe = new Map<string, { productName: string; soldQty: number }>();
    const unmatched: { product: string; source: string; soldQty: number; revenue: number }[] = [];

    for (const r of rows) {
      const qty = Number(r.qty) || 0;
      if (qty <= 0) continue;
      const key = normalizeSourceKey(r.product);
      const link = linkByKey.get(`${r.source}::${key}`);
      // Связка владельца сильнее авто-совпадения; связка с пустой карточкой —
      // осознанное «карточку не заводить», товар в расход не идёт.
      const card = link ? (link.entityId ? byId.get(link.entityId) ?? null : null) : byName.get(key) ?? null;

      if (!card) {
        unmatched.push({ product: r.product, source: r.source, soldQty: qty, revenue: Number(r.amount) || 0 });
        continue;
      }
      if (productKind((card.attrs ?? {}) as Record<string, unknown>) !== "рецепт") {
        const cur = noRecipe.get(card.id) ?? { productName: card.name, soldQty: 0 };
        cur.soldQty += qty;
        noRecipe.set(card.id, cur);
        continue;
      }
      soldByProduct.set(card.id, (soldByProduct.get(card.id) ?? 0) + qty);
    }

    // Составы проданных рецептов и карточки их ингредиентов.
    const recipeLines = new Map<string, RecipeLine[]>();
    const ingIds = new Set<string>();
    for (const productId of soldByProduct.keys()) {
      const card = byId.get(productId);
      const lines = parseRecipe((card?.attrs ?? {}) as Record<string, unknown>);
      recipeLines.set(productId, lines);
      for (const l of lines) ingIds.add(l.ingredientId);
    }
    const ingCards =
      ingIds.size === 0
        ? []
        : await this.db.select().from(entity).where(inArray(entity.id, [...ingIds]));
    const ingById = new Map(ingCards.map((i) => [i.id, i]));

    const priceOf = (id: string): IngredientPrice =>
      readIngredientPrice((ingById.get(id)?.attrs ?? {}) as Record<string, unknown>);
    const recipeOf = (id: string): RecipeLine[] => recipeLines.get(id) ?? [];
    const sold: SoldProduct[] = [...soldByProduct].map(([productId, qty]) => ({ productId, qty }));

    const report = consumptionReport(sold, recipeOf, priceOf);

    return {
      from,
      to,
      soldRecipeUnits: sold.reduce((n, s) => n + s.qty, 0),
      totalCost: report.totalCost,
      unresolved: report.unresolved,
      ingredients: report.ingredients
        .map((i) => {
          const ing = ingById.get(i.ingredientId);
          return {
            ingredientId: i.ingredientId,
            ingredientName: ing?.name ?? "ингредиент",
            approved: ing ? ing.approvedAt !== null : false,
            consumed: i.consumed,
            unit: i.unit,
            cost: i.cost,
            unconvertible: i.unconvertible,
            fromProducts: i.fromProducts,
          };
        })
        .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
      products: sold
        .map((s) => {
          const cost = recipeCost(recipeOf(s.productId), priceOf);
          return {
            productId: s.productId,
            productName: byId.get(s.productId)?.name ?? "товар",
            soldQty: s.qty,
            cost: cost.unresolved > 0 && cost.total === 0 ? null : s.qty * cost.total,
          };
        })
        .sort((a, b) => b.soldQty - a.soldQty),
      noRecipe: [...noRecipe].map(([productId, v]) => ({ productId, ...v })),
      unmatched: unmatched.sort((a, b) => b.revenue - a.revenue),
    };
  }
}
