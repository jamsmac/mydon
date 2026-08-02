import { notion } from "@mydon/connectors";
import type { AutonomyTier } from "@mydon/shared";
import type { AgentsCoreClient } from "./core-client";
import { dailyCap, startOfTashkentDay } from "./limits";
import type { AgentDefinition } from "./registry";
import { runSkill } from "./runner";
import { hasSkill } from "./skills";

/**
 * Задачи, поручённые агенту (решение владельца: «агент берёт и делает»).
 *
 * Владелец ставит задачу агенту так же, как человеку. Агент берёт её в работу,
 * пробует выполнить своим навыком и ОТЧИТЫВАЕТСЯ результатом — как сотрудник.
 *
 * Если подходящего навыка нет, агент честно пишет «не умею» и возвращает задачу
 * владельцу, а не изображает работу и не закрывает её молча.
 */

export interface TaskRunResult {
  taskId: string;
  outcome: "done" | "returned" | "proposed" | "skipped";
  note: string;
}

/** По заголовку задачи ищем навык агента, который её закрывает. */
export function matchSkill(agent: AgentDefinition, title: string): string | null {
  const text = title.toLowerCase();
  // Прямое упоминание навыка в тексте — самый надёжный признак.
  for (const skill of agent.skills) {
    if (text.includes(skill.toLowerCase()) && hasSkill(skill)) return skill;
  }
  // Иначе — по смыслу: слова задачи против того, что навык умеет.
  const HINTS: Record<string, RegExp> = {
    "watch-receivables": /дебитор|долг|просроч|платеж|оплат/,
    "monitor-stock": /остат|автомат|пополн|простаив|запас/,
    "morning-digest": /сводк|дайджест|обзор|что нового|как дела/,
    "read-sources": /источник|сайт|страниц|прочит|разведк|рынок|тендер|цен[аы]/,
  };
  for (const skill of agent.skills) {
    const re = HINTS[skill];
    if (re && re.test(text) && hasSkill(skill)) return skill;
  }
  return null;
}

/**
 * Прогон задач одного агента.
 *
 * Порядок важен: сначала берём в работу (владелец видит, что агент занялся),
 * потом выполняем, потом отчитываемся. При сбое задача остаётся открытой —
 * лучше повторить, чем потерять.
 */
