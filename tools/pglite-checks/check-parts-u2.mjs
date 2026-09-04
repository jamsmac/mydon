import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { PartsService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/parts.service.js"));
const { MaintenanceService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/maintenance.service.js"));
const { client, db, run, close } = await coreDb();
try {
  const A = "00000000-0000-0000-0000-00000000aa01", B = "00000000-0000-0000-0000-00000000bb01", S = "00000000-0000-0000-0000-00000000cc01", LOC = "00000000-0000-0000-0000-00000000dd01";
  await run(`insert into entity (id, type, name) values ('${A}','machine','Кофе A'), ('${B}','machine','Кофе B'), ('${S}','machine','Снек S'), ('${LOC}','location','Точка A')`);
  await run(`insert into machine_card (entity_id, kind) values ('${A}','coffee'), ('${B}','coffee'), ('${S}','snack')`);
  // A стоит на точке; последние заливки точки говорят: позиции 1,2 — набор 27, позиция 3 — набор 5
  await run(`insert into machine_placement (entity_id, location_id, start_date) values ('${A}','${LOC}','2026-01-01')`);
  await run(`insert into coffee_ingredient (name) values ('Кофе зерновой')`);
  const [ing] = await run(`select id from coffee_ingredient limit 1`);
  await run(`insert into coffee_refill (location_id, position, container_number, ingredient_id, filled_weight, entered_date) values
    ('${LOC}',1,27,'${ing.id}',800,'2026-08-01'), ('${LOC}',1,19,'${ing.id}',800,'2026-07-01'), ('${LOC}',2,27,'${ing.id}',700,'2026-08-02'), ('${LOC}',3,5,'${ing.id}',600,'2026-08-03')`);
  await run(`insert into coffee_container_tare (container_number, position, tare_weight) values (27,1,410), (27,2,415)`);
  const p = new PartsService(db); const m = new MaintenanceService(db);
  // на B уже стоит миксер в слоте 2 (заведён руками) — его не дублируем
  await m.installPart({ machineId: B, partKind: "mixer", slot: 2 });
  // …и миксер в слоте 1 из бэкфилла 0084: без номера, не в очереди — система обязана присвоить номер
  const BF = "00000000-0000-0000-0000-00000000ee01";
  await run(`insert into part_unit (id, part_kind, origin, label_pending, note) values ('${BF}','mixer','backfill',false,'из журнала')`);
  await run(`insert into machine_part (part_unit_id, machine_id, location, part_kind, slot, installed_on) values ('${BF}','${B}','machine','mixer',1,'2026-05-01')`);

  const dry = await p.provision({ dryRun: true });
  assert.equal(dry.machines.length, 2, "только кофейные автоматы");
  assert.equal(dry.createdTotal, 15 + 13);
  assert.ok(dry.machines[0].created.some(c => c.includes("набор 27")), "план видит набор по последней заливке");
  assert.equal(dry.numberedTotal, 1);
  // ручной миксер B занял M-001; автомат A (первый по имени) заводит 4 миксера M-002…M-005; бэкфиллу на B — M-006
  assert.deepEqual(dry.machines[1].numbered, ["Миксер №1 → M-006"], "номер считается по всему прогону; dry-run ничего не пишет");
  assert.ok(dry.machines[0].created.some(c => c.includes("Миксер №1 → M-002")), "предпросмотр показывает будущие номера заводимых узлов");
  assert.equal((await run(`select inventory_no, label_pending from part_unit where id='${BF}'`))[0].inventory_no, null);

  const r1 = await p.provision({ actorRef: "owner" });
  assert.equal(r1.createdTotal, 28);
  assert.equal(r1.numberedTotal, 1);
  assert.deepEqual(r1.machines[1].numbered, ["Миксер №1 → M-006"], "боевой прогон выдаёт тот же номер, что и предпросмотр");
  const bf = (await run(`select inventory_no, label_pending from part_unit where id='${BF}'`))[0];
  assert.equal(bf.inventory_no, "M-006"); assert.equal(bf.label_pending, true, "узел из бэкфилла встал в очередь наклеек");
  const mixNos = (await run(`select inventory_no from part_unit where part_kind='mixer' order by inventory_no`)).map(r => r.inventory_no);
  assert.deepEqual(mixNos, ["M-001","M-002","M-003","M-004","M-005","M-006","M-007","M-008"], "номера миксеров идут подряд без дыр и дублей");
  const hoppersA = await p.list({ kind: "hopper", machineId: A });
  const byPos = new Map(hoppersA.map(h => [h.where.slot, h]));
  assert.equal(byPos.get(1).inventoryNo, "H-27-1"); assert.equal(byPos.get(1).tareWeight, 410); assert.equal(byPos.get(1).setNumber, 27);
  assert.equal(byPos.get(3).inventoryNo, "H-5-3"); assert.equal(byPos.get(3).tareWeight, null);
  assert.equal(byPos.get(4).setNumber, null); assert.match(byPos.get(4).inventoryNo, /^H-\d{3}$/, "без набора — счётчик");
  const mixersB = await p.list({ kind: "mixer", machineId: B });
  assert.deepEqual(mixersB.map(x => x.where.slot).sort(), [1,2,3,4]);
  assert.equal(mixersB.filter(x => x.origin === "auto").length, 2);
  const q = await p.queue(); assert.equal(q.counts.label_pending, 28 + 1 + 1, "все автозаведённые, ручной миксер и пронумерованный бэкфилл ждут наклейку");

  const r2 = await p.provision({});
  assert.equal(r2.createdTotal, 0, "идемпотентно");
  assert.equal(r2.numberedTotal, 0, "номер второй раз не выдаётся");
  // повторное автозаведение после снятия бункера: свободный бункер набора ставится обратно, не дубль
  await m.removePart({ machineId: A, partKind: "hopper", slot: 1, toLocation: "washing" });
  const r3 = await p.provision({ machineIds: [A] });
  assert.deepEqual(r3.machines[0].created, ["Бункер H-27-1"], "свободный бункер набора — тот же узел");
  assert.equal((await p.list({ kind: "hopper" })).length, 16, "дубля нет");
  console.log("У2 на pglite: автозаведение по составу работает ✔ создано", r1.createdTotal, "| очередь наклеить:", q.counts.label_pending);
} finally { await close(); }
// (дополнение) переименование бункера-счётчика при назначении набора, пока наклейки нет
{
  const { client, db, run, close } = await coreDb();
  try {
    const p = new PartsService(db);
    const h = await p.create({ partKind: "hopper", location: "warehouse" });
    assert.match(h.inventoryNo, /^H-\d{3}$/);
    const renamed = await p.update(h.id, { setNumber: 12, hopperPosition: 4 });
    assert.equal(renamed.inventoryNo, "H-12-4", "счётчик → набор-позиция, пока наклейка не подтверждена");
    await p.assignNumber(h.id, { confirmLabel: true });
    const kept = await p.update(h.id, { setNumber: 13, hopperPosition: 4 });
    assert.equal(kept.inventoryNo, "H-12-4", "после подтверждения наклейки номер не меняется");
    console.log("У2: переименование бункера по набору ✔");
  } finally { await close(); }
}
