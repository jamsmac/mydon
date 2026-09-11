// Волна 3: инвентарный номер автомата — план, присвоение, правка, наклейка, уникальность.
// Уникальность держит индекс по ВЫРАЖЕНИЮ (upper + без пробелов) — заглушка его не проверит.
import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { EntitiesService } = reqCore(path.join(REPO, "apps/core/dist/entities/entities.service.js"));
const { db, run, close } = await coreDb();
try {
  const id = (n) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
  // три кофейных (двое заведены одновременно — порядок по серийнику), снек, «прочее»
  await run(`insert into entity (id, type, name, external_ref, created_at) values
    ('${id(1)}','machine','KARDIO Life','2508160002','2026-07-01T05:00:00Z'),
    ('${id(2)}','machine','Olma','2508160001','2026-07-01T05:00:00Z'),
    ('${id(3)}','machine','American hospital','2508160009','2026-06-01T05:00:00Z'),
    ('${id(4)}','machine','SKLAD 6S','c2508160376','2026-08-01T05:00:00Z'),
    ('${id(5)}','machine','Весы','x1','2026-08-01T05:00:00Z')`);
  await run(`insert into machine_card (entity_id, kind) values
    ('${id(1)}','coffee'),('${id(2)}','coffee'),('${id(3)}','coffee'),('${id(4)}','snack'),('${id(5)}','other')`);
  const svc = new EntitiesService(db, { record: async () => {} });

  // 1. план: по дате заведения, при совпадении — по серийнику; «прочее» без номера
  const plan = await svc.machineNumberPlan();
  assert.deepEqual(plan.map((p) => [p.name, p.inventoryNo]), [
    ["American hospital", "K-001"],
    ["Olma", "K-002"],
    ["KARDIO Life", "K-003"],
    ["SKLAD 6S", "S-001"],
  ]);

  // 2. присвоение: номер сразу, наклейка ждёт; журнал — по записи на автомат
  const res = await svc.applyMachineNumberPlan("agent:claude-code");
  assert.equal(res.assigned.length, 4);
  const pending = await run(`select count(*)::int as n from machine_card where label_pending`);
  assert.equal(pending[0].n, 4);
  const audit = await run(`select count(*)::int as n from audit_log where action='machine.number_assigned' and actor_ref='agent:claude-code'`);
  assert.equal(audit[0].n, 4);
  // повторный прогон ничего не задваивает
  assert.equal((await svc.applyMachineNumberPlan("agent:claude-code")).assigned.length, 0);

  // 3. подтверждение наклейки
  const confirmed = await svc.setMachineNumber(id(3), { confirmLabel: true }, "person:tech");
  assert.equal(confirmed.labelPending, false);

  // 4. правка на свой номер: нормализуется; чужая серия и кириллица — отказ; занятый — отказ с именем
  const fixed = await svc.setMachineNumber(id(1), { inventoryNo: " k-014 " }, "owner");
  assert.equal(fixed.inventoryNo, "K-014"); assert.equal(fixed.labelPending, false);
  await assert.rejects(svc.setMachineNumber(id(2), { inventoryNo: "S-002" }), /серии K/);
  await assert.rejects(svc.setMachineNumber(id(2), { inventoryNo: "К-777" }), /кириллические/);
  // «K-14» — тот же номер, что «K-014»: хранится в одной форме и упирается в занятый
  await assert.rejects(svc.setMachineNumber(id(2), { inventoryNo: "K-14" }), /Номер K-014 уже у автомата «KARDIO Life»/);
  await assert.rejects(svc.setMachineNumber(id(2), { inventoryNo: "k-014" }), /уже у автомата «KARDIO Life»/);

  // 5. уникальный индекс держит и мимо сервиса: «K-014» второй раз не ляжет
  await assert.rejects(run(`update machine_card set inventory_no='K-014' where entity_id='${id(2)}'`), /machine_card_inventory_no_key|duplicate|unique/i);
  // и форма номера — в базе: «K-14» мимо сервиса тоже не ляжет
  await assert.rejects(run(`update machine_card set inventory_no='K-15' where entity_id='${id(2)}'`), /machine_card_inventory_no_canonical|check/i);

  // 6. следующий по плану продолжает после занятых, дыры не переиспользуются
  await run(`insert into entity (id, type, name, external_ref, created_at) values ('${id(6)}','machine','Новый','n1','2026-09-10T05:00:00Z')`);
  await run(`insert into machine_card (entity_id, kind) values ('${id(6)}','coffee')`);
  const next = await svc.machineNumberPlan();
  assert.deepEqual(next.map((p) => p.inventoryNo), ["K-015"]);

  console.log(`Номер автомата (${ENGINE}): план по дате и серийнику, присвоение с наклейкой, правка, отказы, индекс ✔`);
} finally { await close(); }
