import type { AgentsCoreClient } from "./core-client";
import type { AgentDefinition } from "./registry";
import type { Proposal } from "./skills";

/** Ответ Core `GET /parts/queue` — ровно те поля, что нужны аудиту. */
export interface PartsQueueSnapshot {
  counts: Record<string, number>;
  items: {
    id: string;
    label: string;
    attention: string[];
    where: { location: string; machineName: string | null; since: string } | null;
  }[];
}

const ATTENTION_LABEL: Record<string, string> = {
  no_number: "без номера",
  label_pending: "наклеить",
  unknown_location: "неизвестно где",
  no_tare: "без тары",
  no_photo: "без фото",
};

/** Дольше стольких дней на мойке — мойка «зависла». */
export const WASHING_STALE_DAYS = 3;

function daysSince(iso: string, now: Date): number {
  const day = new Date(`${iso}T00:00:00Z`).getTime();
  return Math.floor((now.getTime() - day) / 86_400_000);
}

/**
 * Аудит узлов (навык `parts-audit`, спека vendhub-parts §6): очередь внимания
 * → одно предложение владельцу. Повода нет — очередь пуста и на мойке ничего
 * не залежалось. Сигнатура — счётчики: та же картина неделю спустя не
 * повторяется (дельта-память runner'а).
 */
export function partsAuditProposal(queue: PartsQueueSnapshot, now = new Date()): Proposal | null {
  const total = queue.items.length;
  const staleWashing = queue.items.filter(
    (it) => it.where?.location === "washing" && daysSince(it.where.since, now) >= WASHING_STALE_DAYS,
  );
  if (total === 0 && staleWashing.length === 0) return null;

  const parts = Object.entries(queue.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${ATTENTION_LABEL[k] ?? k} ${n}`);
  const head = total > 0 ? `Узлы: ${total} требуют внимания — ${parts.join(", ")}` : "Узлы: очередь пуста";
  const tail = staleWashing.length > 0 ? `; на мойке дольше ${WASHING_STALE_DAYS} дней: ${staleWashing.length}` : "";

  const next: string[] = [];
  if (total > 0) next.push("Пройти очередь по одному: панель /parts/queue или бот «🔢 Номера узлов»");
  if ((queue.counts.unknown_location ?? 0) > 0) next.push("Провести инвентаризацию узлов на складе и мойке — найти «неизвестно где»");
  if ((queue.counts.no_tare ?? 0) > 0) next.push("Взвесить пустые бункеры без тары — без неё возврат не приходуется");
  if (staleWashing.length > 0) next.push(`Проверить мойку: ${staleWashing.slice(0, 3).map((s) => s.label).join(", ")}`);

  return {
    action: head + tail,
    facts: {
      counts: queue.counts,
      total,
      examples: queue.items.slice(0, 5).map((it) => `${it.label} — ${it.attention.map((a) => ATTENTION_LABEL[a] ?? a).join(", ")}`),
      staleWashing: staleWashing.map((s) => ({ label: s.label, since: s.where?.since ?? null })),
    },
    signatureFacts: { counts: queue.counts, staleWashing: staleWashing.length },
    next,
  };
}

/** Навык: читает очередь у Core и превращает в предложение. */
export async function partsAudit(_agent: AgentDefinition, core: AgentsCoreClient): Promise<Proposal | null> {
  const queue = await core.partsQueue();
  return partsAuditProposal(queue);
}
