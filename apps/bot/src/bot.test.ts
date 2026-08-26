import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectGloberentSignals,
  countStuckDeals,
  countUnpaidContracts,
  BRIEFING_NOTES_WINDOW_MS,
  formatBriefing,
  formatBriefingNotes,
  notesBudget,
  notesToAck,
  msUntilBriefing,
} from "./briefing";
import { CoreError } from "./core-client";
import { handleMessage, parseApprovalCallback, type HandlerDeps } from "./handler";
import { parseIntent } from "./intent";
import { parseAllowlist, RateLimiter } from "./security/access";

/** Половина суррогатной пары в тексте — Telegram отвергает такое сообщение. */
const одинокийСуррогат = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

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
        // Ровно то, что отдаёт Nest: причина внутри JSON вместе со служебными полями.
        throw new CoreError(
          400,
          "/vending/product-rules",
          '{"message":["packSize must not be greater than 1000"],"error":"Bad Request","statusCode":400}',
        );
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "блок TUC 6", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.match(reply?.text ?? "", /Core отверг запрос: packSize must not be greater than 1000/);
    // Служебный шум протокола владельцу не показываем.
    assert.doesNotMatch(reply?.text ?? "", /statusCode|Bad Request|[{}[\]]/);
    assert.doesNotMatch(reply?.text ?? "", /попробуй ещё раз чуть позже/i);
  });

  it("400 с телом не-JSON (прокси, HTML) — показываем как есть, обрезав", async () => {
    const core = {
      ...({} as HandlerDeps["core"]),
      setVendingProductRules: async () => {
        throw new CoreError(400, "/vending/product-rules", "<html>413 Request Entity Too Large</html>");
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "блок TUC 6", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.match(reply?.text ?? "", /413 Request Entity Too Large/);
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

describe("Усушка автоматов: путь владельца до Core (П4)", () => {
  const отчёт = {
    from: "2026-08-11",
    to: "2026-08-24",
    threshold: 30_000,
    machines: [
      {
        serial: "2508160376",
        name: "Olma",
        summary: {
          items: [
            { product: "Kinder Bueno", lossUnits: 9, lossValue: 99_000, surplusUnits: 0, daysCounted: 9, noPrice: false, alert: true },
          ],
          lossValue: 99_000,
          daysCounted: 9,
          daysSkipped: 5,
          threshold: 30_000,
        },
        refillDays: [{ date: "2026-08-18", detectedUnits: 96, recordedUnits: 0 }],
      },
    ],
    warnings: [],
  };

  function deps(окна: number[], report: unknown = отчёт): HandlerDeps {
    const core = {
      ...({} as HandlerDeps["core"]),
      vendingShrinkage: async (days: number) => {
        окна.push(days);
        return report;
      },
    } as unknown as HandlerDeps["core"];
    return { core, allowlist: parseAllowlist("111"), limiter: new RateLimiter() };
  }

  it("«усушка» доходит до Core с окном по умолчанию и отвечает разбором", async () => {
    const окна: number[] = [];
    const reply = await handleMessage(111, "усушка", deps(окна));
    assert.deepEqual(окна, [14]);
    assert.match(reply?.text ?? "", /Усушка за 14 дн/);
    assert.match(reply?.text ?? "", /Kinder Bueno −9 шт/);
  });

  it("окно из фразы уходит в Core как есть", async () => {
    const окна: number[] = [];
    await handleMessage(111, "усушка за 30 дней", deps(окна));
    assert.deepEqual(окна, [30]);
  });

  it("сбой Core не молчит — владелец знает, что данных нет", async () => {
    const core = {
      ...({} as HandlerDeps["core"]),
      vendingShrinkage: async () => {
        throw new CoreError(503, "/vending/shrinkage", "");
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "усушка", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.match(reply?.text ?? "", /усушку из MYDON Core/i);
  });

  it("справка называет «усушку» — иначе отчёт есть, а спросить его никто не догадается", async () => {
    // Единственный вход в отчёт — слово в чате: не будь его в справке, отчёт
    // существовал бы только для того, кто читал план разработки.
    const reply = await handleMessage(111, "ъъъ непонятное", deps([]));
    assert.match(reply?.text ?? "", /«усушка»/);
    assert.match(reply?.text ?? "", /усушка за 30 дней/);
  });
});

describe("Брифинг: несрочные сигналы правил", () => {
  it("собирает блок и не повторяет одинаковые строки", () => {
    const block = formatBriefingNotes([
      { key: "e1:r1", text: "📉 Усушка Olma: Kinder Bueno −9 шт ≈ 99 000 сум за 14 дн." },
      { key: "e2:r1", text: "📉 Усушка Olma: Kinder Bueno −9 шт ≈ 99 000 сум за 14 дн." },
      { key: "e3:r2", text: "🍫 Заливка без записи: Olma +96 шт" },
    ]);
    assert.match(block?.text ?? "", /Разобраться сегодня/);
    assert.equal((block?.text ?? "").match(/Усушка Olma/g)?.length, 1);
    assert.match(block?.text ?? "", /Заливка без записи/);
    // Склеенный повтор — это ДРУГОЕ событие с тем же текстом: показали его
    // содержимое, значит доставили. Не отметь мы его — оно вернулось бы завтра
    // и снова склеилось, и так навсегда.
    assert.deepEqual(block?.shownKeys, ["e1:r1", "e2:r1", "e3:r2"]);
  });

  it("пусто — блока нет вовсе, а не пустой заголовок", () => {
    assert.equal(formatBriefingNotes([]), null);
    assert.equal(formatBriefingNotes([{ key: "e:r", text: "  " }]), null);
  });

  it("непоказанное НЕ считается доставленным (15 в очереди → 12 строк → 12 ключей)", () => {
    // Отметить всё, а напечатать двенадцать — тихая потеря ровно тех алертов,
    // ради которых проводка и делалась: в notification_delivery они попадут,
    // а на глаза владельцу — никогда.
    const many = Array.from({ length: 15 }, (_, i) => ({ key: `e${i}:r`, text: `сигнал ${i}` }));
    const block = formatBriefingNotes(many);
    assert.equal(block?.shownKeys.length, 12);
    assert.deepEqual(block?.shownKeys.slice(-1), ["e11:r"]);
    assert.match(block?.text ?? "", /…и ещё 3/);
    // Три оставшихся ключа не отмечены — придут завтра.
    for (const k of ["e12:r", "e13:r", "e14:r"]) {
      assert.ok(!block?.shownKeys.includes(k), k);
    }
  });

  it("длинный список обрезается вслух: сводка, которую не дочитывают, не сводка", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `e${i}:r`, text: `сигнал ${i}` }));
    const block = formatBriefingNotes(many, 5);
    assert.equal((block?.text ?? "").split("\n").length, 7, "заголовок + 5 строк + хвост");
    assert.match(block?.text ?? "", /…и ещё 15/);
    assert.equal(block?.shownKeys.length, 5);
  });

  it("бюджет длины: блок режется, а не роняет весь брифинг лимитом Telegram", () => {
    // 4096 — предел одного сообщения. Перевалив его, падает ВСЁ сообщение,
    // то есть и сводка, и согласования, и сигналы разом.
    const briefingText = "б".repeat(3000);
    const staffLine = "с".repeat(200);
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `e${i}:r`, text: `сигнал ${i} ` + "х".repeat(120) }));
    const block = formatBriefingNotes(many, 12, notesBudget(briefingText, staffLine));
    assert.ok(block, "что-то показать всё же удалось");
    assert.ok(block.shownKeys.length < 12, "влезло не всё");
    assert.match(block.text, /…и ещё \d+/);
    const message = [briefingText, block.text, staffLine].join("\n\n");
    assert.ok(message.length <= 3500, `длина ${message.length}`);
  });

  it("бюджета не осталось вовсе — блока нет и ничего не отмечено", () => {
    const block = formatBriefingNotes([{ key: "e:r", text: "сигнал" }], 12, 0);
    assert.equal(block, null);
  });

  it("длинная строка правила режется по символам, а не переносится целиком", () => {
    const block = formatBriefingNotes([{ key: "e:r", text: "📉 " + "я".repeat(400) }]);
    const line = (block?.text ?? "").split("\n")[1] ?? "";
    assert.ok(line.length <= 160, `строка длиной ${line.length}`);
    assert.match(line, /…$/);
  });

  it("эмодзи на границе обрезки не разрывается пополам (S6)", () => {
    // Имя товара из Ourvend с эмодзи ровно на 160-м символе оставляло от него
    // половину суррогатной пары. Telegram отвечает 400 на ВСЁ сообщение —
    // брифинг переставал доходить каждое утро, а не терял одну строку.
    const текст = "я".repeat(158) + "🍫" + "я".repeat(50);
    const block = formatBriefingNotes([{ key: "e:r", text: текст }]);
    const line = (block?.text ?? "").split("\n")[1] ?? "";
    assert.ok(!одинокийСуррогат(line), JSON.stringify(line.slice(-5)));
    assert.ok(line.length <= 160, `строка длиной ${line.length}`);
  });

  it("не дошло ни в один чат — не отмечаем ничего (сигнал придёт завтра)", () => {
    const block = formatBriefingNotes([{ key: "e1:r", text: "сигнал" }]);
    assert.deepEqual(notesToAck(block, false), []);
    assert.deepEqual(notesToAck(block, true), ["e1:r"]);
    assert.deepEqual(notesToAck(null, true), []);
  });

  it("окно ожидания — неделя: одна неудачная отправка не теряет сигнал навсегда", () => {
    // Ключ одноразовости брифинга уже израсходован, повторной попытки в те же
    // сутки не будет. При окне в 26 ч вчерашние алерты (они пишутся в 08:35)
    // в завтрашнюю выборку уже не попадут. Повтора не боимся: Core отсекает
    // отмеченное в notification_delivery.
    assert.equal(BRIEFING_NOTES_WINDOW_MS, 7 * 24 * 3_600_000);
  });
});

