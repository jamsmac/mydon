import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aging,
  byMonth,
  cashReconcile,
  concentration,
  daysBetween,
  dueSoon,
  fxRefreshPlan,
  uzsEquivalent,
  type FlowForMath,
} from "./finance.math";

/**
 * Golden-тесты денежной математики.
 *
 * Донор (PROMACH) держал ~473 эндпоинта при трёх тест-файлах — деньги без
 * тестов. Перенося его модель, первым делом закрываем именно это: вход →
 * ожидаемый свод, руками посчитанный.
 */

const TODAY = "2026-08-04";

function flow(over: Partial<FlowForMath>): FlowForMath {
  return {
    id: over.id ?? "x",
    direction: "in",
    status: "planned",
    amount: "100",
    currency: "UZS",
    rate: null,
    amountUzs: null,
    dueDate: null,
    date: new Date("2026-08-01T10:00:00Z"),
    counterpartyKey: null,
    counterpartyName: null,
    ...over,
  };
}

describe("uzsEquivalent", () => {
  it("сум остаётся как есть", () => {
    assert.equal(uzsEquivalent(flow({ amount: "1500000" })), 1_500_000);
  });
  it("сохранённый amount_uzs важнее пересчёта — историческая сумма не плавает", () => {
    assert.equal(
      uzsEquivalent(flow({ currency: "USD", amount: "100", amountUzs: "1250000", rate: "13000" })),
      1_250_000,
    );
  });
  it("без amount_uzs пересчитывает по курсу записи", () => {
    assert.equal(uzsEquivalent(flow({ currency: "USD", amount: "200", rate: "12500" })), 2_500_000);
  });
  it("валюта без курса — null, а не выдуманная цифра", () => {
    assert.equal(uzsEquivalent(flow({ currency: "USD", amount: "200" })), null);
  });
});

describe("daysBetween", () => {
  it("считает дни в обе стороны", () => {
    assert.equal(daysBetween("2026-08-01", "2026-08-04"), 3);
    assert.equal(daysBetween("2026-08-04", "2026-08-01"), -3);
  });
  it("нечитаемая дата — null", () => {
    assert.equal(daysBetween("31.12.2026", "2026-08-04"), null);
  });
});

describe("aging — корзины 0-30/31-60/61-90/90+ (план интеграции PROMACH)", () => {
  const rows: FlowForMath[] = [
    // не просрочен (срок завтра)
    flow({ id: "a", amount: "10", dueDate: "2026-08-05" }),
    // просрочка 10 дней → 0-30
    flow({ id: "b", amount: "20", dueDate: "2026-07-25" }),
    // просрочка 45 дней → 31-60
    flow({ id: "c", amount: "40", dueDate: "2026-06-20" }),
    // просрочка 80 дней → 61-90
    flow({ id: "d", amount: "80", dueDate: "2026-05-16" }),
    // просрочка 200 дней → 90+
    flow({ id: "e", amount: "160", dueDate: "2026-01-16" }),
    // без срока — отдельная честная корзина
    flow({ id: "f", amount: "5" }),
    // оплаченное и отменённое в агинг не входят
    flow({ id: "g", amount: "1000", status: "actual", dueDate: "2026-07-01" }),
    flow({ id: "h", amount: "1000", status: "cancelled", dueDate: "2026-07-01" }),
    // чужое направление движения не мешает
    flow({ id: "i", amount: "999", direction: "out", dueDate: "2026-07-01" }),
  ];
  const report = aging(rows, "in", TODAY);

  it("раскладывает по корзинам без потерь", () => {
    assert.equal(report.notDue.byCurrency[0]?.amount, 10);
    assert.equal(report.d0_30.byCurrency[0]?.amount, 20);
    assert.equal(report.d31_60.byCurrency[0]?.amount, 40);
    assert.equal(report.d61_90.byCurrency[0]?.amount, 80);
    assert.equal(report.d90plus.byCurrency[0]?.amount, 160);
    assert.equal(report.noDue.byCurrency[0]?.amount, 5);
  });
  it("итог сходится с суммой корзин", () => {
    assert.equal(report.total.byCurrency[0]?.amount, 10 + 20 + 40 + 80 + 160 + 5);
    assert.equal(report.total.count, 6);
  });
  it("границы корзин: ровно 30/60/90 дней просрочки", () => {
    const r = aging(
      [
        flow({ id: "x30", amount: "1", dueDate: "2026-07-05" }), // ровно 30
        flow({ id: "x60", amount: "2", dueDate: "2026-06-05" }), // ровно 60
        flow({ id: "x90", amount: "4", dueDate: "2026-05-06" }), // ровно 90
      ],
      "in",
      TODAY,
    );
    assert.equal(r.d0_30.byCurrency[0]?.amount, 1);
    assert.equal(r.d31_60.byCurrency[0]?.amount, 2);
    assert.equal(r.d61_90.byCurrency[0]?.amount, 4);
  });
  it("валюты не смешиваются: USD и UZS лежат раздельно", () => {
    const r = aging(
      [
        flow({ id: "u1", amount: "100", currency: "USD", rate: "12500", dueDate: "2026-07-25" }),
        flow({ id: "u2", amount: "500000", dueDate: "2026-07-25" }),
      ],
      "in",
      TODAY,
    );
    const bucket = r.d0_30;
    assert.equal(bucket.byCurrency.length, 2);
    assert.equal(bucket.byCurrency[0]?.currency, "UZS");
    assert.equal(bucket.byCurrency[0]?.amount, 500_000);
    assert.equal(bucket.byCurrency[1]?.currency, "USD");
    assert.equal(bucket.byCurrency[1]?.amount, 100);
    // сумовой эквивалент: 100 × 12500 + 500000
    assert.equal(bucket.uzs, 1_750_000);
    assert.equal(bucket.unconverted, 0);
  });
  it("запись без курса не входит в сумовой итог, но видна счётчиком", () => {
    const r = aging([flow({ id: "n", amount: "77", currency: "USD", dueDate: "2026-07-25" })], "in", TODAY);
    assert.equal(r.d0_30.uzs, 0);
    assert.equal(r.d0_30.unconverted, 1);
  });
});

