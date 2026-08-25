import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CoreClient, NotAMachineError, type EntityRow } from "./core-client";

/**
 * Клиент Core: проверяем ровно то, что решает судьбу записи в поле, — как
 * склеивается путь запроса и чему верим в ответе. Остальные методы проверяются
 * через мастера, у которых `core` подменён целиком.
 */

const настоящийFetch = globalThis.fetch;

/** Подмена fetch: отдаём готовую карточку и запоминаем запрошенный путь. */
function стубFetch(row: Partial<EntityRow>): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "e1", type: "machine", name: "Olma", externalRef: null, attrs: {}, ...row }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { urls };
}

afterEach(() => {
  globalThis.fetch = настоящийFetch;
});

describe("Серийник автомата по карточке", () => {
  it("id уезжает в путь закодированным (S7)", async () => {
    // Сегодня пикер пропускает только id-подобное, но метод публичный и живёт
    // дольше своего вызывающего: незакодированный сегмент однажды позволит
    // дописать к пути что угодно.
    const { urls } = стубFetch({ externalRef: "c2508160376" });
    const core = new CoreClient("http://core", 1000, "");
    await core.machineSerial("11111111-1111-4111-8111-111111111111/../vending/refills?x=1");
    assert.equal(
      urls[0],
      "http://core/entities/11111111-1111-4111-8111-111111111111%2F..%2Fvending%2Frefills%3Fx%3D1",
    );
  });

  it("серийник приводится к канону", async () => {
    стубFetch({ externalRef: "C2508160376" });
    const core = new CoreClient("http://core", 1000, "");
    assert.equal(await core.machineSerial("e1"), "2508160376");
  });

  it("карточка не автомата — отказ, а не чужой externalRef (S7)", async () => {
    // Иначе заливка легла бы на код склада или помещения: запись есть, автомата
    // за ней нет, и найти её потом нечем.
    стубFetch({ type: "warehouse", externalRef: "SKLAD-1" });
    const core = new CoreClient("http://core", 1000, "");
    await assert.rejects(() => core.machineSerial("e1"), NotAMachineError);
  });
});
