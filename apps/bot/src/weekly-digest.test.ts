import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { msUntilWeekly, pendingNotes } from "./briefing";
import type { PersonRow, WeeklyDigest } from "./core-client";
import {
  formatWeeklyDigest,
  isWeeklyDigestQuery,
  parseWeekArg,
  WEEKLY_WEEK_HINT,
  weeklyDigestKey,
  weeklyRecipients,
} from "./weekly-digest";

/**
 * Боевая неделя 2026-34 (пн 17.08 — вс 23.08): числа того же порядка, что
 * отдаёт прод — один снек-автомат Olma с продажами и второй с редкими.
 */
const ДАЙДЖЕСТ_34: WeeklyDigest = {
  week: "2026-34",
  from: "2026-08-17",
  to: "2026-08-23",
  previousWeek: "2026-33",
  machines: [
    { serial: "2508160376", name: "Olma Администрация", qty: 412, revenue: 1_487_000, margin: 421_310, pct: 28.3 },
    { serial: "2508160377", name: "Olma Цех", qty: 187, revenue: 670_000, margin: 186_285, pct: 27.8 },
  ],
  totals: { qty: 599, revenue: 2_157_000, cogs: 1_549_405, margin: 607_595, pct: 28.2, unknownUnits: 0 },
  delta: { qty: -63, revenue: -441_000, margin: -171_000, qtyPct: -9.5, revenuePct: -17, marginPct: -22 },
  topProducts: [
    { product: "TUC Sour cream", qty: 96, revenue: 384_000, cogs: 268_800, margin: 115_200, pct: 30, unknownUnits: 0, low: false },
    { product: "Snickers", qty: 74, revenue: 296_000, cogs: 222_000, margin: 74_000, pct: 25, unknownUnits: 0, low: false },
  ],
  worstProducts: [
    { product: "LaimonFresh", qty: 18, revenue: 216_000, cogs: 219_600, margin: -3_600, pct: -1.7, unknownUnits: 0, low: true },
  ],
  refills: { events: 3, detectedUnits: 183, recordedUnits: 0 },
  intake: { orders: 2, units: 540, amount: 4_100_000 },
  stocktakes: { positions: 12, lastCountedAt: "2026-08-22T09:40:00Z" },
  deadStock: {
    rows: [
      { product: "Fanta 0.5", qty: 24, value: 168_000, noPrice: false },
      { product: "Halls", qty: 30, value: 122_500, noPrice: false, serial: "2508160376", machineName: "Olma Администрация" },
    ],
    totalValue: 290_500,
  },
  priceChanges: {
    purchase: [{ product: "TUC Sour cream", from: 2_600, to: 2_800, pct: 7.7, at: "2026-08-18T06:12:00Z" }],
    retail: [{ product: "LaimonFresh", from: 15_000, to: 12_000, pct: -20, at: "2026-08-19" }],
  },
  health: {
    runs: [
      {
        id: "r1",
        startedAt: "2026-08-23T03:05:00Z",
        finishedAt: "2026-08-23T03:07:00Z",
        status: "success",
        machinesTotal: 2,
        machinesOk: 2,
        durationMs: 120_000,
        error: null,
      },
    ],
    failedStreak: 0,
    lastSuccessAt: "2026-08-23T03:07:00Z",
    slotsLagMin: 42,
    salesLagH: 3,
    productSaleLagH: 5,
    parity: { days: 7, ok: true, mismatches: 0, stockOk: true, checked: 2, stockChecked: 2, note: null },
  },
  warnings: [],
};

