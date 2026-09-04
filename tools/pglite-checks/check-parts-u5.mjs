import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { PartsService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/parts.service.js"));
const { StockService } = reqCore(path.join(REPO, "apps/core/dist/stock/stock.service.js"));
const { CoffeeService } = reqCore(path.join(REPO, "apps/core/dist/coffee/coffee.service.js"));
const { CoffeeLedgerService } = reqCore(path.join(REPO, "apps/core/dist/coffee/coffee-ledger.service.js"));
const { db, run, close } = await coreDb();
try {
  const A = "00000000-0000-0000-0000-00000000aa01", LOC = "00000000-0000-0000-0000-00000000dd01", W = "00000000-0000-0000-0000-00000000ff01", CARD = "00000000-0000-0000-0000-00000000cc01";
  await run(`insert into entity (id, type, name, attrs) values ('${A}','machine','Кофе A','{}'), ('${LOC}','location','Точка A','{}'), ('${W}','warehouse','Склад','{}'), ('${CARD}','ingredient','Кофе зерновой','{"единица":"г"}')`);
  await run(`insert into machine_card (entity_id, kind) values ('${A}','coffee')`);
  await run(`insert into machine_placement (entity_id, location_id, start_date) values ('${A}','${LOC}','2026-01-01')`);
  await run(`insert into coffee_ingredient (name, entity_id, package_weight) values ('Кофе зерновой', '${CARD}', 1000)`);
  await run(`insert into coffee_ingredient (name) values ('Молоко сухое')`);
  const [ing] = await run(`select id from coffee_ingredient where name = 'Кофе зерновой'`);
  const [milk] = await run(`select id from coffee_ingredient where name = 'Молоко сухое'`);
  await run(`insert into coffee_refill (location_id, position, container_number, ingredient_id, filled_weight, measured_before, entered_date) values ('${LOC}',1,27,'${ing.id}',800,300,'2026-08-01'), ('${LOC}',3,5,'${milk.id}',600,null,'2026-08-03')`);
  await run(`insert into coffee_container_tare (container_number, position, tare_weight) values (27,1,410)`);
  const p = new PartsService(db), stock = new StockService(db), coffee = new CoffeeService(db), ledger = new CoffeeLedgerService(db, stock);
  await p.provision({ machineIds: [A], actorRef: "owner" });
  const h271 = await p.findByInventoryNo("H-27-1");
  assert.equal(h271.tareWeight, 410, "тара с матрицы легла на карточку при автозаведении");

  // Заливка: «после − до» → списание 500 г; узел привязан
  const [r1] = await run(`select id from coffee_refill where position = 1`);
  const c1 = await ledger.consumeRefill(r1.id, "person:x");
  assert.equal(c1.consumed, true); assert.equal(c1.qty, 500); assert.equal(c1.how, "weights");
  const again = await ledger.consumeRefill(r1.id);
  assert.equal(again.stockMovementId, c1.stockMovementId, "повтор не списывает второй раз");
  assert.equal((await run(`select part_unit_id from coffee_refill where id = $1`, [r1.id]))[0].part_unit_id, h271.id);
  // Пачки × вес пачки
  const { id: r2 } = await coffee.submitRefill({ locationId: LOC, position: 1, containerNumber: 27, ingredientId: ing.id, filledWeight: 900, packageCount: 2, enteredDate: "2026-08-05" });
  const c2 = await ledger.consumeRefill(r2);
  assert.equal(c2.qty, 2000); assert.equal(c2.how, "packages");
  // Без данных — помечено, не списано; без карточки склада — помечено
  const [r3] = await run(`select id from coffee_refill where position = 3`);
  const c3 = await ledger.consumeRefill(r3.id);
  assert.equal(c3.consumed, false); assert.match(c3.reason, /нет точных данных/);
  const { id: r4 } = await coffee.submitRefill({ locationId: LOC, position: 3, containerNumber: 5, ingredientId: milk.id, filledWeight: 700, measuredBefore: 200, enteredDate: "2026-08-06" });
  const c4 = await ledger.consumeRefill(r4);
  assert.equal(c4.consumed, false); assert.equal(c4.qty, 500); assert.match(c4.reason, /нет карточки склада/);
  assert.equal((await ledger.unconsumedRefills(3650)).length, 2);

  // Возврат: брутто 787 − тара 410 = 377 → приход return партией «возврат из бункера H-27-1», открытой в день возврата
  const ret = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 787, returnedDate: "2026-08-10", createdBy: "person:x" });
  assert.equal(ret.replay, false); assert.equal(ret.netWeight, 377); assert.equal(ret.tare, 410); assert.equal(ret.unitLabel, "H-27-1");
  assert.equal(ret.ingredientName, "Кофе зерновой"); assert.ok(ret.stockMovementId); assert.equal(ret.reason, null);
  const [mv] = await run(`select m.kind, m.qty, m.unit, m.dt, b.batch_code, b.opened_on, b.source from stock_movement m join stock_batch b on b.id = m.batch_id where m.id = $1`, [ret.stockMovementId]);
  assert.equal(mv.kind, "return"); assert.equal(Number(mv.qty), 377); assert.equal(mv.batch_code, "возврат из бункера H-27-1"); assert.equal(new Date(mv.opened_on).toISOString().slice(0, 10), "2026-08-10"); assert.equal(mv.source, "coffee-return");
  const replay = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 787, returnedDate: "2026-08-10" });
  assert.equal(replay.replay, true); assert.equal(replay.id, ret.id); assert.equal(replay.stockMovementId, ret.stockMovementId);
  assert.equal((await run(`select count(*)::int as n from stock_movement where kind = 'return'`))[0].n, 1, "дубль возврата не приходуется второй раз");

  // Без тары — записан, не проведён, в списке «без тары»; брутто меньше тары — тоже
  const noTare = await ledger.recordContainerReturn({ position: 3, containerNumber: 5, weight: 500, returnedDate: "2026-08-10" });
  assert.equal(noTare.reason, "нет тары"); assert.equal(noTare.netWeight, null); assert.equal(noTare.stockMovementId, null);
  const light = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 300, returnedDate: "2026-08-11" });
  assert.equal(light.reason, "брутто меньше тары");
  const unposted = await ledger.unpostedReturns();
  assert.deepEqual(unposted.map((u) => u.reason).sort(), ["брутто меньше тары", "нет тары"]);
  assert.equal(unposted.find((u) => u.containerNumber === 5).unitLabel, "H-5-3");
  const list = await coffee.containerReturns();
  assert.equal(list.find((r) => r.id === ret.id).netWeight, 377); assert.ok(list.find((r) => r.id === ret.id).stockMovementId);

  // Баланс склада по карточке: −500 −2000 +377
  const [bal] = await run(`select sum(case when kind in ('intake','return') then qty::numeric else -qty::numeric end) as q from stock_movement where ingredient_id = $1`, [CARD]);
  assert.equal(Number(bal.q), -2123);

  // Удаление ошибочного возврата убирает и приход с партией
  await ledger.deleteContainerReturn(ret.id, { actor: "owner" });
  assert.equal((await run(`select count(*)::int as n from stock_movement where kind = 'return'`))[0].n, 0);
  assert.equal((await run(`select count(*)::int as n from stock_batch where source = 'coffee-return'`))[0].n, 0);

  // Тумблер выключен — заливка не списывается, но узел привязывается
  await run(`insert into system_config (key, value) values ('COFFEE_REFILL_CONSUMES','0')`);
  const { id: r5 } = await coffee.submitRefill({ locationId: LOC, position: 1, containerNumber: 27, ingredientId: ing.id, filledWeight: 900, measuredBefore: 100, enteredDate: "2026-08-12" });
  const c5 = await ledger.consumeRefill(r5);
  assert.equal(c5.consumed, false); assert.match(c5.reason, /выключено/);
  assert.equal((await run(`select part_unit_id from coffee_refill where id = $1`, [r5]))[0].part_unit_id, h271.id);
  console.log(`У5 (${ENGINE}): возврат → приход return (нетто по таре узла, партия открыта), заливка → списание по точным данным, дубли, удаление ✔`);
} finally { await close(); }
