import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `next/headers` вне request-скоупа сам по себе не отдаёт заголовков — глушим
// его фабрикой, как соседние тесты глушат `next/navigation`. Через `mocks.get`
// каждый тест задаёт, что «пришло» в заголовке идентичности serve.
const mocks = vi.hoisted(() => ({ get: vi.fn<(name: string) => string | null>() }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: mocks.get }),
}));

import {
  OWNER_LOGIN_HEADER,
  matchOwner,
  ownerEnforcementEnabled,
  personalGateBlocks,
  resolveOwner,
} from "./owner";

const OWNER = "jamshid@example.com";

beforeEach(() => {
  mocks.get.mockReset();
  process.env.OWNER_TAILSCALE_LOGIN = OWNER;
  delete process.env.OWNER_IDENTITY_ENFORCED;
});

afterEach(() => {
  delete process.env.OWNER_TAILSCALE_LOGIN;
  delete process.env.OWNER_IDENTITY_ENFORCED;
});

describe("resolveOwner — единственное место чтения serve-заголовка (R-P5-1, R-P5-3)", () => {
  it("логин из заголовка совпал с владельцем → isOwner", async () => {
    mocks.get.mockImplementation((n) => (n === OWNER_LOGIN_HEADER ? OWNER : null));
    const id = await resolveOwner();
    expect(id).toEqual({ isOwner: true, login: OWNER });
  });

  it("другой логин в заголовке → не владелец, но логин виден", async () => {
    mocks.get.mockImplementation((n) => (n === OWNER_LOGIN_HEADER ? "someone@else.com" : null));
    const id = await resolveOwner();
    expect(id).toEqual({ isOwner: false, login: "someone@else.com" });
  });

  it("заголовка нет (прямой bind без serve) → login=null, не владелец", async () => {
    mocks.get.mockReturnValue(null);
    const id = await resolveOwner();
    expect(id).toEqual({ isOwner: false, login: null });
  });

  it("регистр логина не важен (tailnet-логины регистронезависимы)", async () => {
    mocks.get.mockImplementation((n) => (n === OWNER_LOGIN_HEADER ? OWNER.toUpperCase() : null));
    const id = await resolveOwner();
    expect(id.isOwner).toBe(true);
  });
});

describe("matchOwner — чистое сопоставление (тестируемо без Next)", () => {
  it("OWNER_TAILSCALE_LOGIN не задан → владельца опознать нельзя даже при логине", () => {
    expect(matchOwner(OWNER, undefined)).toEqual({ isOwner: false, login: OWNER });
    expect(matchOwner(OWNER, "")).toEqual({ isOwner: false, login: OWNER });
  });

  it("пустой/пробельный логин нормализуется в null", () => {
    expect(matchOwner("   ", OWNER)).toEqual({ isOwner: false, login: null });
    expect(matchOwner(null, OWNER)).toEqual({ isOwner: false, login: null });
  });
});

describe("ownerEnforcementEnabled — флаг гейта (R-P5-6, дефолт ВЫКЛ)", () => {
  it("по умолчанию выключен", () => {
    expect(ownerEnforcementEnabled()).toBe(false);
  });
  it("включается только строгим '1'", () => {
    process.env.OWNER_IDENTITY_ENFORCED = "1";
    expect(ownerEnforcementEnabled()).toBe(true);
    process.env.OWNER_IDENTITY_ENFORCED = "true";
    expect(ownerEnforcementEnabled()).toBe(false);
    process.env.OWNER_IDENTITY_ENFORCED = "0";
    expect(ownerEnforcementEnabled()).toBe(false);
  });
});

describe("personalGateBlocks — гейт личного контура под флагом (R-P5-4, R-P5-6)", () => {
  const owner = { isOwner: true, login: OWNER };
  const stranger = { isOwner: false, login: "someone@else.com" };
  const anon = { isOwner: false, login: null };

  it("флаг ВКЛ + чужой заголовок → блок", () => {
    expect(personalGateBlocks("personal", stranger, true)).toBe(true);
  });

  it("флаг ВКЛ + владелец → пропуск", () => {
    expect(personalGateBlocks("personal", owner, true)).toBe(false);
  });

  it("флаг ВКЛ, но заголовка нет (прямой bind) → пропуск, владельца не запираем (R-P5-6)", () => {
    expect(personalGateBlocks("personal", anon, true)).toBe(false);
  });

  it("флаг ВЫКЛ → пропуск даже для чужого (как сейчас, R-P5-6)", () => {
    expect(personalGateBlocks("personal", stranger, false)).toBe(false);
  });

  it("прочие домены не гейтятся даже при чужом и включённом флаге", () => {
    expect(personalGateBlocks("vendhub", stranger, true)).toBe(false);
    expect(personalGateBlocks("globerent", stranger, true)).toBe(false);
  });
});