describe("dueSoon — «к сроку ≤ 7 дней» из notifications.ts PROMACH", () => {
  it("берёт срок в горизонте и уже просроченное, сортирует по сроку", () => {
    const rows = [
      flow({ id: "late", dueDate: "2026-07-01" }), // просрочен — остаётся в тревоге
      flow({ id: "today", dueDate: "2026-08-04" }),
      flow({ id: "in7", dueDate: "2026-08-11" }), // ровно горизонт
      flow({ id: "in8", dueDate: "2026-08-12" }), // за горизонтом
      flow({ id: "paid", dueDate: "2026-08-05", status: "actual" }),
    ];
    const got = dueSoon(rows, "in", TODAY, 7).map((r) => r.id);
    assert.deepEqual(got, ["late", "today", "in7"]);
  });
});

describe("concentration — термометр по контрагентам (порог 60%)", () => {
  it("считает долю крупнейшего должника по сумовому эквиваленту", () => {
    const rows = [
      flow({ id: "1", amount: "700", counterpartyKey: "olma", counterpartyName: "OLMA" }),
      flow({ id: "2", amount: "200", counterpartyKey: "b", counterpartyName: "Б" }),
      flow({ id: "3", amount: "100", counterpartyKey: "c", counterpartyName: "В" }),
    ];
    const r = concentration(rows);
    assert.equal(r.rows[0]?.name, "OLMA");
    assert.ok(r.topShare !== null && Math.abs(r.topShare - 0.7) < 1e-9);
    assert.equal(r.alarm, true, "70% ≥ порога 60% — термометр красный");
  });
  it("ниже порога тревоги нет", () => {
    const rows = [
      flow({ id: "1", amount: "500", counterpartyKey: "a", counterpartyName: "А" }),
      flow({ id: "2", amount: "500", counterpartyKey: "b", counterpartyName: "Б" }),
    ];
    assert.equal(concentration(rows).alarm, false);
  });
  it("долг без курса не входит в долю, но не теряется", () => {
    const rows = [
      flow({ id: "1", amount: "500", counterpartyKey: "a", counterpartyName: "А" }),
      flow({ id: "2", amount: "100", currency: "USD", counterpartyKey: "b", counterpartyName: "Б" }),
    ];
    const r = concentration(rows);
    assert.equal(r.unconverted, 1);
    assert.equal(r.totalUzs, 500);
  });
});

