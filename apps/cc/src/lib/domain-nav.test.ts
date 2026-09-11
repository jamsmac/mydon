import { describe, expect, it } from "vitest";
import { groupsFor, isTableBackedLeaf } from "./domain-nav";

describe("рабочее место VendHub", () => {
  const groups = groupsFor("vendhub");
  const park = groups.find((g) => g.key === "park");

  it("«Парк» — группа направления, а не раздел общей системы", () => {
    // Слово владельца 09.09.2026: «у GLOBERENT другая деятельность, при
    // необходимости скопируем методы». До этого места, узлы и обслуживание
    // жили в сквозной группе «Система», хотя спрашивали Core строкой
    // entitiesOfType("vendhub", …) — то есть были вендинговыми всегда.
    expect(park).toBeDefined();
    expect(park?.leaves.map((l) => l.type)).toEqual(["places", "parts", "maintenance"]);
  });

  it("группа открывается на «Местах», а не на том, где первым появились данные", () => {
    expect(park?.defaultLeaf).toBe("places");
  });

  it("листья «Парка» не гаснут: их данные не карточки реестра", () => {
    // Счёт по entity.byType у всех трёх был бы нулевым или неверным («Места» —
    // три разных типа сразу), и чипы погасли бы серыми, будто там пусто.
    for (const l of park?.leaves ?? []) {
      expect(isTableBackedLeaf(l.type), `${l.type} не в TABLE_BACKED_LEAVES`).toBe(true);
    }
  });

  it("у GLOBERENT своего «Парка» нет — методы копируются, а не делятся", () => {
    expect(groupsFor("globerent").some((g) => g.key === "park")).toBe(false);
  });
});
