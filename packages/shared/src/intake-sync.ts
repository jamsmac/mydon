/**
 * Синк прихода: строки закупок mydon-stock → приход ингредиентов на склад.
 *
 * Приход из внешней системы уже зеркалится в таблицу purchase (по имени товара
 * строкой). Здесь эти строки сопоставляются с карточками ингредиентов и
 * превращаются в приход склада — потоком, а не руками. Идемпотентно: одна
 * строка источника → одно движение (ключ по её id), повторный синк не двоит.
 *
 * Планировщик чист и не ходит в базу: сопоставление карточки и целевой склад
 * передаёт вызывающий. Так его логику видно и можно проверить.
 */
import { convertQty, isUnit, type Unit } from "./recipe";

/** Строка закупки из зеркала mydon-stock. */
export interface PurchaseInput {
  /** Стабильный id строки источника — ключ идемпотентности. */
  id: string;
  source: string;
  product: string;
  unit: string | null;
  qty: number;
  unitPrice: number | null;
  /** Дата прихода YYYY-MM-DD. */
  dt: string;
}

/** Ингредиент, к которому свелась строка закупки. */
export interface ResolvedIngredient {
  ingredientId: string;
  /** Единица цены покупки ингредиента — к ней проверяем сводимость. */
  baseUnit: Unit | null;
}

/** Приход, готовый к записи в ленту склада. */
export interface PlannedIntake {
  /** Ключ идемпотентности движения: `purchase:<id строки>`. */
  extId: string;
  ingredientId: string;
  qty: number;
  unit: Unit;
  unitPrice: number | null;
  dt: string;
}

/** План синка: что записать и что честно пропущено с причиной. */
export interface IntakePlan {
  intakes: PlannedIntake[];
  /** Закупки, не сведённые к карточке ингредиента (товар/неизвестное). */
  noCard: { product: string; qty: number }[];
  /** Закупки с единицей, которую не свести к базовой единице ингредиента. */
  badUnit: { product: string; unit: string | null }[];
}

/**
 * Спланировать приход из строк закупок.
 *
 * Сводим строку к ингредиенту (по имени/связке — это делает вызывающий) и
 * проверяем единицу: она должна быть известной и сводимой к базовой единице
 * ингредиента. Несводимое и несопоставленное не молчим — кладём в причины.
 */
export function planPurchaseIntake(
  purchases: readonly PurchaseInput[],
  resolve: (p: PurchaseInput) => ResolvedIngredient | null,
): IntakePlan {
  const intakes: PlannedIntake[] = [];
  const noCard: { product: string; qty: number }[] = [];
  const badUnit: { product: string; unit: string | null }[] = [];

  for (const p of purchases) {
    if (!(p.qty > 0)) continue;
    const r = resolve(p);
    if (!r) {
      noCard.push({ product: p.product, qty: p.qty });
      continue;
    }
    if (!isUnit(p.unit)) {
      badUnit.push({ product: p.product, unit: p.unit });
      continue;
    }
    if (r.baseUnit && p.unit !== r.baseUnit && convertQty(p.qty, p.unit, r.baseUnit) === null) {
      badUnit.push({ product: p.product, unit: p.unit });
      continue;
    }
    intakes.push({
      extId: `purchase:${p.id}`,
      ingredientId: r.ingredientId,
      qty: p.qty,
      unit: p.unit,
      unitPrice: p.unitPrice,
      dt: p.dt,
    });
  }

  return { intakes, noCard, badUnit };
}
