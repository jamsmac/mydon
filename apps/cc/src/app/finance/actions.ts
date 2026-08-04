"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

/** Единый ответ действий: панель показывает причину отказа словами, не кодом. */
export interface ActionResult {
  ok: boolean;
  message?: string;
}

function detailOf(err: unknown): string {
  return err instanceof CoreUnavailable ? err.detail : err instanceof Error ? err.message : "Core недоступен";
}

/**
 * Завести обязательство (долг/счёт со сроком) или свершившийся платёж.
 * Money-домен: ввод только через панель — здесь единственная дверь.
 */
export async function createFinanceFlow(
  domain: string,
  form: FormData,
): Promise<ActionResult> {
  const num = (name: string): number | undefined => {
    const raw = String(form.get(name) ?? "").trim().replace(/\s/g, "").replace(",", ".");
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  };
  const str = (name: string): string | undefined => {
    const raw = String(form.get(name) ?? "").trim();
    return raw === "" ? undefined : raw;
  };

  const amount = num("amount");
  if (amount === undefined || Number.isNaN(amount)) {
    return { ok: false, message: "Впиши сумму числом" };
  }
  const rate = num("rate");
  if (rate !== undefined && Number.isNaN(rate)) {
    return { ok: false, message: "Курс — число (сумов за единицу валюты)" };
  }
  const direction = str("direction");
  const status = str("status");
  if (direction !== "in" && direction !== "out") {
    return { ok: false, message: "Выбери направление: нам должны или мы должны" };
  }
  if (status !== "planned" && status !== "actual") {
    return { ok: false, message: "Выбери, что заводим: обязательство или платёж" };
  }

  try {
    await core.createFinanceFlow({
      domain,
      direction,
      status,
      amount,
      currency: str("currency"),
      category: str("category"),
      method: str("method"),
      rate,
      counterpartyId: str("counterpartyId"),
      counterparty: str("counterparty"),
      docNo: str("docNo"),
      purpose: str("purpose"),
      dueDate: str("dueDate"),
      unitId: str("unitId"),
      actorRef: "owner",
    });
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Отметить обязательство оплаченным. */
export async function payFinanceFlow(domain: string, id: string): Promise<ActionResult> {
  try {
    await core.payFinanceFlow(id);
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Отменить ошибочную запись — строка остаётся в журнале Core. */
export async function cancelFinanceFlow(domain: string, id: string): Promise<ActionResult> {
  try {
    await core.cancelFinanceFlow(id);
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

/** Задать курс валюты к суму вручную (история сохраняется в Core). */
export async function setFxRate(domain: string, form: FormData): Promise<ActionResult> {
  const currency = String(form.get("currency") ?? "").trim().toUpperCase();
  const rateRaw = String(form.get("rate") ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const rate = Number(rateRaw);
  if (currency.length !== 3) return { ok: false, message: "Валюта — трёхбуквенный код: USD, CNY…" };
  if (!Number.isFinite(rate) || rate <= 0) {
    return { ok: false, message: "Курс — положительное число сумов за единицу" };
  }
  const note = String(form.get("note") ?? "").trim();
  try {
    await core.setFxRate({ currency, rate, ...(note !== "" ? { note } : {}) });
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}
