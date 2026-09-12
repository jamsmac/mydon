// Норматив мойки миксера ждёт ОПОЗНАННОГО миксера (решение владельца
// 12.09.2026) — на настоящем SQL. Проверяется то, чего заглушка не покажет:
// норматив исчезает и появляется сам по состоянию наклейки, выключается, а не
// удаляется, и повторный прогон ничего не ломает.
import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { MaintenanceService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/maintenance.service.js"));
const { db, run, close } = await coreDb();

const active = async () =>
  Number((await run(`select count(*)::int as n from maintenance_plan where kind='cleaning' and part_kind='mixer' and is_active`))[0].n);
const rows = async () =>
  Number((await run(`select count(*)::int as n from maintenance_plan where kind='cleaning' and part_kind='mixer'`))[0].n);

try {
  const M = "00000000-0000-0000-0000-00000000ba01";
  await run(`insert into entity (id, type, name, attrs) values ('${M}','machine','Кофе A','{}')`);
  await run(`insert into machine_card (entity_id, kind) values ('${M}','coffee')`);
  const maintenance = new MaintenanceService(db);

  // ── Миксер не размечен: норматив мойки не заводится вовсе ────────────────
  const first = await maintenance.applyStandardNorms([M], "owner");
  assert.equal(first.created.some((p) => p.partKind === "mixer"), false, "нет подлежащего — нет требования");
  assert.equal(first.created.some((p) => p.partKind === "water_filter"), true, "остальные нормативы заводятся как раньше");
  assert.equal(await rows(), 0);

  // ── Миксер с номером, но БЕЗ наклейки — всё ещё не опознан ──────────────
  await run(`insert into part_unit (id, part_kind, inventory_no, label_pending)
             values ('00000000-0000-0000-0000-00000000bb01','mixer','M-001',true)`);
  await run(`insert into machine_part (part_unit_id, machine_id, part_kind, location, installed_on)
             values ('00000000-0000-0000-0000-00000000bb01','${M}','mixer','machine','2026-09-01')`);
  await maintenance.reconcileAllIdentifiedNorms("owner");
  assert.equal(await active(), 0, "номер в реестре без наклейки на железе миксеры не различает");

  // ── Наклейку подтвердили — норматив появляется САМ ───────────────────────
  await run(`update part_unit set label_pending = false where id='00000000-0000-0000-0000-00000000bb01'`);
  const after = await maintenance.reconcileAllIdentifiedNorms("owner");
  assert.equal(after.created.length, 1);
  assert.equal(after.created[0].partKind, "mixer");
  assert.equal(await active(), 1);

  // ── Повтор ничего не дублирует ──────────────────────────────────────────
  const repeat = await maintenance.reconcileAllIdentifiedNorms("owner");
  assert.deepEqual([repeat.created.length, repeat.deactivated.length], [0, 0]);
  assert.equal(await rows(), 1);

  // ── Узел сняли: норматив ВЫКЛЮЧАЕТСЯ, а не удаляется ────────────────────
  await run(`update machine_part set removed_on = '2026-09-12' where part_unit_id='00000000-0000-0000-0000-00000000bb01'`);
  const off = await maintenance.reconcileAllIdentifiedNorms("owner");
  assert.equal(off.deactivated.length, 1);
  assert.equal(await active(), 0);
  assert.equal(await rows(), 1, "строка осталась — видно, что раньше следили");
  const audit = await run(`select count(*)::int as n from audit_log where action='maintenance.plan_deactivated'`);
  assert.equal(Number(audit[0].n), 1, "выключение записано в журнал");

  // ── Узел вернули — норматив включается обратно тем же вызовом ────────────
  await run(`update machine_part set removed_on = null where part_unit_id='00000000-0000-0000-0000-00000000bb01'`);
  const back = await maintenance.reconcileAllIdentifiedNorms("owner");
  assert.equal(back.reactivated.length, 1);
  assert.equal(await active(), 1);
  assert.equal(await rows(), 1, "включили существующую строку, а не завели вторую");
  assert.equal(back.deactivated.length, 0);
  assert.equal(
    (await run(`select auto_off_reason from maintenance_plan where kind='cleaning' and part_kind='mixer'`))[0].auto_off_reason,
    null,
    "причина автовыключения снята вместе с включением",
  );

  // ── Владелец выключил норматив РУКАМИ — сверка его не включает обратно ───
  const [plan] = await run(`select id from maintenance_plan where kind='cleaning' and part_kind='mixer'`);
  await maintenance.deactivatePlan(plan.id, "owner");
  const human = await maintenance.reconcileAllIdentifiedNorms("owner");
  assert.equal(human.reactivated.length, 0, "машина не переигрывает человека");
  assert.equal(await active(), 0);
  assert.equal(human.created.length, 0, "и не заводит вторую строку в обход выключения");

  console.log(`Мойка миксера (${ENGINE}): норматив ждёт наклейки, появляется и выключается сам, история цела ✔`);
} finally {
  await close();
}
