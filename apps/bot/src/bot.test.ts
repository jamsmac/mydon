import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectGloberentSignals,
  countStuckDeals,
  countUnpaidContracts,
  formatBriefing,
  msUntilBriefing,
} from "./briefing";
import { CoreError } from "./core-client";
import { handleMessage, parseApprovalCallback, type HandlerDeps } from "./handler";
import { parseIntent } from "./intent";
import { parseAllowlist, RateLimiter } from "./security/access";

describe("Разбор вопросов на русском (FR-4)", () => {
  it("узнаёт брифинг", () => {
    assert.equal(parseIntent("брифинг").kind, "briefing");
    assert.equal(parseIntent("что за ночь произошло").kind, "briefing");
  });

  it("узнаёт просрочку", () => {
    assert.equal(parseIntent("что просрочено").kind, "overdue");
  });

  it("узнаёт простой автоматов", () => {
    assert.equal(parseIntent("какие автоматы простаивают").kind, "machines");
  });

  it("«сколько должен Olma» — это поиск контрагента, а не общая просрочка", () => {
    const intent = parseIntent("сколько должен Olma");
    assert.equal(intent.kind, "search");
    if (intent.kind === "search") assert.match(intent.query, /Olma/i);
  });

  it("узнаёт направление по слову", () => {
    const intent = parseIntent("обязательства глоберент");
    assert.equal(intent.kind, "obligations");
    if (intent.kind === "obligations") assert.equal(intent.domain, "globerent");
  });

  it("непонятное уходит в unknown, а не падает", () => {
    assert.equal(parseIntent("абырвалг").kind, "unknown");
    assert.equal(parseIntent("").kind, "unknown");
  });
});

describe("Брифинг", () => {
  const base = {
    generatedAt: "2026-07-26T02:30:00Z",
    tz: "Asia/Tashkent",
    overdueMoney: 0,
    idleMachines: 0,
    pendingApprovals: 0,
    contractsDueSoon: 0,
  };

  it("когда всё спокойно — говорит об этом прямо", () => {
    const text = formatBriefing(base);
    assert.match(text, /Тревог нет/);
  });

  it("показывает только сработавшие тревоги", () => {
    const text = formatBriefing({ ...base, overdueMoney: 3, idleMachines: 2 });
    assert.match(text, /Просрочено платежей: 3/);
    assert.match(text, /Автоматы простаивают: 2/);
    assert.doesNotMatch(text, /Договоры на исходе: 0/);
  });

  it("строка закупа появляется, когда есть что заказать", () => {
    const text = formatBriefing(base, [], { positions: 3, costRounded: 84000 });
    assert.match(text, /🛒 К закупу: 3 поз\. на ~84\s?000 сум — «оформить закуп»/);
  });

  it("раздача (П5a): «со склада» в строке закупа, когда склад что-то закрывает", () => {
    const text = formatBriefing(base, [], { positions: 3, costRounded: 84000, fromStock: 5 });
    assert.match(text, /🛒 К закупу: 3 поз\. на ~84\s?000 сум · со склада 5 — «оформить закуп»/);
    // Склад пуст — хвоста нет: «со склада 0» читалось бы как отдельный сигнал.
    assert.doesNotMatch(formatBriefing(base, [], { positions: 3, costRounded: 84000, fromStock: 0 }), /со склада/);
  });

  it("без закупа (0 позиций) строки нет", () => {
    assert.doesNotMatch(formatBriefing(base, [], { positions: 0, costRounded: 0 }), /К закупу/);
    assert.doesNotMatch(formatBriefing(base), /К закупу/);
  });

  it("строка кофе-бункеров появляется, когда есть хоть один сигнал", () => {
    const text = formatBriefing(base, [], undefined, { underfill: 2, anomaly: 0, overdueWash: 1 });
    assert.match(text, /☕ Кофе-бункеры: недолив 2, мойка просрочена 1/);
    assert.doesNotMatch(text, /расхождение/);
  });

  it("без кофе-сигналов (всё по нулям) строки нет", () => {
    assert.doesNotMatch(
      formatBriefing(base, [], undefined, { underfill: 0, anomaly: 0, overdueWash: 0 }),
      /Кофе-бункеры/,
    );
    assert.doesNotMatch(formatBriefing(base), /Кофе-бункеры/);
  });

  it("строка GLOBERENT появляется, когда есть хоть один сигнал контуров", () => {
    const text = formatBriefing(base, [], undefined, undefined, {
      dueSoonIn: 2,
      dueSoonOut: 0,
      contractsUnpaid: 1,
      dealsStuck: 3,
    });
    assert.match(
      text,
      /🏗 GLOBERENT: получить в ≤7 дней: 2, договоры без оплаты: 1, сделки без движения >14 дней: 3/,
    );
    assert.doesNotMatch(text, /заплатить/);
  });

  it("без сигналов GLOBERENT (всё по нулям) строки нет", () => {
    const zeros = { dueSoonIn: 0, dueSoonOut: 0, contractsUnpaid: 0, dealsStuck: 0 };
    assert.doesNotMatch(formatBriefing(base, [], undefined, undefined, zeros), /GLOBERENT/);
    assert.doesNotMatch(formatBriefing(base), /GLOBERENT/);
  });

  it("время показывает в ташкентском поясе", () => {
    // 02:30 UTC = 07:30 в Ташкенте
    assert.match(formatBriefing(base), /07:30/);
  });

  it("до брифинга всегда положительное время в пределах суток", () => {
    const ms = msUntilBriefing(new Date("2026-07-26T10:00:00Z"));
    assert.ok(ms > 0 && ms <= 24 * 3600 * 1000, `получено ${ms}`);
  });
});

