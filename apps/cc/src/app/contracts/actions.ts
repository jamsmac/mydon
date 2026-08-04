"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

function detailOf(err: unknown): string {
  return err instanceof CoreUnavailable ? err.detail : err instanceof Error ? err.message : "Core недоступен";
}

function refresh(id?: string): void {
  revalidatePath("/domain/globerent");
  if (id !== undefined) revalidatePath(`/contracts/${id}`);
}

/**
 * Создание договора: позиции приходят JSON-строкой из клиентской формы
 * (динамический список), итоги пересчитывает сервер Core.
 */
export async function createContract(form: FormData): Promise<ActionResult & { id?: string }> {
  const str = (name: string): string | undefined => {
    const raw = String(form.get(name) ?? "").trim();
    return raw === "" ? undefined : raw;
  };
  let items: unknown;
  try {
    items = JSON.parse(String(form.get("items") ?? "[]"));
  } catch {
    return { ok: false, message: "Позиции не разобрались — обнови страницу" };
  }
  const num = (name: string): number | undefined => {
    const raw = String(form.get(name) ?? "").trim().replace(/\s/g, "").replace(",", ".");
    if (raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  const payType = str("payType");
  const docParams: Record<string, unknown> = {};
  if (payType === "100") docParams["payDays"] = num("payDays") ?? 0;
  if (payType === "install") {
    docParams["prepayPct"] = num("prepayPct") ?? 0;
    docParams["installMonths"] = num("installMonths") ?? 0;
    docParams["installInterest"] = num("installInterest") ?? 0;
    const first = str("installFirstDate");
    if (first !== undefined) docParams["installFirstDate"] = first;
  }

  try {
    const created = await core.createContract({
      domain: "globerent",
      contractNo: str("contractNo"),
      contractDate: str("contractDate"),
      clientId: str("clientId"),
      items,
      payType,
      deliveryDays: num("deliveryDays"),
      docParams,
      agentId: str("agentId"),
      agentCommissionAmount: num("agentCommission"),
      agentCommissionCurrency: str("agentCommissionCurrency"),
      actorRef: "owner",
    });
    refresh(created.id);
    return { ok: true, id: created.id };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

export async function setContractStatus(id: string, status: string): Promise<ActionResult> {
  try {
    await core.setContractStatus(id, status);
    refresh(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

export async function addContractPayment(id: string, form: FormData): Promise<ActionResult> {
  const amountRaw = String(form.get("amount") ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Сумма — число больше нуля" };
  }
  const currency = String(form.get("currency") ?? "UZS").trim();
  const docNo = String(form.get("docNo") ?? "").trim();
  try {
    await core.addContractPayment(id, {
      amount,
      currency,
      ...(docNo !== "" ? { docNo } : {}),
      actorRef: "owner",
    });
    refresh(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}

export async function addContractAct(id: string, form: FormData): Promise<ActionResult> {
  try {
    await core.addContractAct(id, {
      actNo: String(form.get("actNo") ?? "").trim(),
      actDate: String(form.get("actDate") ?? "").trim(),
      signedBySeller: String(form.get("signedBySeller") ?? "").trim() || undefined,
      signedByBuyer: String(form.get("signedByBuyer") ?? "").trim() || undefined,
      actorRef: "owner",
    });
    refresh(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: detailOf(err) };
  }
}
