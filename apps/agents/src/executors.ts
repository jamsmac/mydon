import { TZ } from "@mydon/shared";
import type { AgentsCoreClient } from "./core-client";
import type { AgentDefinition } from "./registry";
import type { Proposal } from "./skills";

/** Итог исполнения: подтверждён ли результат и что именно сделано (в журнал). */
export interface ExecOutcome {
  /** Результат ПОДТВЕРЖДЁН: действие состоялось и проверено перечиткой. */
  ok: boolean;
  /** Что сделано/проверено — словами, попадает в журнал и отчёт. */
  detail: string;
}

/**
 * Исполнитель навыка — то, что агент ДЕЛАЕТ, когда порог автономии это разрешает.
 */
export type Executor = (
  agent: AgentDefinition,
  proposal: Proposal,
  core: AgentsCoreClient,
) => Promise<ExecOutcome>;

/** Дата по Ташкенту в формате YYYY-MM-DD (локаль sv-SE даёт ISO-подобный вид). */
function tashkentDate(now: Date = new Date()): string {
  return now.toLocaleDateString("sv-SE", { timeZone: TZ });
}

/** Тело заметки: предложение агента + факты, на которых оно построено. */
function digestBody(agent: AgentDefinition, proposal: Proposal): string {
  const facts = Object.entries(proposal.facts)
    .map(([k, v]) => `- ${k}: ${String(v)}`)
    .join("\n");
  return (
    `${proposal.action}\n\n` +
    `На чём основано:\n${facts || "- (фактов нет)"}\n\n` +
    `Сохранил агент ${agent.name}. Это запись для владельца, не сообщение наружу.`
  );
}

/**
 * Первый исполнитель MYDON: сохранить утреннюю сводку в заметку Core.
 *
 * Почему morning-digest первым: его объявленный тир — T0 (чистая информация, без
 * действия во внешнем мире), самый безопасный кандидат. Артефакт — заметка:
 * реальный, видимый владельцу и доступный поиску след. Денег и внешних сообщений
 * здесь НЕТ — это осознанная граница первого шага.
 *
 * ИДЕМПОТЕНТНОСТЬ: заголовок привязан к ташкентскому дню, а Core пишет заметку
 * upsert-ом по заголовку — повторный прогон за те же сутки обновляет ту же
 * запись, а не плодит дубли.
 *
 * САМОПРОВЕРКА: после записи НЕЗАВИСИМО перечитываем Core (поиск по заголовку) и
 * подтверждаем, что заметка есть и её тело совпадает с сохранённым. Не
 * подтвердилось — `ok: false`: не выдаём за сделанное, вызывающий уходит в
 * согласование.
 */
const persistMorningDigest: Executor = async (agent, proposal, core) => {
  const title = `Утренняя сводка · ${tashkentDate()}`;
  const body = digestBody(agent, proposal);

  await core.createNote({ title, body, tags: ["брифинг", "агент", agent.name] });

  // Не доверяем ответу записи — читаем заново и сверяем тело.
  const found = await core.findNotes(title);
  const saved = found.find((n) => n.title === title);
  if (saved && saved.body === body) {
    return { ok: true, detail: `сводка сохранена в заметку «${title}» и подтверждена перечиткой` };
  }
  return { ok: false, detail: "заметку не удалось подтвердить перечиткой — не считаю сделанным" };
};

/**
 * Реестр исполнителей навыков.
 *
 * Что здесь есть — то агент делает САМ, когда порог автономии это разрешает.
 * Добавить исполнитель — значит осознанно разрешить агенту действовать без
 * владельца в петле. Особая осторожность с деньгами и внешними сообщениями: их
 * автоматизируют отдельным, продуманным решением, а не по умолчанию. Навыка нет
 * в реестре → действие всегда идёт через согласование (см. `runSkill`), даже
 * при поднятом пороге — правило аудита: не изображать исполнение без исполнителя.
 *
 * Контракт исполнителя:
 *  • ИДЕМПОТЕНТНОСТЬ — повторный прогон по тому же поводу не двоит эффект;
 *  • САМОПРОВЕРКА — возвращает `ok: true`, только если РЕЗУЛЬТАТ подтверждён
 *    (перечитал Core и убедился, что действие состоялось). Не уверен — `ok: false`,
 *    и вызывающий не считает действие сделанным (уходит в согласование).
 *
 * Первый исполнитель — `morning-digest`: сохранить сводку в заметку (тир T0, без
 * денег и внешних сообщений). Это витрина контракта, а не разрешение на риск.
 */
/**
 * Ингестор идей: сохранить дайджест из Telegram-каналов в заметку Core.
 *
 * Тот же контракт, что у morning-digest: заголовок по ташкентскому дню (upsert —
 * без дублей), тело из фактов предложения, подтверждение перечиткой. Так идеи из
 * канала владельца КОПЯТСЯ в реестр знаний, а не только мелькают в согласовании.
 */
const persistIdeas: Executor = async (agent, proposal, core) => {
  const title = `Идеи из каналов · ${tashkentDate()}`;
  const top = Array.isArray(proposal.facts.top) ? (proposal.facts.top as { title?: unknown; links?: unknown }[]) : [];
  const lines = top.map((t) => {
    const links = Array.isArray(t.links) ? (t.links as unknown[]).map(String) : [];
    return `- ${String(t.title ?? "")}${links.length ? ` (${links.join(", ")})` : ""}`;
  });
  const body =
    `${proposal.action}\n\n` +
    `${lines.join("\n") || "- (постов нет)"}\n\n` +
    `Сохранил агент ${agent.name}. Запись для владельца, не сообщение наружу.`;

  await core.createNote({ title, body, tags: ["идея", "канал", agent.name] });

  const found = await core.findNotes(title);
  const saved = found.find((n) => n.title === title);
  if (saved && saved.body === body) {
    return { ok: true, detail: `дайджест идей сохранён в заметку «${title}» и подтверждён перечиткой` };
  }
  return { ok: false, detail: "заметку идей не удалось подтвердить перечиткой — не считаю сделанным" };
};

export const EXECUTORS: Record<string, Executor> = {
  "morning-digest": persistMorningDigest,
  "scan-ideas": persistIdeas,
};