describe("Сигналы GLOBERENT для брифинга", () => {
  const NOW = new Date("2026-08-04T05:00:00Z");

  it("застрявшие сделки: открытая стадия + карточку не трогали дольше 14 дней", () => {
    const units = [
      { salesStage: "NEGOTIATION", updatedAt: "2026-07-01T00:00:00Z" }, // застряла
      { salesStage: "NEGOTIATION", updatedAt: "2026-08-01T00:00:00Z" }, // свежая
      { salesStage: "CLOSED", updatedAt: "2026-01-01T00:00:00Z" }, // закрыта — не считается
      { salesStage: "LOST", updatedAt: "2026-01-01T00:00:00Z" }, // потеряна — не считается
      { salesStage: null, updatedAt: "2026-01-01T00:00:00Z" }, // продажа не начата
    ];
    assert.equal(countStuckDeals(units, NOW), 1);
  });

  it("кривая дата updatedAt не считается застрявшей (не выдумываем)", () => {
    assert.equal(countStuckDeals([{ salesStage: "NEW_LEAD", updatedAt: "мусор" }], NOW), 0);
  });

  it("договоры без оплаты: только действующие с нулём поступлений", () => {
    const contracts = [
      { status: "active", paidUzs: 0 }, // тревога
      { status: "active", paidUzs: 1_000_000 }, // оплачивается
      { status: "closed", paidUzs: 0 }, // закрыт — не тревога
      { status: "cancelled", paidUzs: 0 }, // отменён — не тревога
    ];
    assert.equal(countUnpaidContracts(contracts), 1);
  });

  it("исторические карточки из выгрузки не считаются: там нет денег вовсе", () => {
    const contracts = [
      { status: "active", paidUzs: 0, createdFrom: "Didox: реестры документов" },
      { status: "active", paidUzs: 0, createdFrom: null }, // заведён в системе — тревога
      { status: "active", paidUzs: 0, createdFrom: "   " }, // пробелы — тоже свой
    ];
    assert.equal(countUnpaidContracts(contracts), 2);
  });

  it("сбор сигналов: упавший источник даёт ноль, а не прячет остальные", async () => {
    const src = {
      globerentDueSoon: () => Promise.reject(new Error("core down")),
      globerentContracts: () => Promise.resolve([{ status: "active", paidUzs: 0 }]),
      globerentUnits: () => Promise.resolve([]),
    };
    const s = await collectGloberentSignals(src, NOW);
    assert.deepEqual(s, { dueSoonIn: 0, dueSoonOut: 0, contractsUnpaid: 1, dealsStuck: 0 });
  });

  it("все три источника упали — блока нет вовсе, а не ложные нули", async () => {
    const down = () => Promise.reject(new Error("core down"));
    const s = await collectGloberentSignals(
      { globerentDueSoon: down, globerentContracts: down, globerentUnits: down },
      NOW,
    );
    assert.equal(s, undefined);
  });
});