describe("byMonth — кэш-флоу по месяцам (by_month из PROMACH, но по валютам)", () => {
  it("группирует факты по месяцам ташкентского пояса, планы не считает", () => {
    const rows = [
      flow({ id: "1", status: "actual", direction: "in", amount: "100", date: new Date("2026-07-10T05:00:00Z") }),
      flow({ id: "2", status: "actual", direction: "out", amount: "30", date: new Date("2026-07-20T05:00:00Z") }),
      flow({ id: "3", status: "actual", direction: "in", amount: "50", date: new Date("2026-08-01T05:00:00Z") }),
      flow({ id: "4", status: "planned", direction: "in", amount: "999", date: new Date("2026-08-01T05:00:00Z") }),
    ];
    const months = byMonth(rows, "Asia/Tashkent", 12);
    assert.deepEqual(
      months.map((m) => m.month),
      ["2026-07", "2026-08"],
    );
    assert.equal(months[0]?.inflow[0]?.amount, 100);
    assert.equal(months[0]?.outflow[0]?.amount, 30);
    assert.equal(months[1]?.inflow[0]?.amount, 50);
  });
  it("полночь по Ташкенту не уползает в соседний месяц", () => {
    // 2026-07-31T20:00Z = 2026-08-01 01:00 по Ташкенту (+05:00) — это август.
    const rows = [flow({ id: "1", status: "actual", amount: "10", date: new Date("2026-07-31T20:00:00Z") })];
    assert.equal(byMonth(rows, "Asia/Tashkent")[0]?.month, "2026-08");
  });
});

describe("fxRefreshPlan — автокурс ЦБ РУз (ручной ввод главнее)", () => {
  const TZ = "Asia/Tashkent";
  const TODAY = "2026-08-04";
  const cbuRows = [
    { Ccy: "USD", Rate: "12650.44", Date: "04.08.2026" },
    { Ccy: "EUR", Rate: "13720.11", Date: "04.08.2026" },
    { Ccy: "CNY", Rate: "1745.02", Date: "04.08.2026" },
    { Ccy: "RUB", Rate: "158.9", Date: "04.08.2026" },
  ];

  it("пустая история: все четыре валюты встают из ЦБ с заметкой о дате", () => {
    const plan = fxRefreshPlan(cbuRows, [], TODAY, TZ);
    assert.deepEqual(
      plan.inserts.map((i) => i.currency),
      ["USD", "CNY", "EUR", "RUB"],
    );
    assert.equal(plan.inserts[0]?.rate, 12650.44);
    assert.equal(plan.inserts[0]?.note, "ЦБ РУз на 04.08.2026");
    assert.deepEqual(plan.skipped, []);
  });

  it("ручной курс, заданный сегодня, НЕ перекрывается автообновлением", () => {
    const latest = [
      { currency: "USD", rate: "12500", source: "manual", createdAt: new Date("2026-08-04T03:00:00Z") },
    ];
    const plan = fxRefreshPlan(cbuRows, latest, TODAY, TZ);
    assert.ok(!plan.inserts.some((i) => i.currency === "USD"));
    assert.deepEqual(plan.skipped.find((s) => s.currency === "USD"), {
      currency: "USD",
      reason: "ручной курс за сегодня главнее",
    });
  });

  it("вчерашний ручной курс перекрывается: ЦБ снова источник по умолчанию", () => {
    const latest = [
      { currency: "USD", rate: "12500", source: "manual", createdAt: new Date("2026-08-03T10:00:00Z") },
    ];
    const plan = fxRefreshPlan(cbuRows, latest, TODAY, TZ);
    assert.ok(plan.inserts.some((i) => i.currency === "USD" && i.rate === 12650.44));
  });

  it("граница суток — по Ташкенту: 2026-08-03T20:00Z — это уже сегодня (+05)", () => {
    const latest = [
      { currency: "USD", rate: "12500", source: "manual", createdAt: new Date("2026-08-03T20:00:00Z") },
    ];
    const plan = fxRefreshPlan(cbuRows, latest, TODAY, TZ);
    assert.equal(plan.skipped.find((s) => s.currency === "USD")?.reason, "ручной курс за сегодня главнее");
  });

  it("курс не изменился — строка истории не плодится", () => {
    const latest = [
      { currency: "EUR", rate: "13720.1100", source: "cbu", createdAt: new Date("2026-08-03T05:00:00Z") },
    ];
    const plan = fxRefreshPlan(cbuRows, latest, TODAY, TZ);
    assert.equal(plan.skipped.find((s) => s.currency === "EUR")?.reason, "не изменился");
    assert.ok(!plan.inserts.some((i) => i.currency === "EUR"));
  });

  it("валюты нет в ответе ЦБ или курс не число — честный пропуск словами", () => {
    const plan = fxRefreshPlan(
      [{ Ccy: "USD", Rate: "мусор", Date: "04.08.2026" }],
      [],
      TODAY,
      TZ,
    );
    for (const c of ["USD", "CNY", "EUR", "RUB"]) {
      assert.equal(plan.skipped.find((s) => s.currency === c)?.reason, "ЦБ не дал курс");
    }
    assert.deepEqual(plan.inserts, []);
  });

  it("нулевой и отрицательный курс отбиваются как «ЦБ не дал курс»", () => {
    const plan = fxRefreshPlan(
      [
        { Ccy: "USD", Rate: "0", Date: "04.08.2026" },
        { Ccy: "EUR", Rate: "-5", Date: "04.08.2026" },
      ],
      [],
      TODAY,
      TZ,
      ["USD", "EUR"],
    );
    assert.deepEqual(plan.inserts, []);
    assert.equal(plan.skipped.length, 2);
  });
});

