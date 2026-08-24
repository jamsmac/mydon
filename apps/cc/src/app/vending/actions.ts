"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

/** Отказ Core словами владельца: детальное объяснение важнее кода ошибки. */
function failure(err: unknown): ActionResult {
  if (err instanceof CoreUnavailable) return { ok: false, message: err.detail };
  return { ok: false, message: err instanceof Error ? err.message : "Не получилось" };
}

/**
 * Кнопка «Оформить закуп» на листе «План закупа»: та же заявка T2, что и из
 * бота, — решение по ней принимается в «Согласованиях», а не здесь.
 */
export async function submitVendingPurchase(domain: string): Promise<ActionResult> {
  try {
    const res = await core.submitVendingPurchase("panel");
    if (!res.submitted) return { ok: false, message: res.reason ?? "Закупать нечего" };
    revalidatePath(`/domain/${domain}`);
    return { ok: true, message: `Заявка отправлена: ${res.positions} поз. — реши в «Согласованиях».` };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Правила закупа товара (лист «Правила закупа»): блок / исключён / фикс.
 *
 * Пустое поле «фикс» — это НЕ «не трогать», а «снять фикс»: Core снимает его
 * нулём. Пустой «блок» наоборот оставляет текущую кратность — блок берётся из
 * прайса, и обнулять его нечем.
 */
export async function saveVendingProductRules(domain: string, form: FormData): Promise<ActionResult> {
  const product = String(form.get("product") ?? "").trim();
  const packRaw = String(form.get("packSize") ?? "").trim();
  const fixedRaw = String(form.get("fixedPurchaseQty") ?? "").trim();
  const excluded = form.get("excludedFromPurchase") === "on";
  const packSize = packRaw === "" ? undefined : Number(packRaw);
  const fixedPurchaseQty = fixedRaw === "" ? 0 : Number(fixedRaw);
  if (product === "") return { ok: false, message: "Не указан товар" };
  if (packSize !== undefined && (!Number.isInteger(packSize) || packSize < 1 || packSize > 1000)) {
    return { ok: false, message: "Блок — целое число 1…1000" };
  }
  if (!Number.isInteger(fixedPurchaseQty) || fixedPurchaseQty < 0 || fixedPurchaseQty > 100_000) {
    return { ok: false, message: "Фикс — целое число (пусто = снять)" };
  }
  try {
    const res = await core.setVendingProductRules({
      product,
      ...(packSize !== undefined ? { packSize } : {}),
      excludedFromPurchase: excluded,
      fixedPurchaseQty,
      actor: "panel",
    });
    if (!res.ok) return { ok: false, message: `Товар «${product}» не найден` };
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}
