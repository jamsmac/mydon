import { describe, expect, it, vi } from "vitest";

// `page.tsx` тянет клиент Core, а тот первой строкой импортирует пакет
// `server-only`, которого вне RSC не существует.
vi.mock("../../lib/core", () => ({
  core: { audit: vi.fn(), people: vi.fn() },
  CoreUnavailable: class CoreUnavailable extends Error {},
}));

import { ACTION_LABELS, actorLabel } from "./page";

describe("Журнал аудита: подписи действий (R-I-5)", () => {
  it("действие `collection.time_corrected` подписано по-русски, а не кодом", () => {
    // Без подписи владелец увидит в журнале голый код — 247 раз подряд.
    expect(ACTION_LABELS["collection.time_corrected"]).toBe("поправил время инкассации (перенос VendCash, +5 часов)");
  });

  it("подпись называет и причину, и величину: через год «+5 часов» объяснит запись само", () => {
    expect(ACTION_LABELS["collection.time_corrected"]).toMatch(/VendCash/);
    expect(ACTION_LABELS["collection.time_corrected"]).toMatch(/\+5 часов/);
  });

  it("прежние подписи инкассации на месте — словарь дополняется, а не переписывается", () => {
    expect(ACTION_LABELS["collection.collected"]).toBe("снял выручку");
    expect(ACTION_LABELS["collection.received"]).toBe("принял инкассацию");
    expect(ACTION_LABELS["collection.cancelled"]).toBe("отменил инкассацию");
  });
});

describe("Журнал аудита: подпись автора (R-H-9)", () => {
  const people = new Map([["0b6a3c1e-4f7d-4c2a-9b1e-2f3a4b5c6d7e", "Бехруз"]]);

  it("«ты» — только владелец", () => {
    expect(actorLabel({ actorKind: "human", actorRef: "owner" }, people)).toBe("ты");
  });

  it("агент из панели подписан по имени, а не владельцем и не безымянным «агент»", () => {
    expect(actorLabel({ actorKind: "agent", actorRef: "agent:claude-code" }, people)).toBe("агент claude-code");
  });

  it("человек с логином tailnet — своим логином, а не «ты»", () => {
    expect(actorLabel({ actorKind: "human", actorRef: "operator@mail.uz" }, people)).toBe("operator@mail.uz");
  });

  it("сотрудник — по имени из реестра", () => {
    expect(actorLabel({ actorKind: "human", actorRef: "person:0b6a3c1e-4f7d-4c2a-9b1e-2f3a4b5c6d7e" }, people)).toBe("Бехруз");
  });

  it("скрипт — «система»", () => {
    expect(actorLabel({ actorKind: "system", actorRef: "tool:backfill-machine-kinds" }, people)).toBe("система");
  });
});