/** Неделя без единой продажи: сбор мог просто стоять — это не «маржа ноль». */
const ПУСТАЯ_НЕДЕЛЯ: WeeklyDigest = {
  ...ДАЙДЖЕСТ_34,
  week: "2026-35",
  from: "2026-08-24",
  to: "2026-08-30",
  previousWeek: "2026-34",
  machines: [],
  totals: { qty: 0, revenue: 0, cogs: 0, margin: 0, pct: null, unknownUnits: 0 },
  delta: { qty: -599, revenue: -2_157_000, margin: -607_595, qtyPct: -100, revenuePct: -100, marginPct: -100 },
  topProducts: [],
  worstProducts: [],
  refills: { events: 0, detectedUnits: 0, recordedUnits: 0 },
  intake: { orders: 0, units: 0, amount: 0 },
  stocktakes: { positions: 0, lastCountedAt: null },
  deadStock: { rows: [], totalValue: 0 },
  priceChanges: { purchase: [], retail: [] },
};

describe("Расписание недельной сводки (R-P5b-7)", () => {
  it("понедельник 08:05 по Ташкенту, а не по TZ процесса", () => {
    // вт 25.08 07:00 Ташкента → ждать до пн 31.08 08:05 = 6 сут 1 ч 5 мин
    assert.equal(msUntilWeekly(new Date("2026-08-25T02:00:00Z"), 1, 8, 5), ((6 * 24 + 1) * 60 + 5) * 60_000);
    // пн 24.08 08:00 Ташкента → 5 минут
    assert.equal(msUntilWeekly(new Date("2026-08-24T03:00:00Z"), 1, 8, 5), 5 * 60_000);
  });

  it("ровно в 08:05 ждём следующий понедельник, а не ноль", () => {
    // Ноль означал бы немедленный повторный запуск в том же тике: планировщик
    // рекурсивный, и сводка ушла бы второй раз (спас бы только дедуп).
    assert.equal(msUntilWeekly(new Date("2026-08-24T03:05:00Z"), 1, 8, 5), 7 * 24 * 3_600_000);
  });

  it("воскресенье 23:30 Ташкента — до утра понедельника, а не неделя", () => {
    // 2026-08-23 18:30Z = вс 23:30 Ташкента; по UTC это ещё воскресенье,
    // по Ташкенту тоже — но час уже за полночь у пояса процесса в UTC+6.
    assert.equal(msUntilWeekly(new Date("2026-08-23T18:30:00Z"), 1, 8, 5), (8 * 60 + 35) * 60_000);
  });
});

describe("Получатели и дедуп недельной сводки", () => {
  it("owner и manager с чатом; operator и уволенный — мимо", () => {
    const люди = [
      { id: "1", name: "Владелец", roles: ["owner"], tgChatId: "10", active: "yes" },
      { id: "2", name: "Менеджер", roles: ["manager"], tgChatId: "11", active: "yes" },
      { id: "3", name: "Оператор", roles: ["operator"], tgChatId: "12", active: "yes" },
      { id: "4", name: "Уволен", roles: ["owner"], tgChatId: "13", active: "no" },
      { id: "5", name: "Без чата", roles: ["owner"], tgChatId: null, active: "yes" },
    ] as unknown as PersonRow[];
    assert.deepEqual(weeklyRecipients(люди).map((p) => p.id), ["1", "2"]);
  });

  it("легаси-роль «владелец» тоже получает сводку (прод, п.1)", () => {
    // РЕШЕНИЕ ИЗМЕНЕНО адверсариалом по боевым данным 25.08.2026: в `roles` на
    // проде лежат только storekeeper/technician/operator/collector, а владелец
    // помечен текстовым `role='владелец'`. Прежнее «роль решает только `roles`»
    // означало ноль получателей и молчащее письмо каждый понедельник.
    //
    // Правами это поле по-прежнему не управляет: цена описки здесь — лишний
    // получатель сводки, а не лишние права в боте.
    const люди = [
      { id: "6", name: "Владелец текстом", role: "владелец", roles: [], tgChatId: "14", active: "yes" },
      { id: "7", name: "Английский owner", role: "Owner", roles: [], tgChatId: "15", active: "yes" },
    ] as unknown as PersonRow[];
    assert.deepEqual(
      weeklyRecipients(люди).map((p) => p.id),
      ["6", "7"],
    );
  });

  it("чужой текст в role сводку не открывает", () => {
    // Сверка ТОЧНАЯ, а не по вхождению: «менеджер по закупу» — кладовщик, и
    // деньги парка ему в чат уходить не должны.
    const люди = [
      { id: "8", name: "Снабженец", role: "менеджер по закупу", roles: [], tgChatId: "16", active: "yes" },
      { id: "9", name: "Оператор", role: "оператор", roles: ["operator"], tgChatId: "17", active: "yes" },
    ] as unknown as PersonRow[];
    assert.deepEqual(weeklyRecipients(люди), []);
  });

  it("ключ дедупа — по неделе и человеку", () => {
    assert.equal(weeklyDigestKey("2026-34", "p1"), "weekly-digest:2026-34:p1");
  });
});