export async function runAgentTasks(
  agent: AgentDefinition,
  core: AgentsCoreClient,
  threshold: AutonomyTier,
  /** Карта «навык → минимальный тир» (floor). Не задана — тир берётся только
   *  из карточки агента; гейт по навыку не применяется. */
  skillFloors?: Map<string, AutonomyTier>,
): Promise<TaskRunResult[]> {
  if (agent.status !== "active") return [];

  const tasks = await core.myTasks(agent.name);
  const results: TaskRunResult[] = [];

  // Дневной потолок действий распространяется и на задачи, не только на
  // расписание: иначе поручениями его можно было бы обойти. Считаем разово по
  // журналу Core (истина об уже сделанном там, а не в памяти) и ведём локально —
  // каждое действие в этом проходе приближает к потолку.
  const cap = dailyCap();
  let used = cap > 0 ? await core.countAgentActions(`agent:${agent.name}`, startOfTashkentDay()) : 0;

  for (const t of tasks) {
    const skill = matchSkill(agent, t.title);

    if (skill === null) {
      // Честный отказ: возвращаем владельцу, задачу не закрываем.
      const note =
        `Не умею это делать. Мои навыки: ${agent.skills.join(", ") || "нет"}. ` +
        `Задача остаётся на мне — переназначь или уточни.`;
      await core.addTaskComment(t.id, note, `agent:${agent.name}`);
      results.push({ taskId: t.id, outcome: "returned", note });
      continue;
    }

    // Задача требует действия навыком, а дневной потолок исчерпан: НЕ берём её в
    // работу и НЕ изображаем отчёт. Оставляем как есть (не трогаем статус) —
    // вернётся в следующий проход, а сбросится потолок в полночь по Ташкенту.
    // Останавливаемся: раз действовать сегодня нельзя, порядок задач сохраняем.
    if (cap > 0 && used >= cap) {
      results.push({
        taskId: t.id,
        outcome: "skipped",
        note: `дневной потолок действий исчерпан (${used}/${cap}) — вернусь после полуночи по Ташкенту`,
      });
      break;
    }

    await core.setTaskStatus(t.id, "in_progress", `agent:${agent.name}`);

    // ОДИН прогон навыка: он и решает, и отдаёт предложение (action/facts).
    // Раньше task-worker звал навык отдельно ради отчёта, а runSkill — ещё раз
    // ради согласования; при смене данных между ними отчёт по задаче и заявка
    // на согласование расходились (аудит P2). Теперь источник один.
    const run = await runSkill(agent, skill, core, threshold, skillFloors?.get(skill));

    if (run.outcome === "skipped") {
      if (run.skipReason === "no_signal" || run.skipReason === "no_change") {
        // Навык отработал, но повода/изменений нет — честный результат, закрываем.
        const note =
          run.skipReason === "no_change"
            ? "Проверил — с прошлого раза ничего не изменилось."
            : "Проверил — по данным MYDON повода для действий нет.";
        await core.setTaskStatus(t.id, "done", `agent:${agent.name}`, note);
        results.push({ taskId: t.id, outcome: "done", note });
      } else {
        // Потолок догнал по свежему счёту Core или иная причина — НЕ выдаём за
        // сделанную и НЕ публикуем отчёт: остаётся открытой, вернётся в следующий проход.
        results.push({ taskId: t.id, outcome: "skipped", note: run.reason });
      }
      continue;
    }

    // Действие состоялось. Учитываем в дневном счёте (журнал Core уже записал
    // agent.action). Исполнено с проверкой — задача сделана; вынесено на
    // согласование — предложена (решает владелец).
    used += 1;

    const action = run.action ?? "";
    const executed = run.outcome === "executed";
    let note = executed ? `${action}\n\nСделано и проверено.` : `${action}\n\nВынес на твоё решение.`;

    // Notion — место, куда владелец и так смотрит. Отчёт уходит туда, ссылка —
    // в задачу. Не настроен или не ответил — не беда: отчёт уже есть в MYDON.
    const link = await publishToNotion(agent, skill, action, run.facts ?? {});
    if (link !== null) note += `\n\nПодробнее: ${link}`;

    await core.setTaskStatus(t.id, "done", `agent:${agent.name}`, note);
    results.push({ taskId: t.id, outcome: executed ? "done" : "proposed", note });
  }

  return results;
}

/**
 * Публикация находки в Notion.
 *
 * Возвращает ссылку или null. Ошибка Notion НЕ должна ронять работу агента:
 * отчёт уже записан в MYDON, Notion — дополнительное место для чтения,
 * а не источник правды.
 */
async function publishToNotion(
  agent: AgentDefinition,
  skill: string,
  action: string,
  facts: Record<string, unknown>,
): Promise<string | null> {
  const config = notion.fromEnv();
  if (config === null) return null; // не настроен — молчим

  try {
    const { url } = await notion.publish(
      {
        title: `${action.slice(0, 80)} — ${new Date().toLocaleDateString("ru-RU")}`,
        author: agent.name,
        blocks: [
          { heading: "Что нашёл", paragraphs: [action] },
          {
            heading: "На чём это основано",
            // Факты рядом с выводом: по ним видно, что агент не выдумал повод.
            bullets: Object.entries(facts).map(([k, v]) => `${k}: ${String(v)}`),
          },
          {
            paragraphs: [
              `Навык: ${skill}. Решение принимает владелец — агент только предлагает.`,
            ],
          },
        ],
      },
      config,
    );
    return url;
  } catch (err) {
    console.error(`[${agent.name}] отчёт в Notion не опубликован:`, err);
    return null;
  }
}
