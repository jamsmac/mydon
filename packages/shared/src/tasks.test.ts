import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dueLabel, groupByUrgency, parseDue, priorityLabel, type TaskLike } from "./tasks";

// Фиксированный «сейчас»: среда, 29 июля 2026, 12:00 — иначе тесты про
// «завтра» и дни недели ломались бы в зависимости от дня прогона.
const NOW = new Date(2026, 6, 29, 12, 0, 0);

function task(due: string | null, priority: TaskLike["priority"] = "normal"): TaskLike {
  return { due, priority };
}

describe("Срок словами (владелец не воюет с календарём)", () => {
  it("понимает «сегодня», «завтра», «послезавтра»", () => {
    const today = parseDue("сегодня", NOW);
    assert.equal(today?.getDate(), 29);
    const tomorrow = parseDue("завтра", NOW);
    assert.equal(tomorrow?.getDate(), 30);
    assert.equal(parseDue("послезавтра", NOW)?.getDate(), 31);
  });

  it("берёт время из «в 9» и «к 14:30»", () => {
    const a = parseDue("завтра в 9", NOW);
    assert.equal(a?.getHours(), 9);
    assert.equal(a?.getMinutes(), 0);
    const b = parseDue("сегодня к 14:30", NOW);
    assert.equal(b?.getHours(), 14);
    assert.equal(b?.getMinutes(), 30);
  });

  it("без указания времени ставит конец рабочего дня, а не полночь", () => {
    // Полночь означала бы «просрочено весь день» — задача выглядела бы горящей зря.
    assert.equal(parseDue("завтра", NOW)?.getHours(), 18);
  });

  it("понимает «через 3 дня» и «через неделю»", () => {
    assert.equal(parseDue("через 3 дня", NOW)?.getDate(), 1); // 29 + 3 = 1 августа
    assert.equal(parseDue("через неделю", NOW)?.getDate(), 5);
  });

  it("день недели — всегда ближайший будущий, а не сегодняшний", () => {
    // NOW — среда. «ср» должна дать следующую среду, иначе задача «на среду»
    // немедленно оказалась бы просроченной.
    const wed = parseDue("ср", NOW);
    assert.equal(wed?.getDate(), 5); // +7 дней
    assert.equal(parseDue("пт", NOW)?.getDate(), 31); // ближайшая пятница
  });

  it("понимает дату 25.08 и 25.08.2026", () => {
    const a = parseDue("25.08", NOW);
    assert.equal(a?.getDate(), 25);
    assert.equal(a?.getMonth(), 7);
    assert.equal(parseDue("25.08.2026", NOW)?.getFullYear(), 2026);
  });

  it("непонятное — не срок, а не выдуманная дата", () => {
    assert.equal(parseDue("когда-нибудь потом", NOW), null);
    assert.equal(parseDue("", NOW), null);
  });
});

describe("Группировка «что делать сейчас»", () => {
  it("раскладывает по срочности и не теряет задачи без срока", () => {
    const groups = groupByUrgency(
      [
        task(new Date(2026, 6, 28, 10).toISOString()), // вчера
        task(new Date(2026, 6, 29, 18).toISOString()), // сегодня
        task(new Date(2026, 6, 31, 10).toISOString()), // через 2 дня
        task(new Date(2026, 8, 15, 10).toISOString()), // далеко
        task(null), // без срока
      ],
      NOW,
    );
    assert.deepEqual(
      groups.map((g) => g.key),
      ["overdue", "today", "week", "later", "someday"],
    );
    assert.equal(groups.every((g) => g.tasks.length === 1), true);
  });

  it("пустые группы не показываются — список не должен состоять из заголовков", () => {
    const groups = groupByUrgency([task(null)], NOW);
    assert.deepEqual(groups.map((g) => g.key), ["someday"]);
  });

  it("битая дата не выбрасывается, а попадает в «без срока»", () => {
    const groups = groupByUrgency([task("не-дата")], NOW);
    assert.equal(groups[0]?.key, "someday");
  });
});

describe("Подписи для владельца", () => {
  it("срок объясняется словами, а не датой", () => {
    assert.match(dueLabel(new Date(2026, 6, 29, 18).toISOString(), NOW), /сегодня в 18:00/);
    assert.match(dueLabel(new Date(2026, 6, 30, 9).toISOString(), NOW), /завтра в 09:00/);
    assert.match(dueLabel(new Date(2026, 6, 28).toISOString(), NOW), /вчера/);
    assert.equal(dueLabel(null, NOW), "без срока");
  });

  it("прошедший сегодняшний срок помечается, а не выглядит будущим", () => {
    assert.match(dueLabel(new Date(2026, 6, 29, 9).toISOString(), NOW), /прошло/);
  });

  it("обычная срочность не помечается — иначе пометки у всех и смысла ноль", () => {
    assert.equal(priorityLabel("normal"), null);
    assert.match(priorityLabel("urgent") ?? "", /срочно/);
  });
});
