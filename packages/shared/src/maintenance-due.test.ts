import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDays,
  addMonths,
  advanceAnchor,
  computeDue,
  daysBetween,
  dueText,
  firstDue,
  hasPeriod,
} from "./maintenance-due";

describe("Арифметика дат обслуживания", () => {
  it("разница считается в календарных днях, а не делением миллисекунд", () => {
    assert.equal(daysBetween("2026-03-01", "2026-03-31"), 30);
    assert.equal(daysBetween("2026-03-31", "2026-03-01"), -30);
    assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1, "2026 не високосный");
    assert.equal(daysBetween("2024-02-28", "2024-03-01"), 2, "2024 високосный");
  });

  it("прибавление месяцев не выходит за край короткого месяца", () => {
    // 31 января + 1 месяц = 28 февраля, а не 3 марта. Иначе годовой график
    // каждый раз уползал бы на несколько дней.
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
    assert.equal(addMonths("2026-01-15", 12), "2027-01-15");
    assert.equal(addMonths("2026-12-31", 1), "2027-01-31");
  });

  it("прибавление дней переходит через месяц и год", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });
});

describe("Сдвиг якоря после работы", () => {
  it("считает от плановой даты, а не от фактической — график не ползёт", () => {
    // Мойка раз в 30 дней, срок 1 марта, сделали 5-го. Следующая — 31 марта.
    // Если считать от факта, получилось бы 4 апреля, и за год «ежемесячная»
    // работа делалась бы десять раз вместо двенадцати.
    assert.equal(advanceAnchor("2026-03-01", "2026-03-05", { everyDays: 30 }), "2026-03-31");
  });

  it("досрочная работа тоже не сдвигает график вперёд", () => {
    assert.equal(advanceAnchor("2026-03-01", "2026-02-25", { everyDays: 30 }), "2026-03-31");
  });

  it("после долгого пропуска не требует все пропущенные работы разом", () => {
    // Пропустили три месяца. Якорь двигается целыми периодами, пока не
    // окажется в будущем, — иначе система тут же выкатила бы три просрочки.
    const next = advanceAnchor("2026-03-01", "2026-06-01", { everyDays: 30 });
    assert.equal(next, "2026-06-29");
    assert.ok(daysBetween("2026-06-01", next) > 0, "новый срок должен быть в будущем");
  });

  it("месячный период сохраняет число месяца", () => {
    assert.equal(advanceAnchor("2026-01-31", "2026-02-01", { everyMonths: 1 }), "2026-02-28");
  });

  it("без норматива якорь не двигается", () => {
    assert.equal(advanceAnchor("2026-03-01", "2026-03-05", {}), "2026-03-01");
  });

  it("нулевой период не вешает цикл", () => {
    // Мусор в данных не должен превращаться в бесконечный цикл на сервере.
    const next = advanceAnchor("2026-03-01", "2026-06-01", { everyDays: 0 });
    assert.equal(typeof next, "string");
  });
});

describe("Статус норматива", () => {
  const TODAY = "2026-08-06";

  it("без норматива — unknown, а не «в норме»", () => {
    // «В норме» на незаполненном нормативе — это ложное спокойствие.
    const r = computeDue({ dueOn: "2026-09-01" }, TODAY);
    assert.equal(r.status, "unknown");
    assert.equal(hasPeriod({}), false);
  });

  it("срок сегодня — это ещё не просрочка", () => {
    // Техник закроет вечером. Красить это красным значит приучить к красному.
    const r = computeDue({ everyDays: 30, dueOn: TODAY }, TODAY);
    assert.equal(r.status, "due");
    assert.equal(r.daysLeft, 0);
  });

  it("вчерашний срок — просрочка", () => {
    const r = computeDue({ everyDays: 30, dueOn: "2026-08-05" }, TODAY);
    assert.equal(r.status, "overdue");
    assert.equal(r.daysLeft, -1);
  });

  it("«скоро» ограничено горизонтом предупреждения", () => {
    assert.equal(computeDue({ everyDays: 30, dueOn: "2026-08-08", taskLeadDays: 3 }, TODAY).status, "soon");
    assert.equal(computeDue({ everyDays: 30, dueOn: "2026-08-10", taskLeadDays: 3 }, TODAY).status, "ok");
  });

  it("якорь выводится из последней работы, если его не задавали", () => {
    const r = computeDue({ everyDays: 30, lastDoneOn: "2026-07-10" }, TODAY);
    assert.equal(r.nextDueOn, "2026-08-09");
    // Ровно 3 дня при горизонте 3 — это уже «скоро»: граница включительная,
    // иначе предупреждение приходило бы на день позже, чем обещано.
    assert.equal(r.daysLeft, 3);
    assert.equal(r.status, "soon");
  });

  it("норматив есть, а опереться не на что — unknown", () => {
    // Ни якоря, ни последней работы, ни показаний счётчика.
    assert.equal(computeDue({ everyDays: 30 }, TODAY).status, "unknown");
  });

  it("счётчик работает без календаря", () => {
    const r = computeDue({ everyCount: 5000, counterNow: 5200, counterAtLastDone: 200 }, TODAY);
    assert.equal(r.countLeft, 0);
    assert.equal(r.status, "overdue");
  });

  it("из календаря и счётчика побеждает то, что наступает раньше", () => {
    // Фильтр меняют либо через 90 дней, либо через 5000 чашек — что раньше.
    const r = computeDue(
      { everyDays: 90, dueOn: "2026-10-01", everyCount: 5000, counterNow: 5100, counterAtLastDone: 0 },
      TODAY,
    );
    assert.equal(r.status, "overdue", "по календарю ещё далеко, но чашки кончились");
  });

  it("календарная просрочка не теряется из-за свежего счётчика", () => {
    const r = computeDue(
      { everyDays: 90, dueOn: "2026-08-01", everyCount: 5000, counterNow: 100, counterAtLastDone: 0 },
      TODAY,
    );
    assert.equal(r.status, "overdue");
  });

  it("первое показание без базы считается от нуля", () => {
    const r = computeDue({ everyCount: 1000, counterNow: 300 }, TODAY);
    assert.equal(r.countLeft, 700);
    assert.equal(r.status, "ok");
  });
});

describe("Подпись срока", () => {
  const TODAY = "2026-08-06";
  it("человеческая, а не ISO", () => {
    assert.equal(dueText(computeDue({ everyDays: 30, dueOn: "2026-08-03" }, TODAY)), "просрочено на 3 дн.");
    assert.equal(dueText(computeDue({ everyDays: 30, dueOn: TODAY }, TODAY)), "сегодня");
    assert.equal(dueText(computeDue({ everyDays: 30, dueOn: "2026-08-07" }, TODAY)), "завтра");
    assert.equal(dueText(computeDue({ everyDays: 30, dueOn: "2026-08-11" }, TODAY)), "через 5 дн.");
    assert.equal(dueText(computeDue({ dueOn: "2026-08-11" }, TODAY)), "норматив не задан");
  });
});

describe("Первый срок нового норматива", () => {
  it("месяцы имеют приоритет над днями — они точнее выражают «раз в квартал»", () => {
    assert.equal(firstDue("2026-08-06", { everyMonths: 3, everyDays: 90 }), "2026-11-06");
    assert.equal(firstDue("2026-08-06", { everyDays: 14 }), "2026-08-20");
    assert.equal(firstDue("2026-08-06", { everyCount: 5000 }), null, "счётчику календарный срок не нужен");
  });
});
