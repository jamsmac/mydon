/**
 * Цена ингредиента из карточки — единый перевод в сум/грамм.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ. Цену вводит человек в карточку `entity(type=
 * 'ingredient')` в удобной ему единице (кофе — за кг, MacCoffee — за грамм
 * пакетика, стакан — за штуку). Расчёт себестоимости расхода (core) и карточка
 * 360 (cc) обязаны переводить эту цену в сум/грамм ОДИНАКОВО — иначе отчёты
 * разойдутся в цифрах. Здесь — то самое одно место.
 *
 * ЛОВУШКА. `convertQty` из `./recipe` переводит КОЛИЧЕСТВО: 1 кг → 1000 г,
 * коэффициент умножается. Цена — величина «за единицу», у неё смысл обратный:
 * если 1 кг стоит 260 000 сум, то 1 г стоит 260 000 / 1000 = 260 сум, а НЕ
 * 260 000 × 1000. Позвать `convertQty(260000, "кг", "г")` на цене вместо
 * количества дало бы 260 000 000 — цифру, ошибочную в миллион раз. Поэтому
 * перевод цены записан здесь явным делением на тот же коэффициент, а не через
 * `convertQty`, и это НЕ дублирование: разные величины, разная арифметика.
 */

import { isUnit, type Unit } from "./recipe";

/** Цена и единица как записаны в карточке — для витрин, где важна исходная единица. */
export interface IngredientCardPrice {
  /** Цена за единицу `unit`, как записана в карточке. */
  price: number;
  unit: Unit;
}

/**
 * Число из значения атрибута карточки. Карточки заводились руками: чистим
 * пробелы всех видов (включая неразрывный U+00A0 и узкий неразрывный U+202F)
 * и запятую как десятичный разделитель — то же правило, что в `combine.ts`/
 * `reconcile.ts`/`unify.ts` для чисел из ручных источников. Не число — null,
 * а не 0: 0 — это цена, а не «данных нет».
 */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[\s\u00A0\u202F]/g, "").replace(",", ".");
  if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Цена и единица как в карточке — для витрин, где важна исходная единица.
 * null — цены или единицы нет, либо единица не из справочника `UNITS`: без
 * единицы цифра цены сама по себе бессмысленна (100 000 за кг и за грамм —
 * разные деньги), выдумывать единицу по умолчанию нельзя.
 */
export function cardPrice(attrs: Record<string, unknown> | null | undefined): IngredientCardPrice | null {
  if (!attrs) return null;
  const price = toNumber(attrs["цена покупки"]);
  const unit = attrs["единица"];
  if (price === null || !isUnit(unit)) return null;
  return { price, unit };
}

/**
 * Цена за грамм — для бункерных ингредиентов (кофе, молоко, сироп сыпучий и
 * т.п.). Переводим только вес (г, кг) — явным делением на коэффициент, см.
 * ЛОВУШКУ в шапке файла. Объём (мл, л) в вес без плотности не переводится —
 * выдумывать плотность здесь не место. Штучные карточки (шт, порция, чашка) —
 * цена за грамм не имеет смысла (стакан не измеряется в граммах).
 * null — цены/единицы нет, единица без веса, или не число.
 */
export function pricePerGram(attrs: Record<string, unknown> | null | undefined): number | null {
  const cp = cardPrice(attrs);
  if (cp === null) return null;
  switch (cp.unit) {
    case "г":
      return cp.price;
    case "кг":
      return cp.price / 1000;
    default:
      return null;
  }
}

/** Откуда взята итоговая цена ингредиента — витрина обязана показать источник, а не молчать о нём. */
export type IngredientPriceSource = "карточка" | "реестр" | null;

/** Итоговая цена ингредиента за грамм плюс её источник. */
export interface ResolvedIngredientPrice {
  /** Сум за грамм. null — ни карточка, ни запасной путь цены не дали. */
  pricePerGram: number | null;
  source: IngredientPriceSource;
}

/**
 * Выбор цены ингредиента для себестоимости расхода: сначала карточка
 * `entity(type='ingredient')` (мост `coffee_ingredient.entity_id`, миграция
 * 0059) — цену вводит человек туда; карточки нет, карточка не привязана, или
 * в ней нет цены/единицы веса (`pricePerGram` вернул null) — запасной путь:
 * `coffee_ingredient.purchase_price` (сум/г), переданный сюда явно. У всех
 * 8 живых строк на момент написания он NULL, но поле остаётся годным для
 * ингредиента без карточки в реестре.
 */
export function resolveIngredientPrice(
  cardAttrs: Record<string, unknown> | null | undefined,
  fallbackPricePerGram: number | null,
): ResolvedIngredientPrice {
  const fromCard = pricePerGram(cardAttrs);
  if (fromCard !== null) return { pricePerGram: fromCard, source: "карточка" };
  if (fallbackPricePerGram !== null) return { pricePerGram: fallbackPricePerGram, source: "реестр" };
  return { pricePerGram: null, source: null };
}
