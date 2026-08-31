import { describe, expect, it } from "vitest";
import { groupTasksByDirection } from "./task-directions";

describe("groupTasksByDirection", () => {
  it("сохраняет canonical-порядок и ставит legacy null последним", () => {
    const groups = groupTasksByDirection([
      { id: "null", domain: null },
      { id: "mydon", domain: "mydon" },
      { id: "vendhub", domain: "vendhub" },
      { id: "globerent", domain: "globerent" },
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      "globerent",
      "vendhub",
      "mydon",
      "unassigned",
    ]);
    expect(groups.at(-1)?.label).toBe("Без направления");
    expect(groups.at(-1)?.tasks).toEqual([{ id: "null", domain: null }]);
  });

  it("не прячет неизвестное legacy-значение", () => {
    const groups = groupTasksByDirection([{ id: "legacy", domain: "old-direction" }]);
    expect(groups).toEqual([
      {
        key: "unassigned",
        label: "Без направления",
        tasks: [{ id: "legacy", domain: "old-direction" }],
      },
    ]);
  });
});
