import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { MaintenanceService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/maintenance.service.js"));
const { PartsService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/parts.service.js"));
const { client, db, run, close } = await coreDb();
try {
  const A = "00000000-0000-0000-0000-00000000aa01", B = "00000000-0000-0000-0000-00000000bb01";
  await run(`insert into entity (id, type, name) values ('${A}','machine','Автомат A'), ('${B}','machine','Автомат B')`);
  const m = new MaintenanceService(db); const p = new PartsService(db);

  // 1. установка нового миксера: карточка заводится, номер M-001, наклейка ожидает
  const inst = await m.installPart({ machineId: A, partKind: "mixer", slot: 1, serialNumber: "SN-1", createdBy: "staff:1" });
  const u1 = await p.get(inst.installed.partUnitId);
  assert.equal(u1.inventoryNo, "M-001"); assert.equal(u1.labelPending, true); assert.equal(u1.serialNumber, "SN-1");
  assert.equal(u1.where.machineName, "Автомат A"); assert.deepEqual(u1.attention, ["label_pending", "no_photo"]);

  // 2. замена: снятый → мойка (период открыт), новый → M-002
  const sw = await m.swapPart({ machineId: A, partKind: "mixer", slot: 1, removedTo: "washing", newSerial: "SN-2", reason: "preventive" });
  assert.equal(sw.stored.location, "washing"); assert.equal(sw.stored.partUnitId, u1.id);
  const u2 = await p.get(sw.installed.partUnitId); assert.equal(u2.inventoryNo, "M-002");
  const u1b = await p.get(u1.id); assert.equal(u1b.where.location, "washing");

  // 3. подтверждение наклейки и исправление номера на свой; конфликт занятого номера
  const c = await p.assignNumber(u1.id, { confirmLabel: true, actorRef: "staff:1" }); assert.equal(c.labelPending, false);
  const fixed = await p.assignNumber(u2.id, { inventoryNo: " m-77 " }); assert.equal(fixed.inventoryNo, "M-77"); assert.equal(fixed.labelPending, false);
  await assert.rejects(p.assignNumber(u1.id, { inventoryNo: "M-77" }), /уже у узла/);
  // следующий свободный после M-77 — M-078
  assert.equal(await p.suggestNumber("mixer"), "M-078");

  // 4. снять u2 на склад, поставить со склада по карточке на B
  const rm = await m.removePart({ machineId: A, partKind: "mixer", slot: 1, toLocation: "warehouse" });
  assert.equal(rm.stored.partUnitId, u2.id);
  const spares = await p.spares("mixer"); assert.deepEqual(spares.map(s => s.inventoryNo), ["M-77"]);
  const inst2 = await m.installPart({ machineId: B, partKind: "mixer", slot: 3, partUnitId: u2.id });
  assert.equal(inst2.installed.partUnitId, u2.id);
  const hist = await p.history(u2.id); assert.equal(hist.length, 3); assert.equal(hist[0].machineName, "Автомат B");
  assert.equal((await p.spares("mixer")).length, 0);
  // второй открытый период у того же узла невозможен
  await assert.rejects(m.installPart({ machineId: A, partKind: "mixer", slot: 2, partUnitId: u2.id }), /стоит на другом автомате/);

  // 5. бункер с набором: номер по набору; тара; очередь
  const h = await p.create({ partKind: "hopper", setNumber: 27, hopperPosition: 3, location: "warehouse" });
  assert.equal(h.inventoryNo, "H-27-3"); assert.ok(h.attention.includes("no_tare"));
  await assert.rejects(p.create({ partKind: "hopper", setNumber: 27, hopperPosition: 3 }), /уже у узла/);
  const q = await p.queue(); assert.equal(q.counts.no_tare, 1); assert.ok(q.items.length >= 2);

  // 6. списание: на автомате — отказ; на складе — ок, период закрыт
  await assert.rejects(p.retire(u2.id, "сломан"), /стоит на автомате/);
  const r = await p.retire(h.id, "трещина"); assert.ok(r.retiredAt); assert.equal(r.where, null); assert.deepEqual(r.attention, []);

  // 7. реестр и фильтры
  const all = await p.list({}); assert.equal(all.length, 2, "списанный скрыт");
  assert.equal((await p.list({ machineId: B })).length, 1);
  assert.equal((await p.list({ location: "washing" })).length, 1);
  console.log(`У1 (${ENGINE}): сервисы узлов работают на настоящем SQL ✔`, all.map(u => `${u.label} · ${u.where?.location ?? "—"}`).join(" | "));
} finally { await close(); }