describe("Доступ к боту", () => {
  const coreStub = {
    briefing: async () => ({
      generatedAt: new Date().toISOString(),
      tz: "Asia/Tashkent",
      overdueMoney: 0,
      idleMachines: 0,
      pendingApprovals: 0,
      contractsDueSoon: 0,
    }),
    pendingApprovals: async () => [],
  } as unknown as HandlerDeps["core"];

  it("чужому чату не отвечает вовсе", async () => {
    const deps: HandlerDeps = {
      core: coreStub,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    };
    assert.equal(await handleMessage(999, "брифинг", deps), null);
  });

  it("своему отвечает", async () => {
    const deps: HandlerDeps = {
      core: coreStub,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    };
    const reply = await handleMessage(111, "брифинг", deps);
    assert.ok(reply && reply.text.length > 0);
  });

  it("при превышении частоты просит подождать", async () => {
    const deps: HandlerDeps = {
      core: coreStub,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(1, 60_000),
    };
    await handleMessage(111, "брифинг", deps, 1000);
    const second = await handleMessage(111, "брифинг", deps, 1001);
    assert.match(second?.text ?? "", /Слишком много/);
  });
});

describe("Касса закупа: гейт по префиксу — не проваливается в приёмку накладной (регресс)", () => {
  function deps(spies: { received: number; cash: number }): HandlerDeps {
    const core = {
      ...({} as HandlerDeps["core"]),
      receiveVendingOrder: async () => {
        spies.received += 1;
        return { received: false, replenished: 0, units: 0, reason: "не должно было вызваться" };
      },
      recordVendingCash: async (
        receivedAmount: number,
        categories: { name: string; amount: number }[],
      ) => {
        spies.cash += 1;
        const totalSpent = categories.reduce((a, c) => a + c.amount, 0);
        return {
          id: "cs1",
          receivedAmount,
          categories: categories.map((c) => ({
            name: c.name,
            lines: [{ label: c.name, amount: c.amount }],
            subtotal: c.amount,
          })),
          totalSpent,
          remainder: receivedAmount - totalSpent,
          createdBy: "owner",
          createdAt: new Date().toISOString(),
        };
      },
    } as unknown as HandlerDeps["core"];
    return { core, allowlist: parseAllowlist("111"), limiter: new RateLimiter() };
  }

  it("полная команда кассы вызывает recordVendingCash, а не receiveVendingOrder", async () => {
    const spies = { received: 0, cash: 0 };
    const reply = await handleMessage(
      111,
      "касса закупа: получил 2400000, базар 376300",
      deps(spies),
    );
    assert.equal(spies.cash, 1);
    assert.equal(spies.received, 0);
    assert.match(reply?.text ?? "", /Касса закупа/);
  });

  it("«получил» без статьи — ошибка формата, НЕ приёмка накладной (реальный найденный баг)", async () => {
    // Раньше это сообщение проваливалось в isPurchaseReceiveCommand (тоже
    // содержит «получил»+«закуп») и вызывало реальную мутацию не по адресу.
    const spies = { received: 0, cash: 0 };
    const reply = await handleMessage(111, "касса закупа: получил 2400000", deps(spies));
    assert.equal(spies.received, 0, "receiveVendingOrder не должен был вызваться");
    assert.equal(spies.cash, 0);
    assert.match(reply?.text ?? "", /Не понял формат кассы/);
  });
});

