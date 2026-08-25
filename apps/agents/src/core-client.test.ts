import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { AgentsCoreClient } from "./core-client";

/**
 * Таймаут приёма вендинга — отдельный от обычного.
 *
 * 24.08.2026 сбор Ourvend начал падать каждые три часа: `This operation was
 * aborted`, `machines_ok=0`, 16–20 секунд на прогон. Приём слотов у Core —
 * одна транзакция на сотни строк, и после перевода базы на внешний Postgres
 * по TLS (`verify-full`) он перестал укладываться в 10 секунд. Клиент рвал
 * соединение, сбор помечался `failed`, продажи и детектор заливок не
 * запускались вовсе — а Core транзакцию всё же дописывал, и снимки слотов
 * появлялись в базе «сами по себе».
 *
 * Проверяем не «код читает env», а именно СРОК: сколько живёт AbortSignal
 * конкретного вызова. Таймеры подменены — иначе тест ждал бы минуту.
 */

const настоящийFetch = globalThis.fetch;

/**
 * Подмена fetch: запоминает signal и НЕ отвечает никогда — ровно как база,
 * которая ещё пишет транзакцию. Судьбу запроса решает только таймер клиента.
 */
function зависшийFetch(): { сигналы: AbortSignal[] } {
  const сигналы: AbortSignal[] = [];
  globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
    if (init?.signal) сигналы.push(init.signal);
    return new Promise<Response>(() => {});
  }) as typeof globalThis.fetch;
  return { сигналы };
}

afterEach(() => {
  globalThis.fetch = настоящийFetch;
  mock.timers.reset();
});

describe("Клиент агентов к Core: срок ожидания приёма", () => {
  it("обычный вызов по-прежнему обрывается через 10 секунд", async () => {
    // Ослаблять общий таймаут не собирались: зависший «/health» должен
    // отваливаться быстро, иначе агент простаивает на пустом месте.
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core");
    void core.health().catch(() => {});
    await Promise.resolve();
    const signal = сигналы[0]!;
    mock.timers.tick(9_999);
    assert.equal(signal.aborted, false);
    mock.timers.tick(1);
    assert.equal(signal.aborted, true, "обычный запрос — 10 секунд, как было");
  });

  it("приём слотов живёт минуту, а не десять секунд (дефолт)", async () => {
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core");
    void core.ingestVendingSlots({ machines: [] }).catch(() => {});
    await Promise.resolve();
    const signal = сигналы[0]!;
    mock.timers.tick(10_000);
    assert.equal(signal.aborted, false, "на десятой секунде приём обрывался — из-за этого и падал сбор");
    mock.timers.tick(49_999);
    assert.equal(signal.aborted, false);
    mock.timers.tick(1);
    assert.equal(signal.aborted, true, "но и вечно ждать нельзя: минута — потолок");
  });

  it("приём продаж и детектор заливок ждут столько же", async () => {
    // Оба идут после слотов в том же прогоне и упираются в ту же базу.
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core");
    void core
      .ingestVendingSales({ periodStart: "2026-08-24T00:00:00Z", periodEnd: "2026-08-24T04:00:00Z", productSales: [], machineSales: [] })
      .catch(() => {});
    void core.detectRefillEvents(2).catch(() => {});
    await Promise.resolve();
    assert.equal(сигналы.length, 2);
    mock.timers.tick(10_000);
    for (const s of сигналы) assert.equal(s.aborted, false);
    mock.timers.tick(50_000);
    for (const s of сигналы) assert.equal(s.aborted, true);
  });

  it("учётный снапшот П2 ждёт столько же: та же база, перезапись сутками", async () => {
    // `/ourvend/snapshot` кладёт пачку суток, и каждые сутки — это удаление
    // прежних строк по (день, автомат) и запись новых. Догон до 14 дней по
    // всему парку упирается в ту же базу, что и приём слотов; обрыв здесь
    // молча оставляет учётный поток без суток, а паритет — без зелёного дня.
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core");
    void core.pushOurvendSnapshot({ sales: [] }).catch(() => {});
    await Promise.resolve();
    const signal = сигналы[0]!;
    mock.timers.tick(10_000);
    assert.equal(signal.aborted, false);
    mock.timers.tick(50_000);
    assert.equal(signal.aborted, true);
  });

  it("срок приёма настраивается: конструктор берёт его четвёртым аргументом (CORE_INGEST_TIMEOUT_MS)", async () => {
    // Парк растёт, а вместе с ним и транзакция приёма. Чинить это выкаткой
    // нового образа — плохой план для аварии в три часа ночи.
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core", 10_000, "", 120_000);
    void core.ingestVendingSlots({ machines: [] }).catch(() => {});
    await Promise.resolve();
    const signal = сигналы[0]!;
    mock.timers.tick(60_000);
    assert.equal(signal.aborted, false);
    mock.timers.tick(60_000);
    assert.equal(signal.aborted, true);
  });
});
