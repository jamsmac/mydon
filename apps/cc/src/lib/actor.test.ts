import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `next/headers` вне request-скоупа не работает — глушим фабрикой, как
// `owner.test.ts`. `mocks.cookie` — значение куки объявления, `mocks.login` —
// заголовок идентичности serve; `mocks.outside` — «вызов вне запроса».
const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  login: null as string | null,
  outside: false,
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    if (mocks.outside) throw new Error("cookies() вне request-скоупа");
    return { get: (name: string) => (name === "mydon_actor" && mocks.cookie !== undefined ? { value: mocks.cookie } : undefined) };
  },
  headers: async () => {
    if (mocks.outside) throw new Error("headers() вне request-скоупа");
    return { get: (name: string) => (name === "tailscale-user-login" ? mocks.login : null) };
  },
}));

import { ACTOR_COOKIE, ACTOR_COOKIE_MAX_AGE_S, declaredAgentRef, pickActor, resolveActor } from "./actor";

const OWNER = "jamshid@example.com";

beforeEach(() => {
  mocks.cookie = undefined;
  mocks.login = null;
  mocks.outside = false;
  process.env.OWNER_TAILSCALE_LOGIN = OWNER;
});

afterEach(() => {
  delete process.env.OWNER_TAILSCALE_LOGIN;
});

describe("declaredAgentRef: кука объявления → ссылка агента", () => {
  it("имя агента становится ссылкой `agent:<имя>`", () => {
    expect(declaredAgentRef("claude-code")).toBe("agent:claude-code");
    expect(declaredAgentRef("Codex")).toBe("agent:codex");
  });

  it("мусор и попытка подсунуть готовую ссылку — не объявление", () => {
    for (const bad of [undefined, "", "agent:claude-code", "owner admin", "tool:x", "клод"]) {
      expect(declaredAgentRef(bad)).toBeNull();
    }
  });
});

describe("кука объявления: короткая жизнь", () => {
  it("живёт часы, а не год, как тема — забытая не подпишет решения владельца агентом", () => {
    expect(ACTOR_COOKIE).toBe("mydon_actor");
    expect(ACTOR_COOKIE_MAX_AGE_S).toBeLessThanOrEqual(12 * 60 * 60);
  });
});

describe("pickActor: в журнал — то, что панель знает", () => {
  const AGENT = "agent:claude-code";

  it("владелец без объявления — owner", () => {
    expect(pickActor({ isOwner: true, login: OWNER }, null, true)).toBe("owner");
  });

  it("владелец объявил агента в своём браузере — автор агент", () => {
    expect(pickActor({ isOwner: true, login: OWNER }, AGENT, true)).toBe(AGENT);
  });

  it("агент объявлен — автор агент при ЛЮБОЙ личности: действие совершает он", () => {
    expect(pickActor({ isOwner: false, login: null }, AGENT, true)).toBe(AGENT);
    expect(pickActor({ isOwner: false, login: "operator@mail.uz" }, AGENT, true)).toBe(AGENT);
    expect(pickActor({ isOwner: false, login: OWNER }, AGENT, false)).toBe(AGENT);
  });

  it("другой человек в tailnet — своим логином, а не владельцем", () => {
    expect(pickActor({ isOwner: false, login: "operator@mail.uz" }, null, true)).toBe("operator@mail.uz");
  });

  it("логин не укладывается в формат ссылки — «не опознан», а не владелец и не падение записи", () => {
    expect(pickActor({ isOwner: false, login: "оператор@почта.уз" }, null, true)).toBe("tailnet:unrecognized");
    expect(pickActor({ isOwner: false, login: "two words" }, null, true)).toBe("tailnet:unrecognized");
  });

  it("заголовка нет (прямой bind, локалка) — owner, как было (R-P5-6)", () => {
    expect(pickActor({ isOwner: false, login: null }, null, true)).toBe("owner");
  });

  it("логин владельца не задан — сравнивать не с чем, owner, как было: незаданная переменная не отнимает прав", () => {
    expect(pickActor({ isOwner: false, login: "anyone@mail.uz" }, null, false)).toBe("owner");
  });
});

describe("resolveActor: чтение запроса", () => {
  it("вне запроса не бросает — это «ничего не объявлено», как у resolveOwner", async () => {
    mocks.outside = true;
    await expect(resolveActor()).resolves.toBe("owner");
  });

  it("владелец с объявленным агентом — запись подписывается агентом", async () => {
    mocks.login = OWNER;
    mocks.cookie = "claude-code";
    await expect(resolveActor()).resolves.toBe("agent:claude-code");
  });

  it("владелец без объявления — owner", async () => {
    mocks.login = OWNER;
    await expect(resolveActor()).resolves.toBe("owner");
  });

  it("другой логин при заданном логине владельца — этот человек", async () => {
    mocks.login = "operator@mail.uz";
    await expect(resolveActor()).resolves.toBe("operator@mail.uz");
  });

  it("логин владельца не задан (пустая строка в compose) — owner, как было", async () => {
    process.env.OWNER_TAILSCALE_LOGIN = "  ";
    mocks.login = "operator@mail.uz";
    await expect(resolveActor()).resolves.toBe("owner");
  });
});
