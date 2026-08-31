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
 * Стаб под `briefing()`. Тревожные категории теперь выбирают ID (число тревог —
 * длина списка, состав — сами id), поэтому стаб отдаёт им СТРОКИ-id нужной
 * длины, а не `[{ n }]`. Не-тревожные счётчики (согласования, кривые даты)
 * по-прежнему возвращают `[{ n }]`. Обе выборки по entity идут подряд: сначала
 * договоры-карточки с endDate в горизонте (id-строки), затем кривые даты
 * (count). Типизированные договоры — запрос по money_flow с innerJoin.
 *
 * `ids(n, tag)` даёт n РАЗНЫХ id — важно, чтобы distinct и хеши состава считались
 * как в бою. `overrideIds` позволяет задать точный набор (для проверки, что при
 * РОТАЦИИ на том же числе хеш состава меняется).
 */
function ids(n: number, tag: string): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}` }));
}

function briefingDb(opts: {
  moneyOverdue?: number;
  idle?: number;
  approvals?: number;
  /** Очередь entity-запросов: [карточки с endDate в горизонте, кривые даты]. */
  entityCounts?: number[];
  typedDueSoon?: number;
  tasksOverdue?: number;
  /** Точные наборы id (перекрывают длины) — для проверки состава/ротации. */
  overrideIds?: {
    money?: string[];
    idle?: string[];
    legacy?: string[];
    typed?: string[];
    tasks?: string[];
  };
}) {
  const one = (n: number | undefined) => ({ where: async () => [{ n: n ?? 0 }] });
  const rows = (n: number | undefined, tag: string, override?: string[]) => ({
    where: async () => (override ? override.map((id) => ({ id })) : ids(n ?? 0, tag)),
  });
  const очередьEntity = [...(opts.entityCounts ?? [])];
  let entityCall = 0;
  const ov = opts.overrideIds ?? {};
  return {
    select: () => ({
      from: (t: unknown) => {
        if (t === moneyFlow)
          return {
            // overdueMoney — выбор id.
            where: async () =>
              ov.money ? ov.money.map((id) => ({ id })) : ids(opts.moneyOverdue ?? 0, "money"),
            // contractsDueSoonTyped — выбор contractId с innerJoin.
            innerJoin: () => ({
              where: async () =>
                (ov.typed ?? ids(opts.typedDueSoon ?? 0, "typed").map((r) => r.id)).map(
                  (contractId) => ({ contractId }),
                ),
            }),
          };
        if (t === machineCard) return rows(opts.idle, "idle", ov.idle);
        if (t === approval) return one(opts.approvals);
        if (t === entity) {
          const call = entityCall++;
          // Первый entity-запрос — договоры-карточки (id), второй — кривые даты (count).
          if (call === 0) return rows(очередьEntity[0], "legacy", ov.legacy);
          return one(очередьEntity[1]);
        }
        if (t === task) return rows(opts.tasksOverdue, "task", ov.tasks);
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

describe("Брифинг: различитель состава тревог меняется при РОТАЦИИ на том же числе", () => {
  it("тот же СОСТАВ id → тот же хеш (детерминизм, дедуп сработает)", async () => {
    const набор = { money: ["m2", "m1"], idle: ["a1"] };
    const b1 = await new RegistryService(briefingDb({ overrideIds: набор })).briefing(МОМЕНТ);
    // Порядок строк из БД не гарантирован — подаём тот же набор в другом порядке.
    const b2 = await new RegistryService(
      briefingDb({ overrideIds: { money: ["m1", "m2"], idle: ["a1"] } }),
    ).briefing(МОМЕНТ);
    assert.equal(b1.overdueMoney, 2);
    assert.equal(
      b1.alarmComposition.overdueMoney,
      b2.alarmComposition.overdueMoney,
      "хеш состава не зависит от порядка строк — иначе он «плыл» бы сам по себе",
    );
    assert.equal(b1.alarmComposition.idleMachines, b2.alarmComposition.idleMachines);
  });

  it("РОТАЦИЯ при том же числе → хеш меняется (владелец узнает о новом инциденте)", async () => {
    // Автомат A починен, встал B: idleMachines по-прежнему 1, но СОСТАВ иной.
    const было = await new RegistryService(
      briefingDb({ overrideIds: { idle: ["A"] } }),
    ).briefing(МОМЕНТ);
    const стало = await new RegistryService(
      briefingDb({ overrideIds: { idle: ["B"] } }),
    ).briefing(МОМЕНТ);
    assert.equal(было.idleMachines, 1);
    assert.equal(стало.idleMachines, 1, "число простаивающих не изменилось");
    assert.notEqual(
      было.alarmComposition.idleMachines,
      стало.alarmComposition.idleMachines,
      "состав сменился — хеш обязан измениться, иначе дельта-память проглотит ротацию",
    );
  });

  it("пустая категория → пустой различитель (нечего различать)", async () => {
    const b = await new RegistryService(briefingDb({})).briefing(МОМЕНТ);
    assert.equal(b.alarmComposition.overdueMoney, "");
    assert.equal(b.alarmComposition.idleMachines, "");
    assert.equal(b.alarmComposition.contractsDueSoon, "");
    assert.equal(b.alarmComposition.overdueTasks, "");
  });

  it("договоры «на исходе» из двух источников не сливаются по совпавшему UUID", async () => {
    // Один и тот же UUID как собранная карточка и как типизированный договор —
    // это ДВЕ разные тревоги: префикс e:/c: не даёт им схлопнуться.
    const b = await new RegistryService(
      briefingDb({ overrideIds: { legacy: ["dup"], typed: ["dup"] } }),
    ).briefing(МОМЕНТ);
    assert.equal(b.contractsDueSoon, 2, "карточка dup + договор dup — две позиции, не одна");
    assert.notEqual(b.alarmComposition.contractsDueSoon, "");
  });
});