describe("Фраза «итоги недели»", () => {
  it("узнаёт сводку и не путает её с лентой действий", () => {
    assert.ok(isWeeklyDigestQuery("итоги недели"));
    assert.ok(isWeeklyDigestQuery("Итоги недели 2026-34"));
    assert.ok(isWeeklyDigestQuery("недельная сводка"));
    // «итоги за неделю» — лента действий сотрудников (справка обещает именно
    // её), «итоги» и «итоги вчера» — тоже. Перехватить их значит подменить
    // ответ на другой отчёт.
    assert.equal(isWeeklyDigestQuery("итоги за неделю"), false);
    assert.equal(isWeeklyDigestQuery("итоги"), false);
    assert.equal(isWeeklyDigestQuery("итоги вчера"), false);
  });

  it("дата — не неделя: «2026-08-17» отвергается, а не читается как февраль", () => {
    // Регрессия: поиск ключа КУСКОМ строки брал из даты «2026-08» и молча
    // показывал февраль вместо августа. Ошибка на полгода, невидимая ни в
    // одном числе ответа.
    assert.deepEqual(parseWeekArg("итоги недели 2026-08-17"), { ok: false });
    assert.deepEqual(parseWeekArg("итоги недели 17.08.2026"), { ok: false });
    assert.match(WEEKLY_WEEK_HINT, /2026-34/);
  });

  it("неделя из фразы: валидный ключ берём, мусор не молчим", () => {
    assert.deepEqual(parseWeekArg("итоги недели"), { ok: true });
    assert.deepEqual(parseWeekArg("итоги недели 2026-34"), { ok: true, week: "2026-34" });
    // 53-я неделя есть не в каждом году: в 2026-м есть, в 2025-м нет. Пропусти
    // мы такой ключ в Core — он ответил бы 400, бот сказал бы «попробуй
    // позже», и владелец ждал бы сервер, хотя чинить надо было фразу.
    assert.deepEqual(parseWeekArg("итоги недели 2026-53"), { ok: true, week: "2026-53" });
    assert.deepEqual(parseWeekArg("итоги недели 2025-53"), { ok: false });
    assert.deepEqual(parseWeekArg("итоги недели 2026-99"), { ok: false });
    assert.deepEqual(parseWeekArg("недельная сводка за 2026-34"), { ok: true, week: "2026-34" });
  });
});

describe("Сигналы правил недельной срочности", () => {
  it("берём только запрошенную срочность, ключ — событие и правило", () => {
    const pending = {
      since: "2026-08-11T00:00:00Z",
      events: 3,
      notifications: [
        { ruleId: "sales.drop", urgency: "weekly", text: "📉 Продажи ниже плана", eventId: "e1" },
        { ruleId: "shrink", urgency: "briefing", text: "усушка", eventId: "e2" },
        { ruleId: "sync", urgency: "immediate", text: "сбор стоит", eventId: "e3" },
      ],
    };
    assert.deepEqual(pendingNotes(pending, "weekly"), [{ key: "e1:sales.drop", text: "📉 Продажи ниже плана" }]);
    // Каждый канал забирает ТОЛЬКО свою срочность: возьми недельный канал
    // брифинговые сигналы — утренний брифинг их больше не увидит (ack общий).
    assert.deepEqual(pendingNotes(pending, "briefing"), [{ key: "e2:shrink", text: "усушка" }]);
  });

  it("Core не ответил — пусто, а не падение", () => {
    assert.deepEqual(pendingNotes(null, "weekly"), []);
  });
});

