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

import { core, coreOwnerWriteHeaders, CoreUnavailable } from "./core";

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

  it("обычная (не-owner) мутация → owner-токена нет даже у владельца, но автор записи есть", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.updatePerson("p1", { name: "Пётр" });
    expect(cap.headers[0]["x-owner-action-token"]).toBeUndefined();
    // Личность теперь читается на КАЖДОЙ записи — ради авторства (R-H-9), а не
    // права: owner-токен по-прежнему решает только `opts.owner`.
    expect(cap.headers[0]["x-mydon-actor"]).toBe("owner");
  });

  it("invite/revoke/agents-autonomy — тоже owner-only", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.invitePerson("p1", ["operator"]);
    await core.revokePerson("p1");
    // Тир меняется ТОЛЬКО этим маршрутом: общий patch карточки Core
    // сознательно отбрасывает `autonomyDefault` (дефект Р-7 — панель слала
    // его туда и писала «Сохранено» над неизменённым тиром).
    await core.setAgentAutonomy("scout", "T2");
    await core.saveSystemConfig({ key: "AGENT_AUTONOMY_MAX", value: "T2" });
    expect(cap.urls[2]).toContain("/agents/scout/autonomy");
    for (const h of cap.headers) expect(h["x-owner-action-token"]).toBe("owner-secret-token");
  });

  /**
   * Блоки карточки агента (волна A2, R-A2-5) читают журнал прогонов и память
   * через классовые гарды Core (`RoutinesTokenGuard`, `EventsTokenGuard`),
   * которые — в отличие от глобального `ServiceTokenGuard` — GET анонимно НЕ
   * пропускают. Обычный `get()` токена не несёт: без него блоки получили бы
   * 401 вместо данных, и карточка объясняла бы это владельцу как поломку.
   */
  it("прогоны и память агента читаются с сервисным токеном (гарды на GET)", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: false, login: null });
    const cap = stubFetch();
    await core.agentRuns("vendhub-ops");
    await core.agentMemory("vendhub-ops");
    expect(cap.urls[0]).toContain("/routines/runs?agent=vendhub-ops");
    expect(cap.urls[1]).toContain("/events?source=agent%3Avendhub-ops");
    for (const h of cap.headers) expect(h["x-service-token"]).toBe("shared-service-token");
  });

  it("saveSystemConfig и saveLlmProfile владельцем несут owner-токен (админ-поверхность /system)", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.saveSystemConfig({ key: "AGENT_AUTONOMY_MAX", value: "T2" });
    await core.saveLlmProfile({ items: [{ key: "LLM_ROUTE", value: "openai-api" }] });
    expect(cap.urls[0]).toContain("/system/config");
    expect(cap.urls[1]).toContain("/system/config/llm-profile");
    for (const h of cap.headers) {
      expect(h["x-service-token"]).toBe("shared-service-token");
      expect(h["x-owner-action-token"]).toBe("owner-secret-token");
    }
  });

  it("saveLlmProfile НЕ владельцем → owner-токена нет (честный 403 от SystemOwnerGuard)", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: false, login: null });
    const cap = stubFetch();
    await core.saveLlmProfile({ items: [{ key: "LLM_ROUTE", value: "openai-api" }] });
    expect(cap.headers[0]["x-service-token"]).toBe("shared-service-token");
    expect(cap.headers[0]["x-owner-action-token"]).toBeUndefined();
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

/**
 * Документы (R-M-8 + личный контур).
 *
 * Два разных пояса на одном модуле Core: `DocsTokenGuard` требует СЕРВИСНЫЙ
 * токен и на чтении (обычный `get()` его не несёт), а содержимое `memory/**`
 * и профиля владельца Core отдаёт по `personalVisible` — то есть при
 * включённом ужесточении только с OWNER-токеном. Без него владелец не смог бы
 * прочитать в панели собственную память.
 */
describe("core.ts — документы: сервисный токен на чтении, личное за owner-токеном", () => {
  it("docsTree несёт сервисный токен и НЕ несёт owner-токен", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.docsTree();
    expect(cap.urls[0]).toContain("/docs/tree");
    expect(cap.headers[0]["x-service-token"]).toBe("shared-service-token");
    expect(cap.headers[0]["x-owner-action-token"]).toBeUndefined();
  });

  it("docFile владельцем несёт оба токена", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const cap = stubFetch();
    await core.docFile("memory/glossary.md");
    expect(cap.urls[0]).toContain("/docs/file?path=memory%2Fglossary.md");
    expect(cap.headers[0]["x-service-token"]).toBe("shared-service-token");
    expect(cap.headers[0]["x-owner-action-token"]).toBe("owner-secret-token");
  });

  it("docFile НЕ владельцем — только сервисный токен (отказ решает Core)", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: false, login: null });
    const cap = stubFetch();
    await core.docFile("memory/glossary.md");
    expect(cap.headers[0]["x-service-token"]).toBe("shared-service-token");
    expect(cap.headers[0]["x-owner-action-token"]).toBeUndefined();
  });

  it("404 и 400 — «нет такого», 403 — «личное», авария остаётся аварией", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: false, login: null });
    const statuses = [404, 400, 403, 500];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const status = statuses.shift() ?? 200;
        return { ok: false, status, json: async () => ({}) } as unknown as Response;
      }),
    );
    expect(await core.docFile("docs/net.md")).toEqual({ kind: "missing" });
    expect(await core.docFile("../etc/passwd")).toEqual({ kind: "missing" });
    expect(await core.docFile("memory/glossary.md")).toEqual({ kind: "forbidden" });
    // 500 — это уже не «нет документа», а сломанный Core: экран обязан сказать
    // «Core недоступен», а не «файл не найден».
    await expect(core.docFile("docs/DEPLOY.md")).rejects.toThrow(CoreUnavailable);
  });

  it("успех отдаётся как ok с самим файлом", async () => {
    mocks.resolveOwner.mockResolvedValue({ isOwner: true, login: "owner@x.com" });
    const file = { path: "CLAUDE.md", root: "CLAUDE.md", title: "MYDON", bytes: 10, updatedAt: "2026-09-06T00:00:00.000Z", markdown: "# MYDON\n" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => file }) as unknown as Response));
    expect(await core.docFile("CLAUDE.md")).toEqual({ kind: "ok", file });
  });
});
