import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { строкаЗастоя } from "./analytics-brief";
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
    staleHours: 0.5,
    staleThresholdH: 6,
    slotsLagMin: 42,
    salesLagH: 3,
    snapshotStale: false,
    productSaleLagH: 5,
    parityStreak: 3,
    cutoverThreshold: 7,
    parityLastRed: null,
    parityStreakSince: "2026-08-21",
    parity: { days: 7, ok: true, mismatches: 0, stockOk: true, checked: 2, stockChecked: 2, mode: "mirror", note: null },
  },
  // Числа ЗА НЕДЕЛЮ, о которой письмо: сбор ходит раз в 3 ч (8 прогонов в
  // сутки), на неделе один частичный и один отказ — прод-порядок.
  weekHealth: {
    week: "2026-34",
    runs: 56,
    success: 54,
    partial: 1,
    failed: 1,
    running: 0,
    worstFailedStreak: 1,
    lastDataAt: "2026-08-23T03:07:00Z",
    parityDays: [
      { date: "2026-08-23", ok: true, salesChecked: 2, stockChecked: 68, note: null },
      { date: "2026-08-22", ok: true, salesChecked: 2, stockChecked: 68, note: null },
      { date: "2026-08-21", ok: false, salesChecked: 2, stockChecked: 0, note: "снимков остатков нет" },
      { date: "2026-08-20", ok: true, salesChecked: 2, stockChecked: 68, note: null },
      { date: "2026-08-19", ok: true, salesChecked: 2, stockChecked: 68, note: null },
      { date: "2026-08-18", ok: false, salesChecked: 0, stockChecked: 0, note: "сверять не по чему" },
      { date: "2026-08-17", ok: true, salesChecked: 2, stockChecked: 68, note: null },
    ],
    parityGreen: 5,
    parityRed: 2,
    partialWeek: false,
    capped: false,
    // Журнал `vending_sync_run` на проде начат 06.08.2026 — неделя 34 лежит
    // ПОСЛЕ него, и о журнале письмо не говорит ничего.
    journalSince: "2026-08-06",
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
  // Ни одного прогона за неделю — это НЕ «отказов 0»: сбор не запускался.
  weekHealth: {
    week: "2026-35",
    runs: 0,
    success: 0,
    partial: 0,
    failed: 0,
    running: 0,
    worstFailedStreak: 0,
    lastDataAt: null,
    parityDays: [],
    parityGreen: 0,
    parityRed: 0,
    partialWeek: false,
    capped: false,
    journalSince: "2026-08-06",
  },
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
        staleHours: null,
        staleThresholdH: 6,
        slotsLagMin: null,
        salesLagH: null,
        snapshotStale: false,
        productSaleLagH: null,
        parityStreak: 0,
        cutoverThreshold: 7,
        parityLastRed: null,
        parityStreakSince: null,
        parity: {
          days: 7,
          ok: false,
          mismatches: 0,
          stockOk: false,
          checked: 0, stockChecked: 0,
          mode: "mirror",
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
    // Финальное ревью (major-1): та же логика для `ЗДОРОВЬЕ_НЕИЗВЕСТНО`,
    // когда `health()` в Core падает и письмо, которое уходит само по
    // понедельникам, не обязано утверждать про застой то, чего не измеряло.
    assert.ok(!t.includes("сбор стоит"));
  });

  it("здоровье в сводке — счёт прогонов недели, свежесть и паритет, а не одна строка", () => {
    const t = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    // Счёт прогонов даёт строка НЕДЕЛИ: неподписанный «Прогоны (N)» по
    // последним двадцати из письма убран (UX-6), в «сверке» он остался.
    assert.match(t, /За неделю: прогонов 56 · успешных 54/);
    assert.match(t, /Свежесть: слоты — 42 мин · продажи — 3 ч/);
    assert.match(t, /Паритет за 7 дн\.: продажи ✅ сходятся · остатки ✅/);
  });

  it("застой сбора (R-P8a-6) — тот же общий форматтер, что у «сверки»", () => {
    // Своя формулировка здесь разошлась бы с ботом ровно там, где владелец
    // читает без запроса: письмо приходит само в понедельник утром.
    const застойШёл: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      health: { ...ДАЙДЖЕСТ_34.health, staleHours: 9, staleThresholdH: 6 },
    };
    const t = formatWeeklyDigest(застойШёл, []).parts.join("\n");
    assert.match(t, /⛔ сбор стоит 9 ч/);
    // F1: `ДАЙДЖЕСТ_34.health` — ровно молчащий крон (failedStreak: 0,
    // последний ЗАПИСАННЫЙ прогон успешен), и без гейта в `состояниеСбора`
    // тут встала бы противоречащая зелёная галка сразу под «⛔».
    assert.ok(!t.includes("✅ Отказов подряд нет"));
  });

  it("F1: застой + серия отказов подряд — оба сигнала в сводке разом", () => {
    const обаСигнала: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      health: {
        ...ДАЙДЖЕСТ_34.health,
        failedStreak: 5,
        staleHours: 9,
        staleThresholdH: 6,
      },
    };
    const t = formatWeeklyDigest(обаСигнала, []).parts.join("\n");
    assert.match(t, /⛔ сбор стоит 9 ч/);
    assert.match(t, /❌ 5 отказов подряд/);
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

/**
 * Неделя 2026-31 — целиком раньше первого прогона в журнале (06.08.2026).
 * Предупреждения — как их шлёт ядро: `journal_short` про сам журнал и
 * соседнее `health_unavailable` про паритет, которое значит другое.
 */
const ДО_ЖУРНАЛА = {
  ...ПУСТАЯ_НЕДЕЛЯ,
  from: "2026-07-27",
  to: "2026-08-02",
  weekHealth: { ...ПУСТАЯ_НЕДЕЛЯ.weekHealth, week: "2026-31", journalSince: "2026-08-06" },
  warnings: [
    { code: "journal_short", message: "Журнал прогонов начинается с 06.08.2026 — за эту неделю данных нет." },
    { code: "health_unavailable", message: "Дни паритета за эту неделю вне окна счёта серии (14 дней)." },
  ],
} as unknown as WeeklyDigest;

describe("Блок здоровья: сначала неделя, потом «сейчас» (R-H-9)", () => {
  it("печатает недельные числа и отдельно строки момента", () => {
    const текст = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.match(
      текст,
      /За неделю: прогонов 56 · успешных 54 · частичных 1 · отказов 1 · незакрытых 0 · худшая серия 1/,
    );
    assert.match(текст, /Паритет недели: 5 зелёных \/ 2 красных/);
    assert.match(текст, /Сейчас: /, "состояние момента обязано быть ПОДПИСАНО словом «сейчас»");
  });

  it("итог сходится с разрядами: сумма четырёх напечатана рядом с ними", () => {
    const w = ДАЙДЖЕСТ_34.weekHealth;
    assert.equal(w.runs, w.success + w.partial + w.failed + w.running);
    const текст = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.match(текст, new RegExp(`прогонов ${w.runs} `));
  });

  it("склонение по числу: «1 зелёный / 1 красный», а не «1 зелёных»", () => {
    // Неделя с одним зелёным днём после починки — рядовой случай, и в одном
    // письме «1 зелёных» встало бы рядом с правильным «1 зелёный дн. подряд».
    const одинИодин: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      weekHealth: { ...ДАЙДЖЕСТ_34.weekHealth, parityGreen: 1, parityRed: 1 },
    };
    assert.match(formatWeeklyDigest(одинИодин, []).parts.join("\n"), /Паритет недели: 1 зелёный \/ 1 красный/);
    const двоеИпятеро: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      weekHealth: { ...ДАЙДЖЕСТ_34.weekHealth, parityGreen: 2, parityRed: 5 },
    };
    assert.match(formatWeeklyDigest(двоеИпятеро, []).parts.join("\n"), /Паритет недели: 2 зелёных \/ 5 красных/);
  });

  it("неполная неделя подписана прямо в строке чисел", () => {
    // Оговорка ниже чисел читалась бы как новость о сборе, а не как их граница.
    const идёт: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      weekHealth: { ...ДАЙДЖЕСТ_34.weekHealth, partialWeek: true },
    };
    assert.match(formatWeeklyDigest(идёт, []).parts.join("\n"), /худшая серия 1 \(неделя ещё идёт\)/);
  });

  it("обрезанный журнал прогонов назван ОДИН раз — в «Посчитано не всё», а не ещё и хвостом чисел", () => {
    // Одну причину владелец читает один раз: хвост письма несёт её вместе с
    // адресом, где журнал виден целиком, — строка чисел то же самое повторяла
    // бы короче и без адреса.
    const обрезан: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      weekHealth: { ...ДАЙДЖЕСТ_34.weekHealth, capped: true },
      warnings: [
        { code: "history_capped", message: "Прогонов за неделю больше 200 — счёт по самым свежим прогонам окна." },
      ],
    };
    const текст = formatWeeklyDigest(обрезан, []).parts.join("\n");
    assert.equal(/показаны не все прогоны недели/.test(текст), false);
    assert.match(текст, /Посчитано не всё:/);
    assert.equal(текст.match(/Прогонов за неделю больше 200/g)?.length, 1);
  });

  it("прогоны были, а данных нет — сказано словами, а не «не было» после двоеточия", () => {
    const безДанных: WeeklyDigest = {
      ...ДАЙДЖЕСТ_34,
      weekHealth: { ...ДАЙДЖЕСТ_34.weekHealth, runs: 3, success: 0, partial: 0, failed: 3, lastDataAt: null },
    };
    const текст = formatWeeklyDigest(безДанных, []).parts.join("\n");
    assert.match(текст, /Данные за неделю не приезжали ни разу/);
    assert.equal(/Данные последний раз приехали/.test(текст), false);
  });

  it("числа недели стоят ВЫШЕ чисел момента: письмо подписано неделей", () => {
    const текст = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.ok(текст.indexOf("За неделю: прогонов") < текст.indexOf("Сейчас: "));
  });

  it("счёт прогонов в письме ОДИН: неподписанной строки «Прогоны (N)» рядом с недельной нет", () => {
    // «Прогоны (20): успешных …» считает последние 20 прогонов, а не неделю и
    // не момент, и стояла БЕЗ подписи окна — почти той же лексикой, что строка
    // «За неделю: прогонов 56 · успешных 54 …» двумя строками выше. С телефона
    // два таких блока читаются как противоречие отчёта самому себе. В «сверке»
    // строка остаётся: там она единственная.
    const текст = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.equal(/Прогоны \(/.test(текст), false);
    assert.equal(текст.match(/прогонов 56/g)?.length, 1);
    // Всё, что говорит о МОМЕНТЕ, подписано словом «сейчас».
    for (const строка of текст.split("\n").filter((l) => /Отказов подряд нет|сбор стоит/.test(l))) {
      assert.match(строка, /^Сейчас: /);
    }
  });

  it("письмо от СТАРОГО Core без `weekHealth` уходит, а не падает молча", () => {
    // `core-client.request<WeeklyDigest>` — непроверенный каст: окно
    // перезапуска compose или откат образа Core отдали бы сводку без нового
    // поля, `w.runs` бросил бы TypeError, `withRetries` повторил бы трижды — и
    // понедельничное письмо не ушло бы вовсе, а следующее только через неделю.
    const старый = { ...ДАЙДЖЕСТ_34, weekHealth: undefined } as unknown as WeeklyDigest;
    const текст = formatWeeklyDigest(старый, []).parts.join("\n");
    assert.match(текст, /🩺 Здоровье сбора OurVend/);
    assert.match(текст, /здоровье недели недоступно/);
    // Числа момента и деньги недели от этого не страдают — они честные.
    assert.match(текст, /Сейчас: /);
    assert.equal(/За неделю: прогонов/.test(текст), false);
  });

  it("неделя раньше начала журнала прогонов названа так, а не «сбор не запускался»", () => {
    // Журнал `vending_sync_run` начат 06.08.2026: за неделю до него прогонов
    // НЕ БЫЛО В ЖУРНАЛЕ, а не «сбор не запускался» — разные вещи, и вторая
    // отправила бы владельца искать поломку, которой не было.
    const текст = formatWeeklyDigest(ДО_ЖУРНАЛА, []).parts.join("\n");
    assert.match(текст, /журнал прогонов начинается с 06\.08\.2026 — за эту неделю данных нет/);
    assert.equal(/сбор не запускался/.test(текст), false);
  });

  it("про начало журнала владелец читает ОДИН раз: хвост письма ту же фразу не повторяет", () => {
    // Ядро шлёт ту же правду кодом `journal_short`, а блок здоровья печатает
    // её НА МЕСТЕ лжи «сбор не запускался». Две одинаковые строки в одном
    // письме — то же, за что убрана пометка про обрезку журнала (D4).
    const текст = formatWeeklyDigest(ДО_ЖУРНАЛА, []).parts.join("\n");
    assert.equal(текст.match(/журнал прогонов начинается с 06\.08\.2026/gi)?.length, 1);
    // Гасится РОВНО `journal_short`. Соседние предупреждения — в том числе
    // «не посчиталось» (`health_unavailable`), которое значит совсем другое, —
    // доезжают: код у них свой, и путать их нельзя.
    assert.match(текст, /вне окна счёта серии/);
  });

  it("блок недели не напечатан — предупреждение о журнале доезжает: гасим только напечатанное", () => {
    // Старый Core: `weekHealth` нет вовсе, строку про журнал печатать нечем —
    // и тогда предупреждение остаётся ЕДИНСТВЕННЫМ носителем этого факта.
    // Безусловное гашение кода потеряло бы его молча.
    const безНедели = { ...ДО_ЖУРНАЛА, weekHealth: undefined } as unknown as WeeklyDigest;
    const текст = formatWeeklyDigest(безНедели, []).parts.join("\n");
    assert.match(текст, /здоровье недели недоступно/);
    assert.match(текст, /Журнал прогонов начинается с 06\.08\.2026/);
  });

  it("неделя ПОСЛЕ начала журнала про него не говорит", () => {
    const после = {
      ...ДАЙДЖЕСТ_34,
      weekHealth: { ...ДАЙДЖЕСТ_34.weekHealth, journalSince: "2026-08-06" },
    } as unknown as WeeklyDigest;
    assert.equal(/журнал прогонов начинается/.test(formatWeeklyDigest(после, []).parts.join("\n")), false);
  });

  it("данные недели — свой момент, а не общий «последний успех»", () => {
    // Слово «успех» в этой строке спорило бы с разрядом «успешных N» выше:
    // Core датирует её прогоном, ДОНЁСШИМ ДАННЫЕ (`success` ИЛИ `partial`).
    const текст = formatWeeklyDigest(ДАЙДЖЕСТ_34, []).parts.join("\n");
    assert.match(текст, /Данные последний раз приехали: 23\.08 08:07/);
    assert.match(текст, /Сейчас: .* последний успех 23\.08 08:07/);
  });

  it("неделя без прогонов — «сбор не запускался», а не «отказов 0»", () => {
    const текст = formatWeeklyDigest(ПУСТАЯ_НЕДЕЛЯ, []).parts.join("\n");
    assert.match(текст, /За неделю прогонов не было — сбор не запускался/);
    assert.equal(/отказов 0/.test(текст), false, "нули читаются как посчитанный результат");
    // Про данные всё сказано той же строкой — вторая («не приезжали») была бы
    // повтором в письме, у которого бюджет в три сообщения.
    assert.equal(/Данные/.test(текст), false);
  });

  it("дней паритета за неделю нет — строки нет вовсе, а не «0 зелёных / 0 красных»", () => {
    const текст = formatWeeklyDigest(ПУСТАЯ_НЕДЕЛЯ, []).parts.join("\n");
    assert.equal(/Паритет недели:/.test(текст), false);
  });

  it("строка застоя и строка снапшота не изменились: два отчёта об одних числах говорят одно", () => {
    const h = { ...ДАЙДЖЕСТ_34.health, staleHours: 9, staleThresholdH: 6 };
    const текст = formatWeeklyDigest({ ...ДАЙДЖЕСТ_34, health: h }, []).parts.join("\n");
    assert.ok(текст.includes(строкаЗастоя(h)!), "письмо обязано печатать ТОТ ЖЕ форматтер, что «сверка»");
  });
});
