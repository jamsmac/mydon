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
/** Одна идея из канала: заголовок по id поста (дедуп), текст, ссылки. */
interface IdeaCard {
  id: string;
  title: string;
  text: string;
  links: string[];
}

function ideaCards(proposal: Proposal): IdeaCard[] {
  const top = Array.isArray(proposal.facts.top) ? (proposal.facts.top as Record<string, unknown>[]) : [];
  return top
    .filter((t) => typeof t.id === "string")
    .map((t) => ({
      id: String(t.id),
      title: typeof t.title === "string" ? t.title : "",
      text: typeof t.text === "string" ? t.text : "",
      links: Array.isArray(t.links) ? (t.links as unknown[]).map(String) : [],
    }));
}

/**
 * Ингестор идей: КАЖДЫЙ пост канала — отдельной карточкой-заметкой в Core.
 *
 * Заголовок карточки привязан к id поста (`Идея <канал/номер>`), а Core пишет
 * заметку upsert-ом по заголовку — значит дедуп по посту бесплатный: повторный
 * прогон обновляет ту же карточку, а не плодит копии. Так идеи из канала
 * КОПЯТСЯ в реестр знаний по одной, а не тонут в общем дайджесте.
 *
 * Само-проверка: после записи перечитываем одну карточку и сверяем тело. Не
 * подтвердилось — ok:false, не считаем сделанным.
 */
const persistIdeas: Executor = async (agent, proposal, core) => {
  const cards = ideaCards(proposal);
  if (cards.length === 0) return { ok: false, detail: "нет идей для сохранения" };

  const saved: { title: string; body: string }[] = [];
  for (const card of cards) {
    const title = `Идея ${card.id}`;
    const body =
      `${card.title}\n\n${card.text}` +
      (card.links.length ? `\n\nСсылки: ${card.links.join(", ")}` : "") +
      `\n\nИз канала. Сохранил агент ${agent.name} — запись для владельца.`;
    await core.createNote({ title, body, tags: ["идея", "канал", agent.name] });
    saved.push({ title, body });
  }

  // Перечитка одной карточки (последней) — подтверждаем, что запись состоялась.
  const probe = saved[saved.length - 1];
  const found = await core.findNotes(probe.title);
  const hit = found.find((n) => n.title === probe.title);
  if (hit && hit.body === probe.body) {
    return { ok: true, detail: `сохранено идей-карточек: ${saved.length} (дедуп по id поста), подтверждено перечиткой` };
  }
  return { ok: false, detail: "карточки идей не подтвердились перечиткой — не считаю сделанным" };
};

export const EXECUTORS: Record<string, Executor> = {
  "morning-digest": persistMorningDigest,
  "scan-ideas": persistIdeas,
};
