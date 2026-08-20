import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cashInMachines } from "./cash-estimate";

describe("Деньги в автоматах", () => {
  it("считает наличные после последней принятой инкассации", () => {
    const r = cashInMachines(
      [
        { machineId: "m1", ts: "2026-08-01T10:00:00+05:00", amount: 10000, cash: true },
        { machineId: "m1", ts: "2026-08-10T10:00:00+05:00", amount: 15000, cash: true },
        { machineId: "m1", ts: "2026-08-11T10:00:00+05:00", amount: 9000, cash: false },
      ],
      [{ machineId: "m1", receivedAt: "2026-08-05T00:00:00+05:00" }],
    );
    assert.equal(r.total, 15000);
    assert.equal(r.perMachine[0].since, "2026-08-05T00:00:00+05:00");
  });
  it("без инкассаций — окно от первой продажи, since null", () => {
    const r = cashInMachines(
      [{ machineId: "m2", ts: "2026-08-01T10:00:00+05:00", amount: 5000, cash: true }],
      [],
    );
    assert.equal(r.total, 5000);
    assert.equal(r.perMachine[0].since, null);
  });
  it("несколько инкассаций — берётся последняя", () => {
    const r = cashInMachines(
      [
        { machineId: "m1", ts: "2026-08-07T00:00:00+05:00", amount: 3000, cash: true },
        { machineId: "m1", ts: "2026-08-10T00:00:00+05:00", amount: 7000, cash: true },
      ],
      [
        { machineId: "m1", receivedAt: "2026-08-01T00:00:00+05:00" },
        { machineId: "m1", receivedAt: "2026-08-09T00:00:00+05:00" },
      ],
    );
    assert.equal(r.total, 7000);
    assert.equal(r.perMachine[0].since, "2026-08-09T00:00:00+05:00");
  });
  it("смешанные часовые пояса: Z и +05:00, продажа раньше инкассации", () => {
    const r = cashInMachines(
      [{ machineId: "m1", ts: "2026-08-01T09:00:00+05:00", amount: 5000, cash: true }],
      [{ machineId: "m1", receivedAt: "2026-08-01T05:00:00Z" }],
    );
    assert.equal(r.total, 0);
  });
  it("граница равенства времени: продажа в момент инкассации исключена", () => {
    const r = cashInMachines(
      [{ machineId: "m1", ts: "2026-08-05T00:00:00+05:00", amount: 5000, cash: true }],
      [{ machineId: "m1", receivedAt: "2026-08-05T00:00:00+05:00" }],
    );
    assert.equal(r.total, 0);
  });
});
