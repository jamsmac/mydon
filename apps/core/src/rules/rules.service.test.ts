import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { event } from "@mydon/db";
import { EventsService } from "../events/events.service";
import { PENDING_EVENTS_LIMIT, RulesService } from "./rules.service";

type Событие = { id: string; source: string; type: string; payload: Record<string, unknown>; occurredAt: Date };

/** Значения-параметры условия drizzle: стабу нужны и список типов, и `since`. */
function параметры(cond: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    const v = (n as { value?: unknown }).value;
    if (typeof v === "string" || v instanceof Date) out.push(v);
  };
  walk(cond);
  return out;
}

/**
 * Стаб журнала, который РЕЖЕТ так же, как Postgres: сперва `where`, потом
 * сортировка, и только потом `limit`.
 *
 * Порядок здесь — весь смысл проверки. Стаб, отдающий фикстуру целиком,
 * зеленел бы и на прежнем коде, где лимит выбирался шумом крона, а события
 * правил оставались за окном.
 */
function журнал(события: Событие[]) {
  const db = {
    select: () => ({
      from: (t: unknown) => {
        if (t !== event) {
          // notification_delivery: доставленного в этих проверках нет.
          return { where: async () => [] };
        }
        let текущие = события;
        const chain: Record<string, unknown> = {};
        chain.where = (cond?: unknown) => {
          const п = параметры(cond);
          const типы = п.filter((v): v is string => typeof v === "string");
          const since = п.find((v): v is Date => v instanceof Date);
          текущие = текущие.filter(
            (e) => (типы.length === 0 || типы.includes(e.type)) && (!since || e.occurredAt >= since),
          );
          return chain;
        };
        chain.orderBy = () => {
          текущие = [...текущие].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
          return chain;
        };
        chain.limit = async (n: number) => текущие.slice(0, n);
        return chain;
      },
    }),
  } as never;
  return new RulesService(new EventsService(db), db);
}

const момент = (сдвигЧасов: number): Date => new Date(Date.parse("2026-08-25T07:00:00.000Z") - сдвигЧасов * 3_600_000);

/** Шум крона: на проде это 4180 строк `sales.sync`/`supply.sync` за 14 суток. */
const шум = (n: number): Событие[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `noise-${i}`,
    source: "agents",
    type: i % 2 === 0 ? "sales.sync" : "supply.sync",
    payload: {},
    // Шум СВЕЖЕЕ полезных событий — иначе лимит его и не выбрал бы.
    occurredAt: момент(i * 0.01),
  }));

const тревога = (id: string, часовНазад: number): Событие => ({
  id,
  source: "vending",
  type: "ourvend.sync_failed_streak",
  payload: { streak: 12, since: "2026-08-24T09:00:00+05:00", lastError: "This operation was aborted" },
  occurredAt: момент(часовНазад),
});

describe("Сигналы по правилам: выборка режется по ТИПУ, а не по шуму (прод-данные, п. 2)", () => {
  it("600 событий шума и три тревоги — возвращаются все три", async () => {
    const svc = журнал([...шум(600), тревога("a", 300), тревога("b", 200), тревога("c", 100)]);
    const r = await svc.pending(момент(14 * 24));

    assert.equal(r.notifications.length, 3, "тревоги старше шума выпали бы из окна без фильтра по типу");
    assert.deepEqual(r.notifications.map((n) => n.eventId).sort(), ["a", "b", "c"]);
    assert.equal(r.events, 3, "«событий» — это события ПОД ПРАВИЛА, шум крона сюда не входит");
    assert.equal(r.truncated, false);
  });

  it("упёрлись в лимит — говорим об этом, а не отдаём обрезок за полную ленту", async () => {
    const svc = журнал(Array.from({ length: PENDING_EVENTS_LIMIT + 10 }, (_, i) => тревога(`t${i}`, i * 0.01)));
    const r = await svc.pending(момент(14 * 24));

    assert.equal(r.events, PENDING_EVENTS_LIMIT);
    assert.equal(r.truncated, true);
  });

  it("окно `since` соблюдается: событие старше окна не приезжает", async () => {
    const svc = журнал([тревога("свежая", 1), тревога("древняя", 30 * 24)]);
    const r = await svc.pending(момент(7 * 24));

    assert.deepEqual(r.notifications.map((n) => n.eventId), ["свежая"]);
  });
});
