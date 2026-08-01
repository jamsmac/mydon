/**
 * Рецепт товара: состав из ингредиентов и себестоимость.
 *
 * Модель сверена с рабочей системой владельца (VHM24 `product.types.ts`:
 * `IRecipe`/`IRecipeIngredient`), но взяты только лучшие приёмы, а слабые места
 * доноров осознанно НЕ повторены:
 *
 * - Ингредиент — обычная карточка (`entity type=ingredient`) с ценой покупки и
 *   её историей: тот же механизм, что у перепродажи. Отдельной таблицы под
 *   ингредиенты не заводим — один реестр, как советует и донор.
 * - Себестоимость считается на ЧТЕНИИ из состава и ТЕКУЩИХ цен ингредиентов, а
 *   не хранится отдельным полем: у донора кэш `totalCost` расходился с ценами.
 *   Выводим из данных — не держим производное.
 * - Партии (FIFO/сроки), версионные снимки и «необязательные/замена» —
 *   осознанно опущены в первом срезе: у донора они были недостроены и путали
 *   три разных пути списания. Добавим, когда появится реальная нужда.
 *
 * Единицы измерения и перевод — здесь, в одном месте: у донора таблица
 * перевода была продублирована в двух файлах и разошлась.
 */

/** Единицы измерения состава и цены ингредиента. */
export const UNITS = ["г", "кг", "мл", "л", "шт", "порция", "чашка"] as const;
export type Unit = (typeof UNITS)[number];

/** Размерность и множитель к базовой единице размерности. */
const DIM: Record<Unit, { dim: "вес" | "объём" | "штуки"; per: number }> = {
  "г": { dim: "вес", per: 1 },
  "кг": { dim: "вес", per: 1000 },
  "мл": { dim: "объём", per: 1 },
  "л": { dim: "объём", per: 1000 },
  "шт": { dim: "штуки", per: 1 },
  "порция": { dim: "штуки", per: 1 },
  "чашка": { dim: "штуки", per: 1 },
};

/** Единица известна справочнику. */
export function isUnit(v: unknown): v is Unit {
  return typeof v === "string" && (UNITS as readonly string[]).includes(v);
}

/**
 * Перевести количество из одной единицы в другую.
 *
 * Внутри веса (г↔кг) и объёма (мл↔л) — по множителю. Штучные единицы (шт,
 * порция, чашка) переводятся только сами в себя: «1 порция» и «1 чашка» — не
 * одно и то же, и выдумывать между ними коэффициент нельзя. Несовместимо —
 * null, а не молчаливый ноль.
 */
export function convertQty(qty: number, from: Unit, to: Unit): number | null {
  if (from === to) return qty;
  const a = DIM[from];
  const b = DIM[to];
  if (a.dim !== b.dim || a.dim === "штуки") return null;
  return (qty * a.per) / b.per;
}

/** Строка состава: ингредиент, сколько и в чём. */
export interface RecipeLine {
  /** Карточка ингредиента (entity id). */
  ingredientId: string;
  /** Сколько ингредиента на одну порцию товара. */
  quantity: number;
  unit: Unit;
}

/** Цена ингредиента: сколько стоит и за какую единицу. */
export interface IngredientPrice {
  /** Цена покупки за единицу `unit`. null — цена не заведена. */
  price: number | null;
  unit: Unit | null;
}

/** Стоимость одной строки состава — с причиной, если посчитать нельзя. */
export interface LineCost {
  line: RecipeLine;
  /** Стоимость строки. null — посчитать нечем (нет цены/единицы или несовместимо). */
  cost: number | null;
  /** Почему null — владельцу видно, что чинить. */
  why: string | null;
}

/** Итог по рецепту. */
export interface RecipeCost {
  lines: LineCost[];
  /** Себестоимость: сумма посчитанных строк. */
  total: number;
  /** Строк, которые посчитать не удалось, — итог неполон, и это сказано. */
  unresolved: number;
}

/**
 * Себестоимость рецепта из состава и текущих цен ингредиентов.
 *
 * Цена ингредиента — за его единицу (например, 80 000 сум за «кг»). Строка
 * состава может быть в другой единице той же размерности (18 «г»): переводим и
 * умножаем. Несовместимые единицы или отсутствующая цена не обнуляются молча —
 * строка помечается непосчитанной, и итог честно неполон.
 */
export function recipeCost(
  lines: readonly RecipeLine[],
  priceOf: (ingredientId: string) => IngredientPrice,
): RecipeCost {
  const out: LineCost[] = [];
  let total = 0;
  let unresolved = 0;
  for (const line of lines) {
    const p = priceOf(line.ingredientId);
    let cost: number | null = null;
    let why: string | null = null;
    if (p.price === null || p.unit === null) {
      why = "у ингредиента не заведена цена покупки";
    } else {
      const converted = convertQty(line.quantity, line.unit, p.unit);
      if (converted === null) {
        why = `«${line.unit}» не перевести в «${p.unit}» — разные размерности`;
      } else {
        cost = p.price * converted;
      }
    }
    if (cost === null) unresolved += 1;
    else total += cost;
    out.push({ line, cost, why });
  }
  return { lines: out, total, unresolved };
}

/**
 * Прочитать состав из attrs карточки. Хранится в `состав` JSON-массивом строк
 * `{ingredientId, quantity, unit}`. Мусор молча отбрасывается: полусломанную
 * строку в расчёт брать нельзя.
 */
export function parseRecipe(attrs: Record<string, unknown> | null | undefined): RecipeLine[] {
  const raw = attrs?.["состав"];
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.trim().length > 0
      ? safeJson(raw)
      : [];
  if (!Array.isArray(arr)) return [];
  const out: RecipeLine[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.ingredientId === "string" ? o.ingredientId : "";
    const qty = typeof o.quantity === "number" ? o.quantity : Number(o.quantity);
    const unit = o.unit;
    if (id.length === 0 || !Number.isFinite(qty) || qty <= 0 || !isUnit(unit)) continue;
    out.push({ ingredientId: id, quantity: qty, unit });
  }
  return out;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}