describe("Аналитика снека: путь владельца до Core (П5b)", () => {
  const МАРЖА = {
    days: 30,
    from: "2026-07-26",
    to: "2026-08-24",
    lowPct: 15,
    machines: [
      {
        serial: "2508160376",
        name: "Olma Администрация",
        products: [],
        qty: 545,
        revenue: 5_882_000,
        cogs: 4_260_615,
        margin: 1_621_385,
        pct: 27.6,
        unknownUnits: 0,
        low: false,
      },
    ],
    products: [],
    totals: { qty: 545, revenue: 5_882_000, cogs: 4_260_615, margin: 1_621_385, pct: 27.6, unknownUnits: 0 },
    unknownUnits: 0,
    unknownProducts: [],
    excluded: [],
  };

  /** Стаб Core: считает вызовы каждого метода и с каким окном его позвали. */
  function deps(вызовы: string[]): HandlerDeps {
    const core = {
      ...({} as HandlerDeps["core"]),
      vendingMargin: async (days: number) => {
        вызовы.push(`margin:${days}`);
        return МАРЖА;
      },
      vendingDeadStock: async (days: number) => {
        вызовы.push(`dead:${days}`);
        return { days, since: "2026-08-04", warehouse: [], machines: [], totalValue: 0, noPriceCount: 0 };
      },
      vendingPriceChanges: async (days: number) => {
        вызовы.push(`changes:${days}`);
        return { days, pct: 5, purchase: [], retail: [], monthly: [] };
      },
      vendingPriceGap: async (days: number) => {
        вызовы.push(`gap:${days}`);
        return { days, pct: 5, rows: [], noReference: [], lostTotal: 0 };
      },
      setVendingSalePrice: async (product: string, price: number, confirmed: boolean) => {
        вызовы.push(`sale-price:${product}:${price}:${confirmed}`);
        return { ok: true, product, oldPrice: null, newPrice: price };
      },
      setVendingPrice: async (product: string, price: number) => {
        // Закупочная цена: сюда «цена продажи …» попадать НЕ ДОЛЖНА.
        вызовы.push(`purchase-price:${product}:${price}`);
        return { ok: true, product, oldPrice: null, newPrice: price };
      },
      bootstrapVendingSalePrice: async (days: number) => {
        вызовы.push(`bootstrap:${days}`);
        return { days, set: [{ product: "TUC", price: 15_000, qty: 42 }], skipped: [] };
      },
      // Значение по умолчанию повторяет клиент (`ourvendHealth(runs = 20)`):
      // окно прогонов задаёт он, а не ветка обработчика.
      ourvendHealth: async (runs = 20) => {
        вызовы.push(`health:${runs}`);
        return {
          // Прогоны в стабе есть намеренно: серия отказов при ПУСТОМ журнале
          // прогонов — невозможная пара, и здоровье в этом случае честно
          // отвечает «оценить не по чему».
          runs: [
            {
              id: "r1",
              startedAt: "2026-08-25T03:00:00Z",
              finishedAt: "2026-08-25T03:00:10Z",
              status: "failed",
              machinesTotal: 2,
              machinesOk: 0,
              durationMs: 10_000,
              error: "приём слотов прерван по таймауту 10 с",
            },
          ],
          failedStreak: 12,
          lastSuccessAt: null,
          slotsLagMin: null,
          salesLagH: null,
          productSaleLagH: null,
          parity: { days: 7, ok: false, mismatches: 3, stockOk: false, stockChecked: 0, mode: "mirror", note: null },
        };
      },
      // Серия по дням едет ОТДЕЛЬНЫМ роутом (P4): «сверка» зовёт оба, и
      // список вызовов ниже это фиксирует — молчаливая потеря одного из них
      // означала бы отчёт без даты последнего красного дня.
      ourvendParityStreak: async () => {
        вызовы.push("streak");
        return { greenDays: 0, threshold: 7, readyForCutover: false, days: [], lastRed: "2026-08-25", since: null };
      },
    } as unknown as HandlerDeps["core"];
    return { core, allowlist: parseAllowlist("111"), limiter: new RateLimiter() };
  }

  it("«цена продажи …» правит ЭТАЛОН витрины, а не закупочную цену", async () => {
    // Регрессия порядка веток: существующая `/^цена(\s|:|$)/i` ловит и эту
    // фразу. Стой она раньше — правка ушла бы в закупочную цену: другая
    // колонка, другой гейт, и заметили бы это только по перекошенному закупу.
    const вызовы: string[] = [];
    const reply = await handleMessage(111, "цена продажи TUC 15000", deps(вызовы));
    assert.deepEqual(вызовы, ["sale-price:TUC:15000:false"]);
    assert.match(reply?.text ?? "", /Эталон витрины/);
  });

  it("«цена …» по-прежнему правит закупочную цену", async () => {
    const вызовы: string[] = [];
    await handleMessage(111, "цена TUC 12000", deps(вызовы));
    assert.deepEqual(вызовы, ["purchase-price:TUC:12000"]);
  });

  it("«витрина как факт» — бутстрап, «витрина» — отчёт", async () => {
    const вызовы: string[] = [];
    await handleMessage(111, "витрина как факт", deps(вызовы));
    await handleMessage(111, "витрина", deps(вызовы));
    assert.deepEqual(вызовы, ["bootstrap:14", "gap:14"]);
  });

  it("окна из фразы зажимаются ботом и доходят до Core", async () => {
    const вызовы: string[] = [];
    await handleMessage(111, "маржа", deps(вызовы));
    await handleMessage(111, "маржа за 7 дней", deps(вызовы));
    await handleMessage(111, "маржа за 900 дней", deps(вызовы));
    await handleMessage(111, "мёртвый сток", deps(вызовы));
    await handleMessage(111, "цены", deps(вызовы));
    await handleMessage(111, "сверка", deps(вызовы));
    assert.deepEqual(вызовы, ["margin:30", "margin:7", "margin:90", "dead:21", "changes:30", "health:20", "streak"]);
  });

  it("маржа отвечает разбором, а не «понял»", async () => {
    const reply = await handleMessage(111, "маржа", deps([]));
    assert.match(reply?.text ?? "", /Маржа снек-автоматов \(OurVend\) за 30 дн/);
    assert.match(reply?.text ?? "", /Olma Администрация: выручка 5 882 000/);
  });

  it("«сверка» показывает серию отказов сбора, а не молчит про неё", async () => {
    const reply = await handleMessage(111, "сверка", deps([]));
    assert.match(reply?.text ?? "", /12 отказов подряд/);
  });

  it("сбой Core не молчит — владелец знает, что данных нет", async () => {
    const core = {
      ...({} as HandlerDeps["core"]),
      vendingMargin: async () => {
        throw new CoreError(503, "/vending/margin", "");
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "маржа", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.match(reply?.text ?? "", /маржу из MYDON Core/i);
  });

  it("отказ Core по данным объясняется причиной, а не «попробуй позже»", async () => {
    const core = {
      ...({} as HandlerDeps["core"]),
      setVendingSalePrice: async () => {
        throw new CoreError(400, "/vending/sale-price", '{"message":["product should not be empty"]}');
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "цена продажи TUC 15000", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.match(reply?.text ?? "", /product should not be empty/);
    assert.doesNotMatch(reply?.text ?? "", /попробуй ещё раз чуть позже/i);
  });

  /** Минимальная недельная сводка: обработчику важен путь, а не числа. */
  const НЕДЕЛЯ = {
    week: "2026-34",
    from: "2026-08-17",
    to: "2026-08-23",
    previousWeek: "2026-33",
    machines: [],
    totals: { qty: 0, revenue: 0, cogs: 0, margin: 0, pct: null, unknownUnits: 0 },
    delta: { qty: 0, revenue: 0, margin: 0, qtyPct: null, revenuePct: null, marginPct: null },
    topProducts: [],
    worstProducts: [],
    refills: { events: 0, detectedUnits: 0, recordedUnits: 0 },
    intake: { orders: 0, units: 0, amount: 0 },
    stocktakes: { positions: 0, lastCountedAt: null },
    deadStock: { rows: [], totalValue: 0 },
    priceChanges: { purchase: [], retail: [] },
    health: {
      runs: [],
      failedStreak: 0,
      lastSuccessAt: null,
      slotsLagMin: null,
      salesLagH: null,
      productSaleLagH: null,
      parity: { days: 7, ok: true, mismatches: 0, stockOk: true, stockChecked: 2, mode: "mirror", note: null },
    },
    // Здоровье за отчётную неделю (R-H-9): без него форматтер сводки печатать
    // нечего — блок начинается с чисел недели, а не с чисел момента.
    weekHealth: {
      week: "2026-34",
      runs: 0,
      success: 0,
      partial: 0,
      failed: 0,
      worstFailedStreak: 0,
      lastSuccessAt: null,
      parityDays: [],
      parityGreen: 0,
      parityRed: 0,
    },
  };

  it("«итоги недели» — сводка снека, «итоги» — по-прежнему лента действий (регресс)", async () => {
    // Порядок веток: `isActionsQuery` ловит любое `^итоги`. Стой сводка после
    // неё — «итоги недели» молча уехали бы в ленту действий сотрудников, и
    // владелец получил бы совсем другой отчёт, не заметив подмены.
    const вызовы: string[] = [];
    const core = {
      ...({} as HandlerDeps["core"]),
      vendingWeeklyDigest: async (week?: string) => {
        вызовы.push(`weekly:${week ?? "прошлая"}`);
        return НЕДЕЛЯ;
      },
      briefingNotifications: async () => {
        вызовы.push("pending");
        return { since: "", events: 0, notifications: [] };
      },
      actions: async (from: string, to: string) => {
        вызовы.push(`actions:${from}:${to}`);
        return [];
      },
    } as unknown as HandlerDeps["core"];
    const d: HandlerDeps = { core, allowlist: parseAllowlist("111"), limiter: new RateLimiter() };

    const сводка = await handleMessage(111, "итоги недели", d);
    assert.match(сводка?.text ?? "", /Итоги недели 17\.08 — 23\.08/);
    const заданная = await handleMessage(111, "итоги недели 2026-34", d);
    assert.match(заданная?.text ?? "", /Итоги недели/);
    await handleMessage(111, "итоги", d);
    await handleMessage(111, "итоги за неделю", d);

    // Порядок и адресат каждой фразы; даты ленты действий считаются от
    // сегодняшнего дня, поэтому сверяем не их, а куда ушёл запрос.
    const кому = вызовы.filter((c) => !c.startsWith("pending")).map((c) => c.split(":")[0]);
    assert.deepEqual(кому, ["weekly", "weekly", "actions", "actions"]);
    assert.deepEqual(
      вызовы.filter((c) => c.startsWith("weekly")),
      ["weekly:прошлая", "weekly:2026-34"],
    );
  });

  it("неделя, которой не бывает, чинится фразой, а не ожиданием сервера", async () => {
    const вызовы: string[] = [];
    const core = {
      ...({} as HandlerDeps["core"]),
      vendingWeeklyDigest: async () => {
        вызовы.push("weekly");
        return НЕДЕЛЯ;
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "итоги недели 2025-53", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.deepEqual(вызовы, [], "запрос в Core за несуществующей неделей не уходит");
    assert.match(reply?.text ?? "", /Укажи неделю как 2026-34/);
  });

  it("окно бутстрапа шире окна отчёта: «витрина как факт за 120 дней» доходит целиком", async () => {
    // `BootstrapSalePriceDto` допускает 180 суток, `PriceGapDto` — 90. Общий
    // потолок молча срезал бы окно, и эталон встал бы не по тому периоду,
    // который просил владелец.
    const вызовы: string[] = [];
    await handleMessage(111, "витрина как факт за 120 дней", deps(вызовы));
    assert.deepEqual(вызовы, ["bootstrap:120"]);
  });

  it("отказ Core по данным у ОТЧЁТА тоже объясняется причиной, а не «попробуй позже»", async () => {
    // Окна бот зажимает сам, но границы DTO живут в Core: разойдись они —
    // «маржа за 90 дней» вечно отвечала бы «попробуй позже», хотя чинить надо
    // границу, а не ждать.
    const core = {
      ...({} as HandlerDeps["core"]),
      vendingMargin: async () => {
        throw new CoreError(400, "/vending/margin", '{"message":["days must not be greater than 90"]}');
      },
    } as unknown as HandlerDeps["core"];
    const reply = await handleMessage(111, "маржа за 90 дней", {
      core,
      allowlist: parseAllowlist("111"),
      limiter: new RateLimiter(),
    });
    assert.match(reply?.text ?? "", /days must not be greater than 90/);
    assert.doesNotMatch(reply?.text ?? "", /попробуй ещё раз чуть позже/i);
  });

  it("справка называет все восемь команд — иначе отчёты есть, а спросить их никто не догадается", async () => {
    const reply = await handleMessage(111, "ъъъ непонятное", deps([]));
    const help = reply?.text ?? "";
    for (const фраза of [
      "«маржа»",
      "«мёртвый сток»",
      "«цены»",
      "«витрина»",
      "«цена продажи TUC 15000»",
      "«витрина как факт»",
      "«итоги недели»",
      "«сверка»",
    ]) {
      assert.ok(help.includes(фраза), `в справке нет ${фраза}`);
    }
  });
});
