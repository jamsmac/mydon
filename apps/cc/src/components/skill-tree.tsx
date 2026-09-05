import { Fragment } from "react";
import type { SkillDeckItem } from "../lib/core";
import { plural } from "../lib/format";
import { TIER_LABEL } from "../lib/labels";

/**
 * Карта навыков: кто что умеет и каким инструментом.
 *
 * Витрина отвечает «что запустить сейчас», карта — «чем система вообще
 * располагает»: агент, его навыки, разрешённые инструменты и одноимённые
 * навыки у соседей. Одно имя у двух агентов — не ошибка, но владелец обязан
 * видеть, что порог у такого навыка общий и берётся по самому строгому:
 * иначе слабый агент сделал бы без спроса то, что у соседа под согласованием.
 */
export function SkillTree({ items }: { items: SkillDeckItem[] }) {
  const byAgent = new Map<string, SkillDeckItem[]>();
  for (const item of items) {
    const list = byAgent.get(item.agent);
    if (list) list.push(item);
    else byAgent.set(item.agent, [item]);
  }
  const agents = [...byAgent.entries()].sort(([a], [b]) => a.localeCompare(b, "ru"));

  return (
    <div className="rows">
      {agents.map(([agent, skills]) => (
        // Fragment, а не div: строки обязаны остаться прямыми детьми `.rows`,
        // иначе `.row:last-child` снимает разделитель у каждой группы, а не у
        // последней строки списка.
        <Fragment key={agent}>
          <div className="row">
            <div className="t">
              <b>{agent}</b>
              <small>
                {skills.length} {plural(skills.length, "навык", "навыка", "навыков")}
              </small>
            </div>
          </div>
          {skills.map((s) => (
            <div className="row" key={s.skill} style={{ paddingLeft: 30 }}>
              <div className="t">
                <b style={{ fontWeight: 500 }}>{s.skill}</b>
                <small>
                  {s.allowedTools.length > 0 ? s.allowedTools.join(", ") : "без инструментов"}
                </small>
              </div>
              {s.duplicates > 1 && (
                <span className="pill num">
                  ×{s.duplicates}
                  {s.tierFloor ? `, тир не ниже «${TIER_LABEL[s.tierFloor] ?? s.tierFloor}»` : ""}
                </span>
              )}
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}
