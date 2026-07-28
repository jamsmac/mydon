import type { Domain } from "@mydon/shared";
import type { AgentsCoreClient } from "./core-client";
import type { AgentDefinition } from "./registry";

/**
 * Предметные навыки агентов (Фаза К3: агенты подключены к Core).
 *
 * До этого прогон навыка создавал согласование ВСЕГДА — даже когда предлагать
 * нечего. Такой шум приучает владельца жать «одобрить» не глядя, и очередь
 * перестаёт быть сигналом. Теперь навык сперва СМОТРИТ данные Core и:
 *   • есть повод  → готовит предложение с конкретикой (что и почему);
 *   • повода нет  → возвращает null, согласование не создаётся.
 *
 * Данных владелец пока не загружал (ТЗ: только структурный сид), поэтому на
 * пустой базе навыки честно молчат — это ожидаемое, а не сломанное поведение.
 */

/** Предложение агента: что вынести владельцу на решение. */
export interface Proposal {
  /** Человеко-понятная формулировка: что предлагается и почему. */
  action: string;
  /** Факты, на которых построено предложение — для проверки «по следам». */
  facts: Record<string, unknown>;
}

/** Навык: читает Core и либо предлагает дело, либо честно молчит (null). */
export type Skill = (agent: AgentDefinition, core: AgentsCoreClient) => Promise<Proposal | null>;

function asDomain(business: string): Domain {
  const known = ["globerent", "vendhub", "personal", "mydon"];
  return (known.includes(business) ? business : "mydon") as Domain;
}

/** Сумма прописью для владельца: без хвостов и с разделением разрядов. */
function money(amount: string | number, currency: string): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return `${String(amount)} ${currency}`;
  return `${Math.round(n).toLocaleString("ru-RU")} ${currency}`;
}

// ── mydon-finance: контроль дебиторки ────────────────────────────────────────
const watchReceivables: Skill = async (agent, core) => {
  const domain = asDomain(agent.business);
  const o = await core.obligations(domain);
  if (o.overdueTotal === 0) return null; // просрочек нет — повода нет

  const top = o.overdue[0];
  const sum = o.overdue.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
  const cur = top?.currency ?? "UZS";
  const tail = o.overdueTruncated ? ` (показаны первые ${o.overdue.length})` : "";

  return {
    action:
      `Разобрать просроченную дебиторку: ${o.overdueTotal} позиций на ${money(sum, cur)}${tail}. ` +
      `Самая давняя — от ${top?.date ?? "неизвестной даты"}.`,
    facts: {
      domain,
      overdueTotal: o.overdueTotal,
      sum: Math.round(sum),
      currency: cur,
      oldestDate: top?.date ?? null,
      truncated: o.overdueTruncated,
    },
  };
};

// ── vendhub-ops: простаивающие автоматы ──────────────────────────────────────
const monitorStock: Skill = async (_agent, core) => {
  const b = await core.briefing();
  if (b.idleMachines === 0) return null; // все работают — повода нет

  return {
    action:
      `Проверить простаивающие автоматы: ${b.idleMachines} без признака работы. ` +
      `Нужен выезд или пополнение — решает владелец.`,
    facts: { idleMachines: b.idleMachines },
  };
};

// ── chief-of-staff: утренняя сводка ──────────────────────────────────────────
const morningDigest: Skill = async (_agent, core) => {
  const b = await core.briefing();
  const alarms: string[] = [];
  if (b.overdueMoney > 0) alarms.push(`просрочено платежей: ${b.overdueMoney}`);
  if (b.idleMachines > 0) alarms.push(`автоматы простаивают: ${b.idleMachines}`);
  if (b.contractsDueSoon > 0) alarms.push(`договоры на исходе: ${b.contractsDueSoon}`);
  if (b.overdueTasks > 0) alarms.push(`просроченные задачи: ${b.overdueTasks}`);
  // Нераспознанные даты — «известная неизвестность»: молчать о них нельзя.
  if (b.contractsBadDate > 0) alarms.push(`договоров с нераспознанной датой: ${b.contractsBadDate}`);

  if (alarms.length === 0) return null; // тревог нет — не дёргаем владельца

  return {
    action: `Разобрать за день: ${alarms.join("; ")}.`,
    facts: { ...b },
  };
};

/**
 * Реестр реализованных навыков. Навыка нет в реестре — прогон честно
 * сообщает, что он ещё не подключён (а не изображает работу).
 */
export const SKILLS: Record<string, Skill> = {
  "watch-receivables": watchReceivables,
  "monitor-stock": monitorStock,
  "morning-digest": morningDigest,
};

export function hasSkill(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SKILLS, name);
}
