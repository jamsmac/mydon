import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failedStreak, type SyncRunFacts } from "./sync-streak";

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
