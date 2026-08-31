"use server";

import { revalidatePath } from "next/cache";
import { core, coreOwnerWriteHeaders } from "../lib/core";
import { DOMAIN_TITLES, typeOne } from "../lib/labels";

/** Находка палитры ⌘K: карточка реестра или отчёт источника. */
export interface PaletteHit {
  kind: "card" | "report";
  title: string;
  sub: string;
  href: string;
}

/**
 * Поиск для палитры ⌘K: «Найти карточку или отчёт».
 *
 * Карточки — тем же поиском реестра, что и на экране «Реестр». Отчёты — из
 * справочника источников по совпадению названия. Короткий запрос не гоняем:
 * одна-две буквы вернули бы весь реестр.
 */
export async function searchRegistry(q: string): Promise<PaletteHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];

  const hits: PaletteHit[] = [];
  try {
    const cards = await core.search(query);
    for (const c of cards.slice(0, 8)) {
      hits.push({
        kind: "card",
        title: c.name,
        sub: [typeOne(c.type), c.domain ? DOMAIN_TITLES[c.domain] ?? c.domain : null]
          .filter(Boolean)
          .join(" · "),
        href: `/card/${c.id}`,
      });
    }
  } catch {
    // Core недоступен — отдаём то, что нашлось (возможно, ничего). Палитра
    // покажет «ничего не найдено», а не упадёт.
  }

  try {
    const ql = query.toLowerCase();
    const { sources } = await core.rawSources();
    for (const s of sources) {
      for (const r of s.reports) {
        const title = r.ru || r.title;
        if (title.toLowerCase().includes(ql) || s.title.toLowerCase().includes(ql)) {
          hits.push({
            kind: "report",
            title,
            sub: `${s.title} · отчёт`,
            href: `/domain/vendhub?tab=reports:sources&src=${encodeURIComponent(
              s.code,
            )}&rep=${encodeURIComponent(r.reportCode)}`,
          });
        }
      }
    }
  } catch {
    // Источники недоступны — карточки всё равно покажем.
  }

  return hits.slice(0, 12);
}

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
      // Решение по согласованию — owner-only (R-P5-5): второй пояс поверх
      // сервисного токена. Токен владельца проставится лишь при подтверждённом
      // владельце; из общего SERVICE_TOKEN он не выводится.
      headers: await coreOwnerWriteHeaders(),
      body: JSON.stringify({ decision, actor: "panel" }),
      cache: "no-store",
      // «Одобрить» может исполнять большой импорт (тысячи строк одной
      // транзакцией) — 8с обрывали ожидание на живом одобрении 2026-08-03,
      // хотя Core продолжал работу. Дать исполнению договорить.
      signal: AbortSignal.timeout(120_000),
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
