/**
 * Расход сырья: сколько ингредиентов списали продажи за период.
 *
 * Выводится НА ЧТЕНИИ из журнала продаж и рецептов — не хранится и не
 * материализуется движениями склада. Причина та же, что у себестоимости и
 * остатка: производное держать нельзя, оно разойдётся. Продали 10 латте —
 * списали 10×состав: зёрна, молоко, стакан, приведённые к единице ингредиента.
 *
 * Списание привязано к продаже, а не к складу: у автомата нет привязки к
 * складу-источнику, поэтому расход считается по ингредиенту в целом. Когда
 * появится связь автомат→склад, тот же расчёт ляжет на конкретный склад.
 */
import { convertQty, type IngredientPrice, type RecipeLine, type Unit } from "./recipe";

/** Продано товара за период. */
export interface SoldProduct {
  productId: string;
  qty: number;
}

/** Расход одного ингредиента за период. */
export interface IngredientConsumption {
  ingredientId: string;
  /** Списано в базовой единице ингредиента. null — базовой единицы/перевода нет. */
  consumed: number | null;
  unit: Unit | null;
  /** Стоимость списанного. null — цены нет. */
  cost: number | null;
  /** Строк списания, что не удалось привести к базовой единице (нет единицы/несводимо). */
  unconvertible: number;
  /** Из скольких разных товаров сложился расход. */
  fromProducts: number;
}

/** Итог расхода за период. */
export interface ConsumptionReport {
  ingredients: IngredientConsumption[];
  /** Себестоимость списанного: сумма посчитанных строк. */
  totalCost: number;
  /** Строк списания, где стоимость посчитать не удалось (нет цены/единицы). */
  unresolved: number;
}

interface Acc {
  consumed: number;
  unit: Unit | null;
  cost: number;
  unconvertible: number;
  products: Set<string>;
  hasConsumed: boolean;
  hasCost: boolean;
}

/**
 * Расход ингредиентов из продаж и рецептов.
 *
 * На каждую продажу товара-рецепта раскрываем состав и умножаем на количество
 * проданного. Количество ингредиента приводим к его базовой (ценовой) единице:
 * `10 × 18 г` зёрен → `180 г` → `0.18 кг`. Несводимую единицу или отсутствие
 * цены не обнуляем молча — считаем непосчитанной, итог честно неполон.
 */
export function consumptionReport(
  sold: readonly SoldProduct[],
  recipeOf: (productId: string) => readonly RecipeLine[],
  priceOf: (ingredientId: string) => IngredientPrice,
): ConsumptionReport {
  const acc = new Map<string, Acc>();
  let unresolved = 0;

  for (const s of sold) {
    if (!(s.qty > 0)) continue;
    for (const line of recipeOf(s.productId)) {
      let e = acc.get(line.ingredientId);
      if (!e) {
        e = { consumed: 0, unit: null, cost: 0, unconvertible: 0, products: new Set(), hasConsumed: false, hasCost: false };
        acc.set(line.ingredientId, e);
      }
      e.products.add(s.productId);

      const need = s.qty * line.quantity; // в единице строки состава
      const p = priceOf(line.ingredientId);
      if (p.unit === null) {
        // Нет базовой единицы — нельзя ни свести расход, ни посчитать стоимость.
        e.unconvertible += 1;
        unresolved += 1;
        continue;
      }
      const converted = convertQty(need, line.unit, p.unit);
      if (converted === null) {
        e.unconvertible += 1;
        unresolved += 1;
        continue;
      }
      e.unit = p.unit;
      e.consumed += converted;
      e.hasConsumed = true;
      if (p.price !== null) {
        e.cost += p.price * converted;
        e.hasCost = true;
      } else {
        // Расход сведён, но цены нет — стоимость неполна.
        unresolved += 1;
      }
    }
  }

  const ingredients: IngredientConsumption[] = [];
  let totalCost = 0;
  for (const [ingredientId, e] of acc) {
    if (e.hasCost) totalCost += e.cost;
    ingredients.push({
      ingredientId,
      consumed: e.hasConsumed ? e.consumed : null,
      unit: e.unit,
      cost: e.hasCost ? e.cost : null,
      unconvertible: e.unconvertible,
      fromProducts: e.products.size,
    });
  }

  return { ingredients, totalCost, unresolved };
}
