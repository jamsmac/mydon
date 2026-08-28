"use server";

import { revalidatePath } from "next/cache";
import { validateFiscalPatch } from "@mydon/shared";
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
    // Имя из ОТВЕТА Core (канон после алиасов), а не из формы: владелец должен
    // видеть, под какой карточкой правило записано (UX#25).
    return { ok: true, message: `Правило «${res.product ?? product}» сохранено` };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Фискальный блок товара (лист «Правила закупа», П6).
 *
 * Пустое текстовое поле — СБРОС (`null`), а не «не трогать». Три словарных
 * поля едут всегда: их select по построению не бывает пустым. Причина отказа
 * остаётся точной — владелец должен видеть, что именно не так с кодом.
 */
export async function saveVendingProductFiscal(domain: string, form: FormData): Promise<ActionResult> {
  const productId = String(form.get("productId") ?? "").trim();
  if (productId === "") return { ok: false, message: "Не указана карточка товара" };

  const text = (name: string): string | null => {
    const raw = String(form.get(name) ?? "").trim();
    return raw === "" ? null : raw;
  };
  const vatRaw = form.get("vatPct");
  const markedRaw = String(form.get("marked") ?? "").trim();
  if (markedRaw !== "0" && markedRaw !== "1") {
    return { ok: false, message: "Маркировка — выбери значение из списка" };
  }
  const patch = {
    ikpu: text("ikpu"),
    mxik: text("mxik"),
    barcode: text("barcode"),
    // `Number(null) === 0`, а 0 — законная ставка. На границе server action
    // отсутствующий select обязан стать ошибкой, а не молчаливой льготой.
    vatPct: vatRaw === null || String(vatRaw).trim() === "" ? Number.NaN : Number(vatRaw),
    packageCode: String(form.get("packageCode") ?? ""),
    marked: markedRaw === "1",
  };
  const errors = validateFiscalPatch(patch);
  if (errors.length > 0) return { ok: false, message: errors[0] };

  try {
    const res = await core.setVendingProductFiscal({ productId, ...patch, actor: "panel" });
    if (!res.ok) {
      return {
        ok: false,
        message: res.reason === "invalid" ? (res.errors[0] ?? "Фискальные данные не прошли проверку") : "Карточка товара не найдена",
      };
    }
    revalidatePath(`/domain/${domain}`);
    return { ok: true, message: `Фискальные данные «${res.product}» сохранены` };
  } catch (err) {
    return failure(err);
  }
}