describe("Текст недельной сводки", () => {
  it("боевая неделя 2026-34: числа, дельта и заливки", () => {
    const { parts } = formatWeeklyDigest(ДАЙДЖЕСТ_34, []);
    const t = parts.join("\n");
    assert.match(t, /Итоги недели 17\.08 — 23\.08/);
    assert.match(t, /2 157 000 сум.*маржа 607 595/s);
    assert.match(t, /−17 % к прошлой неделе/);
    assert.match(t, /Заливки: 3 события, 183 ед по снимкам \(записано 0\)/);
  });

  it("называет разделы сводки, а не только итог", () => {
    const t = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.match(t, /Olma Администрация: выручка 1 487 000/);
    assert.match(t, /TUC Sour cream/); // топ по марже
    assert.match(t, /LaimonFresh/); // худшие по марже
    assert.match(t, /Приходы: 2 накладные, 540 ед на 4 100 000 сум/);
    assert.match(t, /Инвентаризации склада: 12 поз/);
    assert.match(t, /Мёртвый сток/);
    assert.match(t, /15 000 → 12 000/); // витринное изменение цены
    assert.match(t, /Здоровье сбора OurVend/);
  });

  it("сигналы urgency=weekly подмешиваются, ключи — только показанных", () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({ key: `e${i}:sales.drop`, text: `📉 Продажи ниже плана на ${i}%` }));
    const { parts, shownKeys } = formatWeeklyDigest(ДАЙДЖЕСТ_34, notes);
    assert.ok(shownKeys.length > 0, "сигналы обязаны дойти до владельца");
    assert.ok(shownKeys.length < notes.length, "невлезшее обязано остаться недоставленным");
    // Отмечаем доставленным только то, что реально напечатано.
    const текст = parts.join("\n");
    for (const k of shownKeys) {
      const i = Number(k.slice(1, k.indexOf(":")));
      assert.ok(текст.includes(`ниже плана на ${i}%`), `ключ ${k} отмечен, а строки нет`);
    }
    assert.ok(parts.every((ч) => ч.length <= 3500));
    assert.ok(parts.length <= 3, "сводка не должна занимать чат целиком");
  });

  it("сводка не влезла в лимит частей — сигналы НЕ отмечаются доставленными", () => {
    // Ключ ack необратим: отметив срезанное, мы теряем сигнал навсегда.
    const толстая: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      machines: Array.from({ length: 400 }, (_, i) => ({
        serial: `25081603${i}`,
        name: `Автомат номер ${i} с длинным адресом`,
        qty: 100 + i,
        revenue: 1_000_000 + i,
        margin: 300_000 + i,
        pct: 30,
      })),
    };
    const { parts, shownKeys } = formatWeeklyDigest(толстая, [{ key: "e1:sales.drop", text: "📉 Продажи ниже плана" }]);
    assert.equal(shownKeys.length, 0);
    assert.ok(parts.length <= 3);
    assert.match(parts[parts.length - 1]!, /остальное на вкладке «Снек» в панели/);
  });

  it("пустых прогонов сбора не выдаём за здоровье", () => {
    // `failedStreak: 0` при пустом журнале значит «сбор ни разу не
    // запускался». На ПУСТОЙ неделе это опаснее всего: именно стоящий сбор её
    // обычно и объясняет, а ✅ увело бы владельца искать причину в продажах.
    const мёртвыйСбор: WeeklyDigest = {
      ...ПУСТАЯ_НЕДЕЛЯ,
      health: {
        runs: [],
        failedStreak: 0,
        lastSuccessAt: null,
        slotsLagMin: null,
        salesLagH: null,
        productSaleLagH: null,
        parity: {
          days: 7,
          ok: false,
          mismatches: 0,
          stockOk: false,
          checked: 0, stockChecked: 0,
          note:
            "собственный снапшот продаж ещё пуст — сверять нечего (агент ещё не отработал?); " +
            "остатки: снимков остатков OurVend за период нет — сверять не по чему",
        },
      },
    };
    const t = formatWeeklyDigest(мёртвыйСбор, []).parts.join("\n");
    assert.match(t, /Прогонов сбора за период нет — здоровье не оценить/);
    assert.ok(!t.includes("✅"), "зелёной галки над пустым журналом быть не должно");
    assert.ok(!t.includes("Прогоны (0)"));
  });

  it("здоровье в сводке — счёт прогонов, свежесть и паритет, а не одна строка", () => {
    const t = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.match(t, /Прогоны \(1\): успешных 1 · частичных 0 · с отказом 0/);
    assert.match(t, /Свежесть: слоты — 42 мин · продажи — 3 ч/);
    assert.match(t, /Паритет за 7 дн\.: продажи ✅ сходятся · остатки ✅/);
  });

  it("деньги недели — с «сум» в каждой строке (U1–U3)", () => {
    const t = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.match(t, /Итого: выручка 2 157 000 сум · маржа 607 595 сум/);
    assert.match(t, /Olma Администрация: выручка 1 487 000 сум · маржа 421 310 сум/);
  });

  it("первой недели без прошлой — одна фраза, а не две подряд (U7)", () => {
    // «+1 500 000 сум (прошлая неделя в нуле) к прошлой неделе (2026-33)» —
    // «прошлая неделя» дважды в одной строке.
    const перваяНеделя: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      delta: {
        qty: 599,
        revenue: 2_157_000,
        margin: 607_595,
        qtyPct: null,
        revenuePct: null,
        marginPct: null,
      },
    };
    const t = formatWeeklyDigest(перваяНеделя, []).parts.join("\n");
    assert.match(t, /к прошлой неделе \(2026-33, была в нуле\)/);
    assert.equal(t.match(/прошл/gi)?.length, 1);
  });

  it("подсказка недели показывает, какие это числа (U12)", () => {
    assert.match(WEEKLY_WEEK_HINT, /2026-34/);
    assert.match(WEEKLY_WEEK_HINT, /17[–-]23/);
  });

  it("раздел здоровья назван так же, как в «сверке» и в панели (U15)", () => {
    const t = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.match(t, /🩺 Здоровье сбора OurVend/);
  });

  it("недосчитанные секции сводки названы, а не потеряны молча", () => {
    // Секция деградирует (Core ловит её падение в `warnings`), и письмо обязано
    // сказать, чего в нём нет: молчаливая дыра читается как «данных нет».
    const сЗамечанием: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      warnings: [{ code: "no_sales", message: "Здоровье сбора не получено — раздел неполон." }],
    };
    const t = formatWeeklyDigest(сЗамечанием, []).parts.join("\n");
    assert.match(t, /Посчитано не всё:/);
    assert.match(t, /Здоровье сбора не получено/);
  });

  it("пустая неделя: сказано «продаж за неделю нет», а не нули", () => {
    const { parts } = formatWeeklyDigest(ПУСТАЯ_НЕДЕЛЯ, []);
    assert.match(parts[0]!, /продаж за неделю нет/);
    // Здоровье сбора обязано остаться: пустая неделя чаще всего означает
    // сломанный сбор, и молчать об этом хуже, чем показать нули.
    assert.match(parts.join("\n"), /Здоровье сбора OurVend/);
    assert.doesNotMatch(parts[0]!, /маржа 0 \(0 %\)/);
  });
});
