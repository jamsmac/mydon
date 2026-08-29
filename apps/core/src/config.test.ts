import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appConfig } from "./config";

describe("appConfig.agentDailyActionCap", () => {
  it("accepts only zero or a positive safe integer and otherwise fails to the safe default", () => {
    const previous = process.env.AGENT_DAILY_ACTION_CAP;
    try {
      delete process.env.AGENT_DAILY_ACTION_CAP;
      assert.equal(appConfig.agentDailyActionCap, 50);

      process.env.AGENT_DAILY_ACTION_CAP = "0";
      assert.equal(appConfig.agentDailyActionCap, 0);

      process.env.AGENT_DAILY_ACTION_CAP = "17";
      assert.equal(appConfig.agentDailyActionCap, 17);

      for (const unsafe of ["0.5", "17.9", "-1", "Infinity", "not-a-number"]) {
        process.env.AGENT_DAILY_ACTION_CAP = unsafe;
        assert.equal(appConfig.agentDailyActionCap, 50, unsafe);
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_DAILY_ACTION_CAP;
      else process.env.AGENT_DAILY_ACTION_CAP = previous;
    }
  });
});
