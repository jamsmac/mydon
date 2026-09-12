// Волна 5: два времени операции и запись задним числом — на настоящем SQL.
// Проверяется то, чего заглушка не покажет: CHECK «день события = entered_date»,
// одобрение в существующей очереди и отмена записи ВМЕСТЕ со списанием склада.
import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { CoffeeService } = reqCore(path.join(REPO, "apps/core/dist/coffee/coffee.service.js"));
const { ApprovalsService } = reqCore(path.join(REPO, "apps/core/dist/approvals/approvals.service.js"));
const { db, run, close } = await coreDb();
const n = async (sql) => Number((await run(sql))[0].n);
try {
  const LOC = "00000000-0000-0000-0000-0000000000b1";
  await run(`insert into entity (id, type, name) values ('${LOC}','location','CardioLife')`);
  const coffee = new CoffeeService(db);
  const approvals = new ApprovalsService(db, { record: async () => {} }, { record: async () => {} });
  const now = new Date("2026-09-11T09:00:00+05:00");

  // 1. Обычная заливка «сейчас»: день события выводится из времени, одобрения не нужно
  const today = await coffee.submitRefill(
    { locationId: LOC, position: 1, filledWeight: 600, enteredDate: "2026-09-11", occurredAt: "2026-09-11 08:40", createdBy: "person:tech" },
    now,
  );
  assert.equal(today.backdated, false);
  const [row] = await run(`select entered_date::text, occurred_precision, occurred_at, recorded_at from coffee_refill where id='${today.id}'`);
  assert.equal(row.entered_date, "2026-09-11");
  assert.equal(row.occurred_precision, "minute");
  assert.equal(new Date(row.occurred_at).toISOString(), "2026-09-11T03:40:00.000Z");

  // 2. Время не названо: день известен, минута — нет
  const noTime = await coffee.submitRefill(
    { locationId: LOC, position: 2, filledWeight: 500, enteredDate: "2026-09-11", createdBy: "person:tech" },
    now,
  );
  assert.equal((await run(`select occurred_precision from coffee_refill where id='${noTime.id}'`))[0].occurred_precision, "day");

  // 3. Будущее — отказ на сервере, а не только в форме (R-H-4)
  await assert.rejects(
    coffee.submitRefill({ locationId: LOC, position: 3, filledWeight: 100, enteredDate: "2026-09-12", occurredAt: "2026-09-12 10:00" }, now),
    /будущем/,
  );

  // 4. Задним числом: считается сразу и помечается (R-H-13)
  const past = await coffee.submitRefill(
    { locationId: LOC, position: 4, filledWeight: 640, enteredDate: "2026-09-09", occurredAt: "2026-09-09 17:20", createdBy: "person:tech" },
    now,
  );
  assert.equal(past.backdated, true);
  assert.equal((await run(`select entered_date::text as d from coffee_refill where id='${past.id}'`))[0].d, "2026-09-09");
  const ap = await approvals.request({
    agent: "person:tech",
    action: "Заливка задним числом: CardioLife, бункер 4, за 2026-09-09 (640 г)",
    tier: "T1",
    payload: { backdatedRecord: { kind: "coffee_refill", rowId: past.id, occurredAt: past.occurredAt.toISOString() } },
    clientKey: `backdated:coffee_refill:${past.id}`,
  });
  await coffee.attachRefillApproval(past.id, ap.id);
  const journal = await coffee.recentRefills(10);
  const pastRow = journal.find((r) => r.id === past.id);
  assert.equal(pastRow.approvalPending, true, "пометка «ждёт одобрения» видна в журнале");
  assert.equal(journal.find((r) => r.id === today.id).approvalPending, false);
  assert.equal(await n(`select count(*)::int as n from coffee_refill where id='${past.id}'`), 1, "запись считается сразу");

  // 5. Отклонение отменяет запись ВМЕСТЕ со списанием склада
  const MOV = "00000000-0000-0000-0000-0000000000c1";
  const WH = "00000000-0000-0000-0000-0000000000d1";
  const ING = "00000000-0000-0000-0000-0000000000e1";
  await run(`insert into entity (id, type, name) values ('${WH}','warehouse','Основной склад'), ('${ING}','ingredient','Кофе')`);
  await run(`insert into stock_movement (id, kind, ingredient_id, warehouse_id, dt, qty, unit)
             values ('${MOV}','consumption','${ING}','${WH}','2026-09-09', 500, 'г')`);
  await run(`update coffee_refill set stock_movement_id='${MOV}' where id='${past.id}'`);
  await approvals.decide(ap.id, "rejected", "owner");
  assert.equal(await n(`select count(*)::int as n from coffee_refill where id='${past.id}'`), 0, "отклонённая запись отменена");
  assert.equal(await n(`select count(*)::int as n from stock_movement where id='${MOV}'`), 0, "списание ушло вместе с ней");
  const audit = await run(`select actor_ref, after->>'reason' as reason from audit_log where action='coffee.refill.delete'`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, "запись задним числом отклонена");

  // 6. Одобрение ничего не отменяет — запись остаётся, пометка уходит
  const past2 = await coffee.submitRefill(
    { locationId: LOC, position: 5, filledWeight: 610, enteredDate: "2026-09-10", occurredAt: "2026-09-10 12:00", createdBy: "person:tech" },
    now,
  );
  const ap2 = await approvals.request({
    agent: "person:tech",
    action: "Заливка задним числом: CardioLife, бункер 5",
    tier: "T1",
    payload: { backdatedRecord: { kind: "coffee_refill", rowId: past2.id, occurredAt: past2.occurredAt.toISOString() } },
    clientKey: `backdated:coffee_refill:${past2.id}`,
  });
  await coffee.attachRefillApproval(past2.id, ap2.id);
  await approvals.decide(ap2.id, "approved", "owner");
  assert.equal(await n(`select count(*)::int as n from coffee_refill where id='${past2.id}'`), 1);
  assert.equal((await coffee.recentRefills(10)).find((r) => r.id === past2.id).approvalPending, false);

  // 7. День события и entered_date не разъезжаются даже мимо сервиса (CHECK)
  await assert.rejects(
    run(`insert into coffee_refill (location_id, position, filled_weight, entered_date, occurred_at)
         values ('${LOC}', 6, 100, '2026-09-01', '2026-09-05T06:00:00Z')`),
    /entered_date_matches_occurred|check/i,
  );

  console.log(`Задним числом (${ENGINE}): два времени, отказ на будущее, одобрение, отмена со складом, CHECK ✔`);
} finally { await close(); }
