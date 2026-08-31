import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approval, entity, machineCard, moneyFlow, org, task } from "@mydon/db";
import { MAX_FIND_LIMIT } from "@mydon/shared";
import { RegistryService } from "./registry.service";

/**
 * Стаб под `byType`: сначала запрос организации (from(org)), затем выборка
 * сущностей с цепочкой where → orderBy → limit. Переданный предел
 * перехватывается — ровно он и есть предмет теста (аудит 31.08, п. 6).
 */
function byTypeDb(opts: { rows?: unknown[]; onLimit?: (n: number) => void }) {
  return {
    select: () => ({
      from: (t: unknown) => {
        if (t === org) return { where: async () => [{ id: "11111111-1111-4111-8111-111111111111" }] };
        return {
          where: () => ({
            orderBy: () => ({
              limit: async (n: number) => {
                opts.onLimit?.(n);
                return opts.rows ?? [];
              },
            }),
          }),
        };
      },
    }),
  } as never;
}

describe("Реестр: выборка по типу не режется молча", () => {
  it("предел выборки — общий потолок MAX_FIND_LIMIT, а не зашитые 500", async () => {
    let передан = 0;
    const db = byTypeDb({ onLimit: (n) => { передан = n; } });
    await new RegistryService(db).byType("globerent", "invoice");
    assert.equal(передан, MAX_FIND_LIMIT);
    // Регресс аудита: в GLOBERENT 988 registry-строк и 704 счёта — на пределе
    // в 500 панель видела 500 «всех» записей и 459 счетов и считала это правдой.
    assert.ok(передан >= 988, "потолок обязан вмещать текущий реестр GLOBERENT целиком");
  });
});

/**
 * Стаб под `briefing()`: семь независимых count-запросов, различаем по ссылке
 * на таблицу. Обе договорные выборки по entity идут подряд (сначала endDate в
 * горизонте, затем кривые даты) — их значения подаются очередью. Типизированные
 * договоры — единственный запрос по money_flow с innerJoin.
 */
function briefingDb(opts: {
  moneyOverdue?: number;
  idle?: number;
  approvals?: number;
  /** Очередь entity-запросов: [карточки с endDate в горизонте, кривые даты]. */
  entityCounts?: number[];
  typedDueSoon?: number;
  tasksOverdue?: number;
}) {
  const one = (n: number | undefined) => ({ where: async () => [{ n: n ?? 0 }] });
  const очередьEntity = [...(opts.entityCounts ?? [])];
  return {
    select: () => ({
      from: (t: unknown) => {
        if (t === moneyFlow)
          return {
            where: async () => [{ n: opts.moneyOverdue ?? 0 }],
            innerJoin: () => ({ where: async () => [{ n: opts.typedDueSoon ?? 0 }] }),
          };
        if (t === machineCard) return one(opts.idle);
        if (t === approval) return one(opts.approvals);
        if (t === entity) return one(очередьEntity.shift());
        if (t === task) return one(opts.tasksOverdue);
        return one(0);
      },
    }),
  } as never;
}

const МОМЕНТ = new Date("2026-08-31T09:00:00+05:00");

describe("Брифинг: договоры считаются и по типизированной таблице (аудит 31.08, п. 6)", () => {
  it("на исходе = карточки с endDate в горизонте + действующие договоры со сроком оплаты", async () => {
    const db = briefingDb({ entityCounts: [2, 1], typedDueSoon: 3 });
    const b = await new RegistryService(db).briefing(МОМЕНТ);
    assert.equal(b.contractsDueSoon, 5, "2 собранные карточки + 3 типизированных договора");
    assert.equal(b.contractsBadDate, 1, "кривая дата бывает только у собранной карточки");
  });

  it("пустой реестр карточек не прячет живой договорной контур", async () => {
    // Прод сегодня: entity.type='contract' — 0 строк, договоров в таблице — 265.
    // Прежний подсчёт по одному legacy-источнику держал тревогу на нуле.
    const db = briefingDb({ entityCounts: [0, 0], typedDueSoon: 4 });
    const b = await new RegistryService(db).briefing(МОМЕНТ);
    assert.equal(b.contractsDueSoon, 4);
    assert.equal(b.contractsBadDate, 0);
  });

  it("остальные тревоги не смешиваются с договорными", async () => {
    const db = briefingDb({
      moneyOverdue: 7,
      idle: 2,
      approvals: 5,
      entityCounts: [1, 0],
      typedDueSoon: 1,
      tasksOverdue: 3,
    });
    const b = await new RegistryService(db).briefing(МОМЕНТ);
    assert.equal(b.overdueMoney, 7);
    assert.equal(b.idleMachines, 2);
    assert.equal(b.pendingApprovals, 5);
    assert.equal(b.contractsDueSoon, 2);
    assert.equal(b.overdueTasks, 3);
    assert.equal(b.generatedAt, МОМЕНТ.toISOString(), "момент брифинга — параметр, не часы машины");
  });
});