describe("Бот: правила закупа и план — путь до Core (страж П5a)", () => {
  type Вызов = { product: string; patch: Record<string, unknown> };

  /** Стаб Core: копит вызовы правил, отдаёт готовый ответ на план. */
  function deps(calls: Вызов[], plan?: unknown): HandlerDeps {
    const core = {
      ...({} as HandlerDeps["core"]),
      setVendingProductRules: async (product: string, patch: Record<string, unknown>) => {
        calls.push({ product, patch });
        return { ok: true, product, before: {}, after: {} };
      },
      vendingPlan: async () => plan,
    } as unknown as HandlerDeps["core"];
    return { core, allowlist: parseAllowlist("111"), limiter: new RateLimiter() };
  }

  it("вся семья команд доходит до Core ровно тем патчем, который просил владелец", async () => {
    const calls: Вызов[] = [];
    const d = deps(calls);
    await handleMessage(111, "не закупать Twix", d);
    await handleMessage(111, "закупать Twix", d);
    await handleMessage(111, "фикс Snickers 48", d);
    await handleMessage(111, "блок Red Bull 6", d);
    assert.deepEqual(
      calls.map((c) => c.patch),
      [{ excludedFromPurchase: true }, { excludedFromPurchase: false }, { fixedPurchaseQty: 48 }, { packSize: 6 }],
    );
    assert.deepEqual(calls.map((c) => c.product), ["Twix", "Twix", "Snickers", "Red Bull"]);
  });

  it("нераспознанная команда правил в Core не уходит — только подсказка с причиной", async () => {
    const calls: Вызов[] = [];
    const reply = await handleMessage(111, "блок TUC 5000", deps(calls));
    assert.equal(calls.length, 0, "мутации быть не должно");
    assert.match(reply?.text ?? "", /Блок — от 1 до 1000 штук/);
  });

  it("400 от Core — формат и причина, а не «попробуй позже» (повтор не поможет)", async () => {
    const core = {
      ...({} as HandlerDeps["core"]),
      setVendingProductRules: async () => {
        throw new CoreError(400, "/vending/product-rules", "packSize must not be greater than 1000");
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "блок TUC 6", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.match(reply?.text ?? "", /Core отверг запрос: packSize must not be greater than 1000/);
    assert.doesNotMatch(reply?.text ?? "", /попробуй ещё раз чуть позже/i);
  });

  it("5xx и сеть — прежний ответ «попробуй позже» (повтор реально помогает)", async () => {
    const core = {
      ...({} as HandlerDeps["core"]),
      setVendingProductRules: async () => {
        throw new CoreError(503, "/vending/product-rules", "");
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "блок TUC 6", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.match(reply?.text ?? "", /Попробуй ещё раз чуть позже/);
  });

  it("«план закупа» отдаёт остальные части в more (иначе владелец получит одну сводку)", async () => {
    const plan = {
      generatedAt: "2026-08-25T04:00:00.000Z",
      stock: { asOf: null, totalBefore: 0, use: 0, back: 0, totalAfter: 0, stale: true, unmatched: 0 },
      summary: {
        items: [
          {
            product: "Fanta", need: 12, stock: 0, buy: 12, pack: 12, order: 12, price: 5167, costRounded: 62004,
            noPrice: false, noSales: false, fromPurchase: 12, fromStock: 0, unfilled: 0, toStock: 0, stockAfter: 0,
            excluded: false, fixedQty: null, perMachine: { "2508160376": 12 },
          },
        ],
        excludedNoSales: [], excludedByRule: [], noPrice: [], allocation: "purchase-first",
        totalBuy: 12, totalOrder: 12, costExact: 62004, costRounded: 62004, overpay: 0, shortfallCost: 0,
        totalFromPurchase: 12, totalFromStock: 0, totalUnfilled: 0, totalToStock: 0,
      },
      machines: [
        {
          serial: "2508160376", name: "Olma", routeIndex: 1, need: 12, fromPurchase: 12, fromStock: 0, unfilled: 0,
          slots: [{ coilId: "3", product: "Fanta", quantity: 0, capacity: 12, need: 12, fromPurchase: 12, fromStock: 0, unfilled: 0 }],
        },
      ],
      routeConfigured: false,
      warnings: [],
    };
    const reply = await handleMessage(111, "план закупа", deps([], plan));
    assert.match(reply?.text ?? "", /План закупа/);
    assert.ok((reply?.more ?? []).length >= 2, "купить и слоты — отдельными сообщениями");
    assert.ok((reply?.more ?? []).some((p) => /🛒 Купить/.test(p)));
    assert.ok((reply?.more ?? []).some((p) => /🎰 Olma/.test(p)));
  });
});

describe("Кнопки согласования", () => {
  it("разбирает корректные данные кнопки", () => {
    const parsed = parseApprovalCallback("ap:approved:abc-123");
    assert.deepEqual(parsed, { decision: "approved", id: "abc-123" });
  });

  it("отклоняет подделанные и неполные данные", () => {
    assert.equal(parseApprovalCallback("ap:drop_table:1"), null);
    assert.equal(parseApprovalCallback("ap:approved"), null);
    assert.equal(parseApprovalCallback("мусор"), null);
    assert.equal(parseApprovalCallback("ap:approved:"), null);
  });
});
