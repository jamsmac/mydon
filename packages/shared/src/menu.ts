/**
 * Меню автомата: чем он торгует и почём — ассортимент с ценой аппарата.
 *
 * Хранится в `entity.attrs["меню"]` JSON-массивом строк `{ productId, price }`
 * — тот же принцип, что раскладка в `раскладка` и состав в `состав`.
 *
 * Цена — ОВЕРРАЙД поверх каталожной (паттерн VendHub-OS: slot.price ??
 * product.sellingPrice): `null` значит «по товару», и цена разворачивается
 * на чтении из карточки товара («цена продажи» либо «цена»). Так смена
 * каталожной цены сама доезжает до всех автоматов без своей цены, а точка
 * с особой ценой держит свою.
 *
 * Горячее/холодное НЕ хранится здесь: это категория карточки товара
 * (attrs["категория"], 10 = кофейные/горячие, 11 = прохладительные) — один
 * источник истины, меню его только показывает и переключает.
 */

/** Одна позиция меню: товар и цена этого аппарата (null — по товару). */
export interface MenuLine {
  productId: string;
  price: number | null;
}

/** Прочитать меню из attrs карточки автомата. Битое/пусто → пусто. */
export function parseMenu(attrs: Record<string, unknown> | null | undefined): MenuLine[] {
  const raw = attrs?.["меню"];
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: MenuLine[] = [];
  const seen = new Set<string>();
  for (const e of parsed) {
    if (e === null || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const productId = typeof o.productId === "string" ? o.productId : "";
    // Один товар — одна строка меню; повтор отбрасываем.
    if (productId.length === 0 || seen.has(productId)) continue;
    seen.add(productId);
    const price =
      typeof o.price === "number" && Number.isFinite(o.price) && o.price > 0 ? o.price : null;
    out.push({ productId, price });
  }
  return out;
}
