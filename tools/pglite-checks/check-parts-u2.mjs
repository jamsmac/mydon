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

// (дополнение 2) два автомата, у которых последняя заливка называет ОДИН набор:
// предпросмотр и боевой прогон обязаны дать одни и те же номера, без дубля наклейки.
{
  const { db, run, close } = await coreDb();
  try {
    const A = "00000000-0000-0000-0000-0000000000a1", B = "00000000-0000-0000-0000-0000000000b1";
    const LA = "00000000-0000-0000-0000-0000000000a2", LB = "00000000-0000-0000-0000-0000000000b2";
    await run(`insert into entity (id, type, name) values ('${A}','machine','Кофе A'), ('${B}','machine','Кофе B'), ('${LA}','location','Точка A'), ('${LB}','location','Точка B')`);
    await run(`insert into machine_card (entity_id, kind) values ('${A}','coffee'), ('${B}','coffee')`);
    await run(`insert into machine_placement (entity_id, location_id, start_date) values ('${A}','${LA}','2026-01-01'), ('${B}','${LB}','2026-02-01')`);
    await run(`insert into coffee_ingredient (name) values ('Кофе зерновой')`);
    const [ing] = await run(`select id from coffee_ingredient limit 1`);
    // набор 27 стоял на точке A, уехал на мойку и вернулся на точку B — последняя заливка ОБЕИХ точек называет 27
    await run(`insert into coffee_refill (location_id, position, container_number, ingredient_id, filled_weight, entered_date) values
      ('${LA}',1,27,'${ing.id}',800,'2026-08-01'), ('${LA}',2,27,'${ing.id}',800,'2026-08-01'),
      ('${LB}',1,27,'${ing.id}',800,'2026-08-20'), ('${LB}',2,27,'${ing.id}',800,'2026-08-20')`);
    const p2 = new PartsService(db);
    const nos = (arr) => arr.map((x) => (x.match(/[A-ZА-Я]?-?\b([MGBFH]-\d+(?:-\d+)?)/) ?? [null, "—"])[1]);
    const dry = await p2.provision({ dryRun: true });
    const dryA = nos(dry.machines[0].created), dryB = nos(dry.machines[1].created);
    assert.deepEqual(dryA.filter((n) => n.startsWith("H-27-")).sort(), ["H-27-1", "H-27-2"], "первому автомату — набор с последней заливки");
    assert.equal(dryB.filter((n) => n.startsWith("H-27-")).length, 0, "второй автомат тот же набор в ПРЕДПРОСМОТРЕ не берёт");
    assert.equal(new Set([...dryA, ...dryB]).size, dryA.length + dryB.length, "в предпросмотре нет двух узлов с одним номером");
    const real = await p2.provision({});
    assert.deepEqual(nos(real.machines[0].created), dryA, "боевой прогон повторяет предпросмотр (автомат A)");
    assert.deepEqual(nos(real.machines[1].created), dryB, "боевой прогон повторяет предпросмотр (автомат B)");
    const dup = await run(`select count(*) c from (select upper(regexp_replace(inventory_no, '\s', '', 'g')) n from part_unit group by 1 having count(*) > 1) x`);
    assert.equal(Number(dup[0].c), 0, "дублей номеров в базе нет");
    console.log("У2: общий набор у двух автоматов — предпросмотр = боевой прогон ✔", dryA[0], dryB[0]);
  } finally { await close(); }
}

