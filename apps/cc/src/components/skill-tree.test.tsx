import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SkillDeckItem } from "../lib/core";
import { SkillTree } from "./skill-tree";

function item(over: Partial<SkillDeckItem> = {}): SkillDeckItem {
  return {
    agent: "finance",
    skill: "audit-money",
    description: "Сверяет деньги",
    executor: "code",
    tier: "T1",
    triggers: [],
    allowedTools: ["Read", "Grep"],
    modelEffort: null,
    maxTokens: null,
    hasCode: true,
    problems: [],
    agentStatus: "active",
    business: "shared",
    autonomyDefault: "T1",
    enabled: true,
    crons: [],
    tierFloor: "T1",
    duplicates: 1,
    lastRun: null,
    ...over,
  };
}

describe("карта навыков", () => {
  it("одноимённый навык у двух агентов помечен числом носителей и самым строгим тиром", () => {
    render(
      <SkillTree
        items={[
          item({ agent: "finance", tier: "T1", duplicates: 2, tierFloor: "T3" }),
          item({ agent: "globerent-ops", tier: "T3", duplicates: 2, tierFloor: "T3" }),
        ]}
      />,
    );

    const marks = screen.getAllByText(/×2/);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent("тир не ниже «многое — сам»");
  });

  it("уникальный навык не помечается дублем и показывает свои инструменты", () => {
    render(<SkillTree items={[item()]} />);

    expect(screen.queryByText(/×1/)).not.toBeInTheDocument();
    expect(screen.getByText("Read, Grep")).toBeVisible();
  });

  it("группирует навыки по агентам", () => {
    render(<SkillTree items={[item(), item({ agent: "globerent-ops", skill: "watch-prices" })]} />);

    expect(screen.getByText("finance")).toBeVisible();
    expect(screen.getByText("globerent-ops")).toBeVisible();
  });
});
