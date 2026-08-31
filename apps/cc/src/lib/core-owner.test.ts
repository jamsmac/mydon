import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Токены Core читаются в core.ts на импорте — ставим их ДО загрузки модуля
// (hoisted выполняется раньше статических import'ов).
const mocks = vi.hoisted(() => {
  process.env.SERVICE_TOKEN = "shared-service-token";
  process.env.OWNER_ACTION_TOKEN = "owner-secret-token";
  return { resolveOwner: vi.fn<() => Promise<{ isOwner: boolean; login: string | null }>>() };
});

// Заглушаем owner-резолвер — так тест управляет «кто смотрит», не трогая
// next/headers, и настоящий owner.ts (с `next/headers`) в тест не тянется.
vi.mock("./owner", () => ({ resolveOwner: mocks.resolveOwner }));

import { core, coreOwnerWriteHeaders } from "./core";

/** Перехват fetch: копим заголовки каждого запроса. */
function stubFetch(): { headers: Record<string, string>[]; urls: string[] } {
  const headers: Record<string, string>[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      headers.push((init?.headers as Record<string, string>) ?? {});
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
  return { headers, urls };
}

beforeEach(() => {
  mocks.resolveOwner.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("core.ts — owner-токен только для owner-действий и только владельцу (R-P5-5)", () => {
  it("owner-only мутация владельцем → несёт x-owner-action-token поверх сервисного", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.setPersonRoles("p1", ["operator"]);
    expect(cap.headers).toHaveLength(1);
    expect(cap.headers[0]["x-service-token"]).toBe("shared-service-token");
    expect(cap.headers[0]["x-owner-action-token"]).toBe("owner-secret-token");
  });

  it("owner-only мутация НЕ владельцем → owner-токена нет (только сервисный)", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: false, login: null });
    const cap = stubFetch();
    await core.setPersonRoles("p1", ["operator"]);
    expect(cap.headers[0]["x-service-token"]).toBe("shared-service-token");
    expect(cap.headers[0]["x-owner-action-token"]).toBeUndefined();
  });

  it("обычная (не-owner) мутация → owner-токена нет даже у владельца, резолвер не зовётся", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.updatePerson("p1", { name: "Пётр" });
    expect(cap.headers[0]["x-owner-action-token"]).toBeUndefined();
    expect(mocks.resolveOwner).not.toHaveBeenCalled();
  });

  it("invite/revoke/agents-autonomy — тоже owner-only", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.invitePerson("p1", ["operator"]);
    await core.revokePerson("p1");
    await core.updateAgent("scout", { autonomyDefault: "T2" });
    await core.saveSystemConfig({ key: "AGENT_AUTONOMY_MAX", value: "T2" });
    for (const h of cap.headers) expect(h["x-owner-action-token"]).toBe("owner-secret-token");
  });

  it("owner-only чтение личного контура несёт owner-токен, чужой домен — нет", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.entitiesOf("personal");
    await core.entitiesOf("vendhub");
    expect(cap.urls[0]).toContain("domain=personal");
    expect(cap.headers[0]["x-owner-action-token"]).toBe("owner-secret-token");
    expect(cap.urls[1]).toContain("domain=vendhub");
    expect(cap.headers[1]["x-owner-action-token"]).toBeUndefined();
  });

  // R-P5-4/R-P5-6: Core гейтит PersonalDomainGuard'ом ЛЮБОЙ запрос с
  // domain=personal (query/param/body), не только реестр. Задачи и поиск личного
  // контура обязаны нести owner-токен так же, как entitiesOf/obligations, иначе
  // под enforcement владелец 403-ит собственные вкладки «Задачи»/«Команда» и
  // поиск ассистента. Чужой домен — токена нет (GET открыт в tailnet).
  it("tasks(domain=personal) владельцем несёт owner-токен, чужой домен — нет", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.tasks({ domain: "personal" });
    await core.tasks({ domain: "vendhub" });
    await core.tasks();
    expect(cap.urls[0]).toContain("domain=personal");
    expect(cap.headers[0]["x-owner-action-token"]).toBe("owner-secret-token");
    expect(cap.headers[1]["x-owner-action-token"]).toBeUndefined();
    expect(cap.headers[2]["x-owner-action-token"]).toBeUndefined();
  });

  it("taskBoard(domain=personal) владельцем несёт owner-токен на каждой странице", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    // taskBoard пагинирует и итерирует страницу — fetch обязан отдать массив.
    const headers: Record<string, string>[] = [];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        urls.push(String(url));
        headers.push((init?.headers as Record<string, string>) ?? {});
        return { ok: true, json: async () => [] } as unknown as Response;
      }),
    );
    await core.taskBoard({ domain: "personal", open: "1" });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain("domain=personal");
    for (const h of headers) expect(h["x-owner-action-token"]).toBe("owner-secret-token");
  });

  it("search(q, 'personal') владельцем несёт owner-токен, без домена — нет", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.search("дом", "personal");
    await core.search("дом");
    expect(cap.urls[0]).toContain("domain=personal");
    expect(cap.headers[0]["x-owner-action-token"]).toBe("owner-secret-token");
    expect(cap.headers[1]["x-owner-action-token"]).toBeUndefined();
  });

  it("tasks(domain=personal) НЕ владельцем → owner-токена нет (честный 403 от Core)", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: false, login: null });
    const cap = stubFetch();
    await core.tasks({ domain: "personal" });
    expect(cap.urls[0]).toContain("domain=personal");
    expect(cap.headers[0]["x-owner-action-token"]).toBeUndefined();
  });

  it("coreOwnerWriteHeaders (путь decideApproval): владелец → с токеном, чужой → без", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const asOwner = await coreOwnerWriteHeaders();
    expect(asOwner["x-owner-action-token"]).toBe("owner-secret-token");
    expect(asOwner["x-service-token"]).toBe("shared-service-token");

    mocks.resolveOwner.mockResolvedValue({ isOwner: false, login: null });
    const asStranger = await coreOwnerWriteHeaders();
    expect(asStranger["x-owner-action-token"]).toBeUndefined();
    expect(asStranger["x-service-token"]).toBe("shared-service-token");
  });
});