describe("cashReconcile — изъято по системе vs сдано в банк (R-K6)", () => {
  const TZ = "Asia/Tashkent";

  it("месяц с операциями по обеим сторонам — статус ok, разница deposited − withdrawn", () => {
    const r = cashReconcile(
      [{ date: "2026-06-05T10:00:00+05:00", amount: 100000 }],
      [{ date: "2026-06-12T10:00:00+05:00", amount: 90000 }],
      "2026-06-01",
      "2026-06-30",
      TZ,
    );
    assert.equal(r.withdrawn, 100000);
    assert.equal(r.deposited, 90000);
    assert.equal(r.diff, -10000);
    assert.equal(r.periods.length, 1);
    assert.equal(r.periods[0]!.status, "ok");
    assert.deepEqual(r.gaps, []);
  });

  it("период без инкассаций отдаёт признак «нет данных», а не ноль — сумма при этом ноль", () => {
    const r = cashReconcile(
      [],
      [{ date: "2026-06-12T10:00:00+05:00", amount: 90000 }],
      "2026-06-01",
      "2026-06-30",
      TZ,
    );
    assert.equal(r.withdrawn, 0);
    assert.equal(r.hasWithdrawn, false, "нет ни одной инкассации за период — это факт «нет данных», не «собрали ноль»");
    assert.equal(r.hasDeposited, true);
    assert.equal(r.periods[0]!.status, "noWithdrawn");
    assert.equal(r.gaps.length, 1);
    assert.equal(r.gaps[0]!.period, "2026-06");
  });

  it("обе стороны пусты в месяце — статус empty, а НЕ в gaps (тихий месяц ≠ разрыв)", () => {
    const r = cashReconcile(
      [{ date: "2026-05-05", amount: 50000 }],
      [{ date: "2026-05-05", amount: 50000 }],
      "2026-05-01",
      "2026-07-31",
      TZ,
    );
    assert.equal(r.periods.length, 3, "май-июнь-июль перечислены все, даже пустые");
    const june = r.periods.find((p) => p.period === "2026-06")!;
    const july = r.periods.find((p) => p.period === "2026-07")!;
    assert.equal(june.status, "empty");
    assert.equal(july.status, "empty");
    assert.ok(!r.gaps.some((g) => g.period === "2026-06" || g.period === "2026-07"), "тихий месяц не считается разрывом");
  });

  it("сдано без изъятия — noDeposit наоборот тоже разрыв", () => {
    const r = cashReconcile(
      [{ date: "2026-06-05", amount: 100000 }],
      [],
      "2026-06-01",
      "2026-06-30",
      TZ,
    );
    assert.equal(r.periods[0]!.status, "noDeposit");
    assert.equal(r.gaps.length, 1);
  });

  it("операции за пределами [from, to] в сумму не попадают", () => {
    const r = cashReconcile(
      [
        { date: "2026-05-31T23:00:00+05:00", amount: 1 },
        { date: "2026-06-15", amount: 100000 },
        { date: "2026-07-01T00:00:00+05:00", amount: 1 },
      ],
      [],
      "2026-06-01",
      "2026-06-30",
      TZ,
    );
    assert.equal(r.withdrawn, 100000);
    assert.equal(r.withdrawnCount, 1);
  });

  it("итог за несколько месяцев — сумма по всем операциям диапазона, не только по одному месяцу", () => {
    const r = cashReconcile(
      [
        { date: "2026-06-05", amount: 100000 },
        { date: "2026-07-05", amount: 200000 },
      ],
      [
        { date: "2026-06-12", amount: 90000 },
        { date: "2026-07-12", amount: 190000 },
      ],
      "2026-06-01",
      "2026-07-31",
      TZ,
    );
    assert.equal(r.withdrawn, 300000);
    assert.equal(r.deposited, 280000);
    assert.equal(r.diff, -20000);
    assert.equal(r.periods.length, 2);
  });
});
