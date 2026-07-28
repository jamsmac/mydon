"use server";

import { revalidatePath } from "next/cache";

/**
 * Решение по согласованию из панели.
 *
 * Пишется тем же путём, что и кнопки в Telegram, — Core сам не даёт принять
 * решение дважды (условие pending внутри UPDATE). Поэтому гонка «нажал в боте
 * и в панели одновременно» разрешается на стороне Core, а не здесь.
 */
export async function decideApproval(
  id: string,
  decision: "approved" | "rejected" | "clarify",
): Promise<{ ok: boolean; message: string }> {
  const base = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";

  try {
    const res = await fetch(`${base}/approvals/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, actor: "panel" }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
      const raw = Array.isArray(body.message) ? body.message.join("; ") : body.message;
      // Частый случай: решение уже принято в боте. Это не ошибка панели —
      // объясняем словами, а не кодом.
      return { ok: false, message: raw ?? `Core ответил ${res.status}` };
    }

    revalidatePath("/approvals");
    revalidatePath("/mydon");
    revalidatePath("/audit");

    const label =
      decision === "approved" ? "Одобрено" : decision === "rejected" ? "Отклонено" : "Отправлено на уточнение";
    return { ok: true, message: label };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? `Core недоступен: ${err.message}` : "Core недоступен",
    };
  }
}
