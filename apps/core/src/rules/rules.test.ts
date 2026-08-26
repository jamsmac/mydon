import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyRules, formatAmount, immediateOnly, RULES } from "./rules";

const ctx = (type: string, payload: Record<string, unknown> = {}) => ({
  source: "test",
  type,
  payload,
});

describe("Правила уведомлений (FR-2)", () => {
  it("правил не меньше 10 — требование DoD Фазы 6", () => {
    assert.ok(RULES.length >= 10, `правил ${RULES.length}, нужно ≥10`);
  });

  it("у правил уникальные идентификаторы", () => {
    const ids = RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("все четыре тревоги владельца (Ф11) доставляются немедленно", () => {
    const alarms = ["money.overdue", "machine.idle", "lead.new", "contract.expiring"];
    for (const id of alarms) {
      const rule = RULES.find((r) => r.id === id);
      assert.ok(rule, `нет правила ${id}`);
      assert.equal(rule.urgency, "immediate", `${id} должно быть немедленным`);
    }
  });

  it("оформляет просроченный платёж понятной фразой", () => {
    const [n] = applyRules(ctx("money.overdue", { counterparty: "Olma", amount: 1500000, daysOverdue: 12 }));
    assert.match(n.text, /Olma/);
    assert.match(n.text, /1 500 000 UZS/);
    assert.match(n.text, /12 дн/);
  });

  it("условные правила молчат, когда условие не выполнено", () => {
    assert.equal(applyRules(ctx("machine.idle", { machine: "A1", hours: 2 })).length, 0);
    assert.equal(applyRules(ctx("machine.idle", { machine: "A1", hours: 8 })).length, 1);
  });

  it("незначительное изменение курса не беспокоит", () => {
    assert.equal(applyRules(ctx("fx.changed", { currency: "USD", changePercent: 0.2 })).length, 0);
    assert.equal(applyRules(ctx("fx.changed", { currency: "USD", changePercent: 2.5 })).length, 1);
  });

  it("неизвестное событие не порождает уведомлений и не падает", () => {
    assert.deepEqual(applyRules(ctx("что-то.новое", { x: 1 })), []);
  });

  it("пустой payload не роняет оформление", () => {
    const n = applyRules(ctx("machine.offline"));
    assert.equal(n.length, 1);
    assert.match(n[0].text, /не на связи/);
  });

  it("битое правило не мешает остальным", () => {
    const broken = [
      {
        id: "broken",
        eventType: "test.event",
        urgency: "immediate" as const,
        format: () => {
          throw new Error("сломалось");
        },
      },
      {
        id: "healthy",
        eventType: "test.event",
        urgency: "immediate" as const,
        format: () => "всё хорошо",
      },
    ];
    const out = applyRules(ctx("test.event"), broken);
    assert.equal(out.length, 2, "оба правила должны дать результат");
    assert.match(out[0].text, /не смогло его оформить/);
    assert.equal(out[1].text, "всё хорошо");
  });

  it("фильтр немедленных отбирает только срочное", () => {
    const mixed = [
      ...applyRules(ctx("money.overdue", { amount: 1 })),
      ...applyRules(ctx("sales.drop", { percent: 10 })),
    ];
    assert.equal(mixed.length, 2);
    assert.equal(immediateOnly(mixed).length, 1);
  });

  it("суммы показываются по-русски", () => {
    assert.equal(formatAmount(1234567), "1 234 567 UZS");
    assert.equal(formatAmount("не число"), "0 UZS");
  });

  it("недолив бункера: почти пустой — немедленно, обычный — в брифинг", () => {
    const critical = applyRules(
      ctx("coffee.underfill", { location: "AH", position: 7, ingredient: "Кофе", netFillWeight: 80, targetFillWeight: 600, fillRatio: 0.13 }),
    );
    assert.equal(critical.length, 1);
    assert.equal(critical[0].urgency, "immediate");
    assert.match(critical[0].text, /AH/);
    assert.match(critical[0].text, /бункер 7/);

    const watch = applyRules(
      ctx("coffee.underfill", { location: "AH", position: 7, ingredient: "Кофе", netFillWeight: 400, targetFillWeight: 600, fillRatio: 0.67 }),
    );
    assert.equal(watch.length, 1);
    assert.equal(watch[0].urgency, "briefing");
  });

  it("расхождение расхода: сильное — немедленно, умеренное — в брифинг", () => {
    const critical = applyRules(
      ctx("coffee.anomaly", { location: "AH", ingredient: "Кофе", actualGrams: 570, expectedGrams: 90, deltaRatio: 5.33 }),
    );
    assert.equal(critical.length, 1);
    assert.equal(critical[0].urgency, "immediate");

    const watch = applyRules(
      ctx("coffee.anomaly", { location: "AH", ingredient: "Кофе", actualGrams: 360, expectedGrams: 330, deltaRatio: 0.15 }),
    );
    assert.equal(watch.length, 1);
    assert.equal(watch[0].urgency, "briefing");
  });

  it("усушка за порогом: товар, штуки и сумма одной строкой брифинга", () => {
    const notes = applyRules(
      ctx("vending.shrinkage_alert", {
        serial: "2508160376",
        name: "Olma",
        product: "Kinder Bueno",
        lossUnits: 9,
        lossValue: 99000,
        days: 7,
      }),
    );
    assert.equal(notes.length, 1);
    assert.equal(notes[0].urgency, "briefing");
    assert.equal(notes[0].text, "📉 Усушка Olma: Kinder Bueno −9 шт ≈ 99 000 сум за 7 дн.");
  });

  it("заливка без записи зовёт оформить её в боте; подтверждённая — молчит", () => {
    const payload = {
      serial: "2508160376",
      name: "Olma",
      units: 43,
      // 04:00 UTC = 09:00 Ташкента: владелец не должен читать со сдвигом.
      windowTo: "2026-08-24T04:00:00.000Z",
      recorded: false,
    };
    const notes = applyRules(ctx("vending.refill_detected", payload));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].urgency, "briefing");
    assert.equal(
      notes[0].text,
      "🍫 Заливка без записи: Olma +43 шт 09:00 — оформи в боте «Заполнил автомат»",
    );

    assert.equal(
      applyRules(ctx("vending.refill_detected", { ...payload, recorded: true })).length,
      0,
      "заливка, которую оператор записал, — не новость",
    );

    // Время БЕЗ зоны читается ташкентскими настенными часами, а не часами
    // процесса: иначе строка брифинга ехала бы на пять часов в контейнере с
    // TZ=UTC — ровно тот баг, на котором погорел донор VendCash.
    assert.match(
      applyRules(ctx("vending.refill_detected", { ...payload, windowTo: "2026-08-24 09:00:00" }))[0]!.text,
      / 09:00 /,
    );
  });

  it("серия отказов сбора доставляется немедленно и называет час, с которого мы слепые", () => {
    const [n] = applyRules(
      ctx("ourvend.sync_failed_streak", {
        streak: 12,
        lastError: "This operation was aborted",
        // 09:00 Ташкента: владелец не должен читать со сдвигом на пять часов.
        since: "2026-08-24T09:00:00+05:00",
      }),
    );
    assert.equal(n!.urgency, "immediate");
    assert.match(n!.text, /12 раз подряд/);
    assert.match(n!.text, /24\.08 09:00: /, "серия ≥3 почти всегда начинается не сегодня — без даты тревога выглядит младше, чем есть");
    assert.match(n!.text, /This operation was aborted/);
  });

  it("серия, начавшаяся СЕГОДНЯ, даты не печатает — «когда сегодня» читается часами", () => {
    const сейчас = new Date();
    const [n] = applyRules(ctx("ourvend.sync_failed_streak", { streak: 3, since: сейчас.toISOString() }));
    const часы = сейчас.toLocaleTimeString("ru-RU", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" });
    assert.match(n!.text, new RegExp(`подряд с ${часы}:`));
  });

  it("чужой текст ошибки обрезается: длинный lastError не сделал бы сигнал недоставляемым НАВСЕГДА", () => {
    // Сообщение длиннее лимита Telegram (4096) роняет sendMessage, ack не
    // проставляется — и тревога переотправляется раз в минуту вечно.
    const [n] = applyRules(
      ctx("ourvend.sync_failed_streak", { streak: 3, since: "2026-08-24T09:00:00+05:00", lastError: "х".repeat(5000) }),
    );
    assert.ok(n!.text.length < 500, `текст правила разросся до ${n!.text.length} символов`);
    assert.match(n!.text, /х…/);
  });

  it("счётная форма не пишет «3 раз подряд»", () => {
    const [n] = applyRules(ctx("ourvend.sync_failed_streak", { streak: 3, since: "2026-08-24T09:00:00+05:00" }));
    assert.match(n!.text, /3 раза подряд/);
  });

  it("застой сбора будит немедленно и называет число часов", () => {
    const [n] = applyRules(
      ctx("ourvend.sync_stale", {
        hoursSinceSuccess: 7,
        lastSuccessAt: "2026-08-25T01:00:00.000Z",
        lastRunStatus: "failed",
      }),
    );
    assert.equal(n!.urgency, "immediate");
    assert.match(n!.text, /Сбор OurVend.*7 ч/);
    assert.match(n!.text, /failed/);
  });

  it("застой без единого успеха печатает «не было ни разу», а не «0 ч»", () => {
    // Ноль часов читается как «только что собрали» — ровно наоборот тому, что
    // означает пустой журнал успехов.
    const [n] = applyRules(ctx("ourvend.sync_stale", { hoursSinceSuccess: null, lastSuccessAt: null, lastRunStatus: null }));
    assert.equal(n!.urgency, "immediate");
    assert.doesNotMatch(n!.text, /0 ч/);
    assert.match(n!.text, /НЕ БЫЛО НИ РАЗУ/);
  });

  it("готовность к катоверу будит немедленно и называет ключ настройки", () => {
    const [n] = applyRules(ctx("ourvend.cutover_ready", { greenDays: 7, since: "2026-08-26" }));
    assert.equal(n!.urgency, "immediate");
    assert.match(n!.text, /7 дн/);
    assert.match(n!.text, /2026-08-26/);
    // Владелец идёт флипать в панель прямо из сообщения: без имени ключа он
    // пойдёт его искать, а катовер — операция на семь дней ожидания.
    assert.match(n!.text, /OURVEND_ACCOUNTING_SOURCE/);
  });

  it("готовность к катоверу — счётная форма: «1 день», а не «1 дней»", () => {
    const [n] = applyRules(ctx("ourvend.cutover_ready", { greenDays: 1, since: "2026-08-26" }));
    assert.match(n!.text, /1 день подряд/);
  });

  it("застой учётного снапшота будит немедленно и говорит, что именно встало", () => {
    const [n] = applyRules(ctx("ourvend.snapshot_stale", { hours: 37, lastFetchedAt: "2026-09-03T19:00:00.000Z" }));
    assert.equal(n!.urgency, "immediate");
    assert.match(n!.text, /37 ч/);
    // Без «продажи и остатки» тревога читается как «сломался какой-то снимок»:
    // владельцу нечем понять, что в режиме own это ОСТАНОВКА учёта, а не
    // пропущенная строка в служебной таблице.
    assert.match(n!.text, /продажи и остатки/);
  });

  it("тревога называет ВСТАВШУЮ ПОЛОВИНУ снапшота (R-FW-P2)", () => {
    // Упала одна Lot-сессия — чинить надо её, а не весь прогон агента.
    const [n] = applyRules(
      ctx("ourvend.snapshot_stale", { hours: 37, lastFetchedAt: "2026-09-03T19:00:00.000Z", таблица: "остатков" }),
    );
    assert.match(n!.text, /остатков/);
  });

  it("событие старой формы (без имени половины) читается по-прежнему", () => {
    // В журнале уже лежат события без ключа `таблица`: правило обязано остаться
    // осмысленным, а не печатать «(undefined)».
    const [n] = applyRules(ctx("ourvend.snapshot_stale", { hours: 37, lastFetchedAt: null }));
    assert.doesNotMatch(n!.text, /undefined/);
    assert.match(n!.text, /37 ч/);
  });

  it("снапшота не было ни разу — «не приходил», а не «0 ч»", () => {
    const [n] = applyRules(ctx("ourvend.snapshot_stale", { hours: null, lastFetchedAt: null }));
    assert.equal(n!.urgency, "immediate");
    assert.doesNotMatch(n!.text, /0 ч/);
    assert.match(n!.text, /НЕ ПРИХОДИЛ НИ РАЗУ/);
  });

  it("смена источника учёта доставляется немедленно и называет обе стороны", () => {
    const [n] = applyRules(ctx("ourvend.accounting_source_changed", { from: "stock", to: "own", actor: "owner" }));
    assert.equal(n!.urgency, "immediate");
    assert.match(n!.text, /stock.*own/);
    assert.match(n!.text, /owner/);
  });

  it("смена источника без автора не печатает «null»", () => {
    // `SystemService.set` кладёт actor = null, когда правку сделали не из
    // панели (скрипт, миграция): «(null)» в тревоге владелец прочтёт как сбой.
    const [n] = applyRules(ctx("ourvend.accounting_source_changed", { from: "stock", to: "own", actor: null }));
    assert.doesNotMatch(n!.text, /null/);
  });

  it("смена источника называет ДЕЙСТВУЮЩИЙ источник, если он не равен записанному", () => {
    // После шага 3 рунбука зеркала нет, и запись `stock` ничего не включает:
    // текст без «действует» обещал бы источник, которого физически нет.
    const [n] = applyRules(
      ctx("ourvend.accounting_source_changed", { from: "own", to: "stock", effective: "own", actor: "owner" }),
    );
    assert.match(n!.text, /действует: own/);
    // А когда совпадает — лишней скобки нет.
    const [ровно] = applyRules(
      ctx("ourvend.accounting_source_changed", { from: "stock", to: "own", effective: "own", actor: "owner" }),
    );
    assert.doesNotMatch(ровно!.text, /действует/);
  });

  it("недельная сводка без получателей — немедленная тревога с номером недели (N5)", () => {
    const [n] = applyRules(ctx("weekly-digest.no_recipients", { week: "2026-34" }));
    assert.equal(n!.urgency, "immediate");
    assert.match(n!.text, /получателей нет/);
    assert.match(n!.text, /owner\/manager/);
    assert.match(n!.text, /неделя 2026-34/);
  });
});
