import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentTaskIntervalMs,
  DEFAULT_AGENT_TASK_INTERVAL_MS,
  MAX_AGENT_TASK_INTERVAL_MS,
  MIN_AGENT_TASK_INTERVAL_MS,
  singleFlight,
} from "./polling";

describe("Polling задач агентов", () => {
  it("invalid, zero и negative интервалы возвращает к default, а не к 1 ms", () => {
    for (const raw of [undefined, "", "   ", "NaN", "Infinity", "0", "-1"]) {
      assert.equal(agentTaskIntervalMs(raw), DEFAULT_AGENT_TASK_INTERVAL_MS, String(raw));
    }
  });

  it("clamp-ит корректные крайние значения в безопасный диапазон Node timer", () => {
    assert.equal(agentTaskIntervalMs("0.5"), MIN_AGENT_TASK_INTERVAL_MS);
    assert.equal(agentTaskIntervalMs("1500.9"), 1500);
    assert.equal(agentTaskIntervalMs(String(Number.MAX_SAFE_INTEGER)), MAX_AGENT_TASK_INTERVAL_MS);
  });

  it("single-flight не пускает перекрывающийся poll и снимает guard после завершения", async () => {
    let finish: (() => void) | undefined;
    let calls = 0;
    const poll = singleFlight(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    const first = poll();
    assert.equal(await poll(), false, "тик во время прохода пропускается");
    assert.equal(calls, 1);
    assert.ok(finish);
    finish();
    assert.equal(await first, true);

    const second = poll();
    await Promise.resolve();
    assert.equal(calls, 2, "после завершения новый проход разрешён");
    assert.ok(finish);
    finish();
    assert.equal(await second, true);
  });

  it("single-flight снимает guard и после ошибки", async () => {
    let calls = 0;
    const poll = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Core unavailable");
    });

    await assert.rejects(poll(), /Core unavailable/);
    assert.equal(await poll(), true);
    assert.equal(calls, 2);
  });
});
