import { describe, expect, it, vi } from "vitest";

// `page.tsx` тянет клиент Core, а тот первой строкой импортирует пакет
// `server-only`, которого вне RSC не существует.
vi.mock("../../lib/core", () => ({
  core: { audit: vi.fn(), people: vi.fn() },
  CoreUnavailable: class CoreUnavailable extends Error {},
}));

import { ACTION_LABELS } from "./page";

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
