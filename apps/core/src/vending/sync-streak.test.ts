import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failedStreak, worstFailedStreak, type SyncRunFacts } from "./sync-streak";

const прогон = (status: SyncRunFacts["status"], startedAt: string, error?: string): SyncRunFacts => ({
  status,
  startedAt: new Date(startedAt),
  ...(error === undefined ? {} : { error }),
});

const ОТКАЗ = (at: string, error = "This operation was aborted") => прогон("failed", at, error);
const УСПЕХ = (at: string) => прогон("success", at);

describe("Серия отказов сбора (R-P5b-8)", () => {
  it("считает подряд от самого свежего и называет час, с которого мы слепые", () => {
    const s = failedStreak([
      ОТКАЗ("2026-08-25T04:00:00Z", "приём слотов прерван"),
      ОТКАЗ("2026-08-24T22:00:00Z"),
      ОТКАЗ("2026-08-24T09:00:00Z"),
      УСПЕХ("2026-08-24T01:00:00Z"),
      ОТКАЗ("2026-08-23T04:00:00Z"),
    ]);

    assert.deepEqual(
      [s.streak, s.since, s.lastError],
      [3, "2026-08-24T09:00:00.000Z", "приём слотов прерван"],
      "since — старт ПЕРВОГО прогона серии, lastError — ошибка последнего",
    );
  });

  it("running серию не рвёт: запущенный прогон об итоге ничего не говорит", () => {
    const s = failedStreak([
      прогон("running", "2026-08-25T05:00:00Z"),
      ОТКАЗ("2026-08-25T04:00:00Z"),
      ОТКАЗ("2026-08-24T22:00:00Z"),
    ]);
    assert.equal(s.streak, 2);
  });

  it("partial серию рвёт: данные всё-таки приехали", () => {
    const s = failedStreak([
      ОТКАЗ("2026-08-25T04:00:00Z"),
      прогон("partial", "2026-08-24T22:00:00Z"),
      ОТКАЗ("2026-08-24T09:00:00Z"),
    ]);
    assert.equal(s.streak, 1);
  });

  it("порядок входа не важен — считаем по времени, а не по позиции в массиве", () => {
    const строки = [
      УСПЕХ("2026-08-24T01:00:00Z"),
      ОТКАЗ("2026-08-25T04:00:00Z"),
      ОТКАЗ("2026-08-24T22:00:00Z"),
    ];
    assert.equal(failedStreak(строки).streak, 2);
  });

  it("серии нет — нули и null, а не выдуманный момент", () => {
    assert.deepEqual(failedStreak([]), { streak: 0, since: null, lastError: null });
    assert.deepEqual(failedStreak([УСПЕХ("2026-08-25T04:00:00Z")]), {
      streak: 0,
      since: null,
      lastError: null,
    });
  });

  it("отказ без текста ошибки — null, а не пустая строка в тревоге", () => {
    const s = failedStreak([прогон("failed", "2026-08-25T04:00:00Z")]);
    assert.deepEqual([s.streak, s.lastError], [1, null]);
  });
});


describe("Худшая серия отказов ВНУТРИ набора (R-H-9)", () => {
  it("берёт самую длинную серию, а не последнюю", () => {
    // «Падает ли сейчас» и «была ли на неделе дыра» — разные вопросы: у одного
    // и того же набора `failedStreak` даёт 1, а худшая серия недели — 3.
    const прогоны = [
      ОТКАЗ("2026-08-23T04:00:00Z"),
      УСПЕХ("2026-08-22T04:00:00Z"),
      ОТКАЗ("2026-08-21T22:00:00Z"),
      ОТКАЗ("2026-08-21T16:00:00Z"),
      ОТКАЗ("2026-08-21T10:00:00Z"),
      УСПЕХ("2026-08-20T04:00:00Z"),
    ];
    assert.equal(worstFailedStreak(прогоны), 3);
    assert.equal(failedStreak(прогоны).streak, 1, "сосед по-прежнему отвечает на свой вопрос");
  });

  it("running серию не рвёт, partial рвёт — те же два решения, что у failedStreak", () => {
    assert.equal(
      worstFailedStreak([ОТКАЗ("2026-08-21T22:00:00Z"), прогон("running", "2026-08-21T16:00:00Z"), ОТКАЗ("2026-08-21T10:00:00Z")]),
      2,
    );
    assert.equal(
      worstFailedStreak([ОТКАЗ("2026-08-21T22:00:00Z"), прогон("partial", "2026-08-21T16:00:00Z"), ОТКАЗ("2026-08-21T10:00:00Z")]),
      1,
    );
  });

  it("отказов не было — ноль, и это не «не считали»", () => {
    assert.equal(worstFailedStreak([УСПЕХ("2026-08-21T22:00:00Z")]), 0);
    assert.equal(worstFailedStreak([]), 0);
  });

  it("порядок входа не важен: перемешанный набор даёт то же число", () => {
    // Тот же приём, что у соседа: полагаться на `order by` вызывающего значило
    // бы отдать правильность счёта на откуп чужому запросу.
    const серия = [
      ОТКАЗ("2026-08-21T10:00:00Z"),
      ОТКАЗ("2026-08-21T22:00:00Z"),
      УСПЕХ("2026-08-22T04:00:00Z"),
      ОТКАЗ("2026-08-21T16:00:00Z"),
    ];
    assert.equal(worstFailedStreak(серия), 3);
  });
});
