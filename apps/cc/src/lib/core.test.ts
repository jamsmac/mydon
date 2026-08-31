import { MAX_FIND_LIMIT } from "@mydon/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
// Клиент Core первой строкой импортирует пакет `server-only`, которого вне RSC
// не существует. Обычно тесты панели глушат сам клиент (vi.mock("../lib/core")),
// но здесь предмет теста — ИМЕННО клиент: пакет подменён заглушкой алиасом
// `server-only` → src/test/server-only.ts в vitest.config.mts.
import { core } from "./core";

/** Перехват fetch: возвращаем пустой успешный ответ, копим запрошенные URL. */
function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return { ok: true, json: async () => [] } as unknown as Response;
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Регресс аудита 31.08 (п. 6): реестр GLOBERENT — 988 строк и 704 счёта, а на
 * умолчании Core (limit=500) панель молча показывала 500 «всех» записей и 459
 * счетов — усечение без признака усечения читалось как полный реестр. Панель
 * ходит в Core через entitiesOf/entitiesOfType — откат явного limit здесь
 * обязан ронять тест, а не только комментарий.
 */
describe("Реестр направления: клиент просит потолок Core, а не умолчание в 500", () => {
  it("entitiesOf шлёт limit=MAX_FIND_LIMIT", async () => {
    const urls = stubFetch();
    await core.entitiesOf("globerent");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/entities?domain=globerent&limit=${MAX_FIND_LIMIT}`);
  });

  it("entitiesOfType шлёт limit=MAX_FIND_LIMIT", async () => {
    const urls = stubFetch();
    await core.entitiesOfType("globerent", "invoice");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/entities?domain=globerent&type=invoice&limit=${MAX_FIND_LIMIT}`);
  });

  it("contractorsAll шлёт limit=MAX_FIND_LIMIT (тот же класс усечения)", async () => {
    const urls = stubFetch();
    await core.contractorsAll();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/entities?type=contractor&limit=${MAX_FIND_LIMIT}`);
  });

  it("потолок вмещает текущий реестр GLOBERENT целиком", () => {
    // 988 registry-строк на проде — сверено read-only при аудите.
    expect(MAX_FIND_LIMIT).toBeGreaterThanOrEqual(988);
  });
});
