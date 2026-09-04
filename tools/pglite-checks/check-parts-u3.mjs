import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { PartsService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/parts.service.js"));
const { MaintenanceService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/maintenance.service.js"));
const { db, run, close } = await coreDb();
try {
  const A = "00000000-0000-0000-0000-00000000aa01", P = "00000000-0000-0000-0000-00000000ee01";
  await run(`insert into entity (id, type, name) values ('${A}','machine','Кофе A')`);
  await run(`insert into person (id, name, roles) values ('${P}','Рустам','{technician}')`);
  await run(`insert into machine_card (entity_id, kind) values ('${A}','coffee')`);
  const p = new PartsService(db); const m = new MaintenanceService(db);
  await p.provision({ machineIds: [A], actorRef: "owner" });
  const spare = await p.create({ partKind: "mixer", location: "warehouse", serialNumber: "SN-SPARE" });
  const installed = await p.installedOn(A);
  const slot1 = installed.find((u) => u.partKind === "mixer" && u.where.slot === 1);
  assert.ok(slot1, "в слоте 1 стоит миксер");

  // Узел на автомате не двигается мастером перемещения
  await assert.rejects(p.move(slot1.id, { to: "washing" }), /стоит на автомате/);

  // Замена по узлам: снятый — на мойку, запасной со склада — в слот 1
  const swap = await m.swapPart({ machineId: A, partKind: "mixer", slot: 1, partUnitId: spare.id, removedTo: "washing", personId: P, reason: "preventive", note: "плановая мойка" });
  assert.equal(swap.removed.partUnitId, slot1.id);
  assert.equal(swap.installed.partUnitId, spare.id);
  assert.equal(swap.stored.location, "washing");
  const onWash = await p.atLocation("washing");
  assert.deepEqual(onWash.map((u) => u.id), [slot1.id], "на мойке ровно снятый узел");
  assert.equal((await p.spares("mixer")).length, 0, "запасной ушёл со склада");

  // «Помыл»: мойка → сушка (PARTS_DRYING_STAGE по умолчанию 1), повтор по clientKey не плодит движений
  assert.equal(await p.afterWashLocation(), "drying");
  const w1 = await p.move(slot1.id, { to: "drying", personId: P, clientKey: "wash-1" });
  assert.equal(w1.from, "washing"); assert.ok(w1.logId, "запись журнала есть — на автомат A");
  const w2 = await p.move(slot1.id, { to: "drying", personId: P, clientKey: "wash-1" });
  assert.equal(w2.logId, w1.logId, "повтор вернул ту же запись");
  const periods = await run(`select location, removed_on from machine_part where part_unit_id = $1 order by installed_on, created_at`, [slot1.id]);
  assert.equal(periods.filter((r) => r.removed_on === null).length, 1, "ровно один открытый период");
  assert.equal(periods.at(-1).location, "drying");
  await assert.rejects(p.move(slot1.id, { to: "drying" }), /и так/);
  const logs = await p.logs(slot1.id);
  assert.ok(logs.some((l) => l.kind === "cleaning" && l.entityId === A && l.partUnitId === slot1.id), "мойка записана в журнал автомата A с узлом");

  // Сушка → склад: узел снова среди запасных
  await p.move(slot1.id, { to: "warehouse", personId: P });
  assert.deepEqual((await p.spares("mixer")).map((u) => u.id), [slot1.id]);
  assert.deepEqual(await p.atLocation("drying"), []);
  // Склад → ремонт → склад
  await p.move(slot1.id, { to: "repair", note: "течёт сальник" });
  assert.equal((await p.get(slot1.id)).where.location, "repair");
  await p.move(slot1.id, { to: "warehouse" });
  // Списанный не двигается
  await p.retire(slot1.id, "сломан");
  await assert.rejects(p.move(slot1.id, { to: "repair" }), /списан/);

  // Настройка PARTS_DRYING_STAGE=0 → после мойки сразу склад
  await run(`insert into system_config (key, value) values ('PARTS_DRYING_STAGE','0')`);
  assert.equal(await p.afterWashLocation(), "warehouse");
  console.log("У3 на pglite: замена по узлам, мойка→сушка→склад, ремонт, повтор по clientKey ✔ журнал:", logs.length);
} finally { await close(); }