// (дополнение 3) НУМЕРАЦИЯ СТОЯЩИХ УЗЛОВ (узлы бэкфилла 0084): полный автомат,
// заводить нечего — но 15 узлов без номера обязаны получить номер и очередь.
// Плюс две заставы: номер серии, занятый узлом ДРУГОГО вида, и номер набора,
// занятый СПИСАННЫМ бункером.
{
  const { db, run, close } = await coreDb();
  try {
    const M = "00000000-0000-0000-0000-0000000000c1";
    await run(`insert into entity (id, type, name) values ('${M}','machine','Кофе полный')`);
    await run(`insert into machine_card (entity_id, kind) values ('${M}','coffee')`);
    // номер M-002 вписан руками на карточку ФИЛЬТРА: уникальность номера в базе
    // глобальная, поэтому серия миксеров обязана его перешагнуть
    await run(`insert into part_unit (part_kind, inventory_no, label_pending) values ('water_filter','M-002',false)`);
    const slots = [["mixer",1],["mixer",2],["mixer",3],["mixer",4],["grinder",null],["brewer",null],
      ["hopper",1],["hopper",2],["hopper",3],["hopper",4],["hopper",5],["hopper",6],["hopper",7],["hopper",8],["water_filter",null]];
    for (const [kind, slot] of slots) {
      const [u] = await run(`insert into part_unit (part_kind, origin, label_pending, note)
        values ('${kind}','backfill',false,'из журнала') returning id`);
      await run(`insert into machine_part (part_unit_id, machine_id, location, part_kind, slot, installed_on)
        values ('${u.id}','${M}','machine','${kind}',${slot === null ? "null" : slot},'2026-05-01')`);
    }
    const p3 = new PartsService(db);
    const dry = await p3.provision({ dryRun: true });
    assert.equal(dry.createdTotal, 0, "состав полный — заводить нечего");
    assert.equal(dry.numberedTotal, 15, "но все 15 стоящих узлов ждут номер");
    assert.equal((await run(`select count(*) c from part_unit where inventory_no is null`))[0].c, 15, "предпросмотр не пишет");
    const real = await p3.provision({ actorRef: "owner" });
    assert.equal(real.createdTotal, 0);
    assert.deepEqual(real.machines[0].numbered, dry.machines[0].numbered, "боевой прогон повторяет предпросмотр");
    const mix = (await run(`select inventory_no from part_unit where part_kind='mixer' order by inventory_no`)).map((r) => r.inventory_no);
    assert.deepEqual(mix, ["M-003","M-004","M-005","M-006"], "серия миксеров перешагнула чужой M-002");
    const hop = (await run(`select inventory_no from part_unit where part_kind='hopper' and origin='backfill' order by inventory_no`)).map((r) => r.inventory_no);
    assert.deepEqual(hop, ["H-001","H-002","H-003","H-004","H-005","H-006","H-007","H-008"], "бункеры без набора — серия-счётчик подряд");
    const pend = (await run(`select count(*) c from part_unit where label_pending and inventory_no is not null`))[0];
    assert.equal(Number(pend.c), 15, "все пронумерованные встали в очередь наклеек");
    const audit = (await run(`select count(*) c from audit_log where action='parts.number_assigned'`))[0];
    assert.equal(Number(audit.c), 15, "аудит — на каждый номер, внутри транзакции автомата");
    const prov = (await run(`select after::text t from audit_log where action='parts.provisioned'`))[0];
    assert.match(prov.t, /"numberedTotal":\s*15/, "сводная запись называет присвоенные номера");
    const again = await p3.provision({});
    assert.equal(again.numberedTotal, 0, "второй прогон номера не переписывает");
    assert.equal((await run(`select count(*) c from audit_log where action='parts.number_assigned'`))[0].c, 15, "и не плодит аудит");
    console.log("У2: нумерация стоящих узлов бэкфилла ✔ 15 номеров, чужой номер серии обойдён");
  } finally { await close(); }
}

// (дополнение 4) набор, который держит СПИСАННЫЙ бункер: уникальность
// (set_number, hopper_position) списанные не исключает — прогон обязан завести
// бункер по серии-счётчику, а не упасть на индексе посреди парка.
{
  const { db, run, close } = await coreDb();
  try {
    const M = "00000000-0000-0000-0000-0000000000d1", LOC = "00000000-0000-0000-0000-0000000000d2";
    await run(`insert into entity (id, type, name) values ('${M}','machine','Кофе со списанным набором'), ('${LOC}','location','Точка D')`);
    await run(`insert into machine_card (entity_id, kind) values ('${M}','coffee')`);
    await run(`insert into machine_placement (entity_id, location_id, start_date) values ('${M}','${LOC}','2026-01-01')`);
    await run(`insert into coffee_ingredient (name) values ('Кофе зерновой')`);
    const [ing] = await run(`select id from coffee_ingredient limit 1`);
    await run(`insert into coffee_refill (location_id, position, container_number, ingredient_id, filled_weight, entered_date) values ('${LOC}',1,9,'${ing.id}',800,'2026-08-01')`);
    await run(`insert into part_unit (part_kind, inventory_no, set_number, hopper_position, retired_at, retired_reason) values ('hopper','H-9-1',9,1,'2026-03-01','треснул')`);
    const p4 = new PartsService(db);
    const dry = await p4.provision({ dryRun: true });
    assert.equal(dry.createdTotal, 15);
    const real = await p4.provision({});
    assert.equal(real.createdTotal, 15, "прогон не падает на списанном наборе");
    const h = (await run(`select inventory_no, set_number, note from part_unit where part_kind='hopper' and retired_at is null and hopper_position is null and inventory_no like 'H-0%' order by inventory_no`));
    assert.equal(h.length, 8, "все восемь бункеров заведены");
    assert.match(h[0].note, /бункер набора 9 списан/, "примечание объясняет, почему набор не присвоен");
    assert.equal((await run(`select count(*) c from part_unit where set_number=9 and hopper_position=1`))[0].c, 1, "второй бункер набора 9·1 не заведён");
    console.log("У2: набор у списанного бункера — счётчик вместо падения ✔", h[0].inventory_no);
  } finally { await close(); }
}
