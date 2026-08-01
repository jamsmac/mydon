/**
 * Планограмма автомата: какой товар в каком слоте.
 *
 * Хранится в `entity.attrs["раскладка"]` JSON-массивом строк `{ slot, productId }`
 * — как состав рецепта в `состав`. Слот — метка ячейки, как её пишет владелец
 * («A1», «12»): порядок и формат диктует сам автомат, мы не навязываем сетку.
 * Товар — id карточки реестра, имя разворачивается на чтении.
 */

/** Одна занятая ячейка: метка слота и товар в нём. */
export interface PlanogramEntry {
  slot: string;
  productId: string;
}

/** Прочитать планограмму из attrs карточки автомата. Битое/пусто → пусто. */
export function parsePlanogram(
  attrs: Record<string, unknown> | null | undefined,
): PlanogramEntry[] {
  const raw = attrs?.["раскладка"];
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PlanogramEntry[] = [];
  const seen = new Set<string>();
  for (const e of parsed) {
    if (e === null || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const slot = typeof o.slot === "string" ? o.slot.trim() : "";
    const productId = typeof o.productId === "string" ? o.productId : "";
    // Пустые и повторные слоты отбрасываем: в одной ячейке — один товар.
    if (slot.length === 0 || productId.length === 0 || seen.has(slot)) continue;
    seen.add(slot);
    out.push({ slot, productId });
  }
  return out;
}
