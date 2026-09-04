import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { PartsService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/parts.service.js"));
const { PartCountService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/part-count.service.js"));
const { MaintenanceService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/maintenance.service.js"));
const { db, run, close } = await coreDb();
try {
  const A = "00000000-0000-0000-0000-00000000aa01", P = "00000000-0000-0000-0000-00000000ee01";
  await run(`insert into entity (id, type, name) values ('${A}','machine','Кофе A')`);
  await run(`insert into person (id, name, roles) values ('${P}','Рустам','{technician}')`);
  await run(`insert into machine_card (entity_id, kind) values ('${A}','coffee')`);
  const p = new PartsService(db), c = new PartCountService(db, p), m = new MaintenanceService(db);
  await p.provision({ machineIds: [A], actorRef: "owner" });
  const ma = await p.create({ partKind: "mixer", location: "warehouse" });
  const mb = await p.create({ partKind: "mixer", location: "warehouse", serialNumber: "SN-B" });
  const mc = await p.create({ partKind: "mixer", location: "warehouse" });
  const hw = await p.create({ partKind: "hopper", location: "warehouse", setNumber: 27, hopperPosition: 5 });
  const gw = await p.create({ partKind: "grinder", location: "washing" });
  const slot1 = (await p.installedOn(A)).find((u) => u.partKind === "mixer" && u.where.slot === 1);

  const s1 = await c.start({ location: "warehouse", personId: P, actorRef: `person:${P}` });
  assert.equal(s1.resumed, false); assert.equal(s1.expected, 4); assert.equal(s1.photoRequired, true);
  const s2 = await c.start({ location: "warehouse" });
  assert.equal(s2.resumed, true); assert.equal(s2.session.id, s1.session.id, "вторая сессия того же места не плодится");
  const sid = s1.session.id;

  // найден по номеру; повтор — конфликт; по серийнику; новый; чужого места; с автомата
  const l1 = await c.addLine(sid, { partKind: "mixer", inventoryNo: ma.inventoryNo.toLowerCase(), clientKey: "k1" });
  assert.equal(l1.status, "found"); assert.equal(l1.how, "number"); assert.equal(l1.line.partUnitId, ma.id);
  const replay = await c.addLine(sid, { partKind: "mixer", inventoryNo: ma.inventoryNo, clientKey: "k1" });
  assert.equal(replay.line.id, l1.line.id, "повтор по clientKey — та же строка");
  await assert.rejects(c.addLine(sid, { partKind: "mixer", inventoryNo: ma.inventoryNo }), /уже посчитан/);
  await assert.rejects(c.addLine(sid, { partKind: "grinder", inventoryNo: mb.inventoryNo }), /это миксер, не кофемолка/);
  const l2 = await c.addLine(sid, { partKind: "mixer", serialNumber: "sn-b" });
  assert.equal(l2.how, "serial"); assert.equal(l2.line.partUnitId, mb.id);
  const l3 = await c.addLine(sid, { partKind: "mixer", inventoryNo: "M-099", serialNumber: "SN-NEW", photoSkippedReason: "телефон сел" });
  assert.equal(l3.status, "new"); assert.equal(l3.line.partUnitId, null);
  const l4 = await c.addLine(sid, { partKind: "grinder", inventoryNo: gw.inventoryNo });
  assert.equal(l4.line.registeredAt, "washing", "числился на мойке — панель предупредит");
  const l5 = await c.addLine(sid, { partKind: "mixer", inventoryNo: slot1.inventoryNo });
  assert.match(l5.line.registeredAt, /Кофе A · слот 1/);
  await assert.rejects(c.addLine(sid, { partKind: "mixer", inventoryNo: "M 0 99?" }), /латиница/);

  // фото к строке нового узла (владелец part_count_line) — после применения уедет на карточку
  await run(`insert into attachment (owner_type, owner_id, kind, storage_key) values ('part_count_line', $1, 'photo', 'x/1.jpg')`, [l3.line.id]);
  const before = await c.summary(sid);
  assert.equal(before.found, 2); assert.equal(before.fresh, 1); assert.equal(before.moved, 2);
  assert.deepEqual(before.missing.map((u) => u.id).sort(), [mc.id, hw.id].sort());
  assert.equal(before.lines.find((l) => l.id === l3.line.id).photoCount, 1);
  // убрать строку и вернуть
  const tmp = await c.addLine(sid, { partKind: "brewer", inventoryNo: "B-777" });
  await c.removeLine(tmp.line.id);
  assert.equal((await c.summary(sid)).lines.length, 5);
  const fin = await c.finish(sid);
  assert.ok(fin.session.finishedAt, "закончена");
  await c.addLine(sid, { partKind: "brewer", inventoryNo: "B-778" });
  assert.equal((await c.summary(sid)).session.finishedAt, null, "досчитал — сессия снова открыта");

  const rep = await c.apply(sid, { actorRef: "owner" });
  assert.equal(rep.found, 4); assert.deepEqual(rep.created, ["Миксер M-099", "Варочная группа B-778"]);
  assert.equal(rep.moved.length, 2); assert.equal(rep.missing.length, 2);
  await assert.rejects(c.apply(sid), /уже применена/);
  await assert.rejects(c.removeLine(l1.line.id), /применена/);
  const after = await c.summary(sid);
  assert.equal(after.found, 4); assert.equal(after.fresh, 2); assert.equal(after.moved, 2); assert.equal(after.missing.length, 2);
  assert.equal((await p.get(mc.id)).where.location, "unknown");
  assert.equal((await p.get(hw.id)).where.location, "unknown");
  assert.equal((await p.get(gw.id)).where.location, "warehouse");
  assert.equal((await p.get(slot1.id)).where.location, "warehouse");
  assert.ok(!(await p.installedOn(A)).some((u) => u.where.slot === 1 && u.partKind === "mixer"), "слот 1 автомата пуст");
  const created = await p.findByInventoryNo("M-099");
  assert.equal(created.labelPending, false, "номер с наклейки — наклейка есть"); assert.equal(created.origin, "count"); assert.equal(created.serialNumber, "SN-NEW");
  assert.equal((await p.get(created.id)).photoCount, 1, "фото строки стало фото узла");
  const open = await run(`select count(*)::int as n from machine_part where removed_on is null and part_unit_id = $1`, [created.id]);
  assert.equal(open[0].n, 1);
  const logs = await p.logs(slot1.id);
  assert.ok(logs.some((l) => l.kind === "other" && /снят по инвентаризации/.test(l.note)), "снятие с автомата записано в журнал");
  assert.equal((await run(`select count(*)::int as n from part_count_line where session_id = $1 and result = 'missing'`, [sid]))[0].n, 2);

  // откат: слот 1 занят другим миксером → пропуск с причиной; остальное вернулось
  await m.installPart({ machineId: A, partKind: "mixer", slot: 1, serialNumber: "SN-X" });
  const rv = await c.reverse(sid, "owner");
  assert.ok(rv.session.reversesId === sid && rv.session.appliedAt);
  assert.equal(rv.restored.length, 3, "M-c, бункер, гриндер вернулись");
  assert.equal(rv.skipped.length, 1); assert.match(rv.skipped[0], /место на автомате занято/);
  assert.equal((await p.get(mc.id)).where.location, "warehouse");
  assert.equal((await p.get(gw.id)).where.location, "washing");
  assert.equal((await p.get(slot1.id)).where.location, "warehouse", "не восстановлен — остался на складе");
  await assert.rejects(c.reverse(sid), /уже откачена/);
  const list = await c.list();
  assert.equal(list.length, 2); assert.equal(list.find((s) => s.id === sid).lines, 8); assert.equal(list.find((s) => s.id === sid).personName, "Рустам");

  await run(`insert into system_config (key, value) values ('PARTS_COUNT_PHOTO_REQUIRED','0')`);
  assert.equal(await c.photoRequired(), false);
  await assert.rejects(c.start({ location: "machine" }), /Считать можно/);
  console.log(`У4 (${ENGINE}): сессия → строки → применение (найдено/новые/перемещены/не найдены) → откат ✔`);
} finally { await close(); }
