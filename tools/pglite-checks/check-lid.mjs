// Крышка бункера (решение 12.09.2026 вместо допущения R-B-19) — на настоящем SQL.
// Проверяется то, чего заглушка не покажет: умолчания столбцов на СТАРЫХ строках,
// CHECK-ограничения основания и веса крышки, и главное — что при неизвестной
// крышке возврат ОТКАЗЫВАЕТСЯ считаться, а не тихо теряет вес крышки.
import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { PartsService } = reqCore(path.join(REPO, "apps/core/dist/maintenance/parts.service.js"));
const { StockService } = reqCore(path.join(REPO, "apps/core/dist/stock/stock.service.js"));
const { CoffeeLedgerService } = reqCore(path.join(REPO, "apps/core/dist/coffee/coffee-ledger.service.js"));
const { db, run, close } = await coreDb();
try {
  const LOC = "00000000-0000-0000-0000-00000000ab01";
  const W = "00000000-0000-0000-0000-00000000ab02";
  const CARD = "00000000-0000-0000-0000-00000000ab03";
  await run(`insert into entity (id, type, name, attrs) values
    ('${LOC}','location','Точка К','{}'), ('${W}','warehouse','Склад','{}'), ('${CARD}','ingredient','Кофе зерновой','{"единица":"г"}')`);
  await run(`insert into coffee_ingredient (name, entity_id, package_weight) values ('Кофе зерновой', '${CARD}', 1000)`);
  const [ing] = await run(`select id from coffee_ingredient where name = 'Кофе зерновой'`);
  await run(`insert into coffee_refill (location_id, position, container_number, ingredient_id, filled_weight, entered_date, occurred_at)
             values ('${LOC}',1,27,'${ing.id}',800,'2026-09-01','2026-09-01T00:00:00+05:00')`);
  const parts = new PartsService(db);
  const stock = new StockService(db);
  const ledger = new CoffeeLedgerService(db, stock);

  // ── 1. Старые строки читаются по прежнему правилу, а не как «неизвестно» ──
  // Миграция добавила столбцы задним числом: у всего, что уже записано, должно
  // стоять именно то допущение, по которому это и мерили (R-B-19: с крышкой).
  const [oldRefill] = await run(`select weighed_with_lid from coffee_refill where position = 1`);
  assert.equal(oldRefill.weighed_with_lid, true, "заливка до решения — «с крышкой», как её и мерили");
  const hopper = await parts.create({ partKind: "hopper", setNumber: 27, hopperPosition: 1, tareWeight: 1300, actorRef: "owner" });
  const [unitRow] = await run(`select tare_basis, lid_weight from part_unit where id = $1`, [hopper.id]);
  assert.equal(unitRow.tare_basis, "with_lid", "тара без явного основания — с крышкой");
  assert.equal(unitRow.lid_weight, null, "вес крышки не выдумывается умолчанием");

  // ── 2. Основания совпали — считается как раньше (регресс У5) ─────────────
  const same = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 1700, returnedDate: "2026-09-10", createdBy: "person:tech" });
  assert.equal(same.netWeight, 400);
  assert.ok(same.stockMovementId);
  assert.equal(same.reason, null);

  // ── 3. Другое состояние при неизвестной крышке — ОТКАЗ, а не «минус крышка» ─
  // Это ядро решения: 1700 «без крышки» против тары «с крышкой» дало бы 400 г
  // ровно с ошибкой в вес крышки — и одного знака каждый цикл.
  const blind = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 1700, weighedWithLid: false, returnedDate: "2026-09-11", createdBy: "person:tech" });
  assert.equal(blind.netWeight, null, "нечем привести — нечего и считать");
  assert.equal(blind.stockMovementId, null, "на склад ничего не легло");
  assert.match(blind.reason, /крышк/);
  assert.equal(blind.tare, 1300, "тара при этом известна — причина именно в крышке, и так и сказано");
  const unposted = await ledger.unpostedReturns();
  assert.ok(unposted.some((u) => u.id === blind.id), "возврат виден в разборе, а не потерян");

  // ── 4. Крышку взвесили один раз — считается в любом состоянии ────────────
  await parts.update(hopper.id, { lidWeight: 120 }, "owner");
  const conv = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 1700, weighedWithLid: false, returnedDate: "2026-09-12", createdBy: "person:tech" });
  assert.equal(conv.netWeight, 520, "1700 без крышки = 1820 с крышкой, минус тара 1300");
  assert.ok(conv.stockMovementId);
  const [mv] = await run(`select note from stock_movement where id = $1`, [conv.stockMovementId]);
  assert.match(mv.note, /без крышки/, "в примечании видно, что взвесили и как привели");
  assert.match(mv.note, /1820/, "и приведённое число, иначе арифметика не сходится руками");

  // ── 5. Состояние — часть замера: то же число в другом состоянии не «повтор» ─
  const a = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 1650, returnedDate: "2026-09-13" });
  const b = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 1650, weighedWithLid: false, returnedDate: "2026-09-13" });
  assert.equal(b.replay, false, "«1650 с крышкой» и «1650 без» — разные взвешивания");
  assert.notEqual(a.id, b.id);
  // Заодно застава на код партии: один бункер возвращают снова и снова, и
  // второй проведённый возврат не должен падать на уникальности кода.
  assert.ok(a.stockMovementId && b.stockMovementId, "оба возврата проведены");
  assert.equal((await run(`select count(*)::int as n from stock_batch where source = 'coffee-return'`))[0].n, 4);
  assert.equal(b.netWeight - a.netWeight, 120, "разница между ними — ровно крышка");
  const again = await ledger.recordContainerReturn({ position: 1, containerNumber: 27, weight: 1650, weighedWithLid: false, returnedDate: "2026-09-13" });
  assert.equal(again.replay, true, "а настоящий повтор по-прежнему не приходуется дважды");
  assert.equal(again.id, b.id);

  // ── 6. Ограничения базы: мимо сервиса тоже не пройдёт ────────────────────
  await assert.rejects(
    run(`update part_unit set tare_basis = 'с крышкой' where id = '${hopper.id}'`),
    /part_unit_tare_basis_known|check/i,
    "основание — только из известного списка",
  );
  await assert.rejects(
    run(`update part_unit set lid_weight = 0 where id = '${hopper.id}'`),
    /part_unit_lid_weight_sane|check/i,
    "нулевая крышка — это не крышка",
  );
  await assert.rejects(
    run(`update part_unit set lid_weight = 900 where id = '${hopper.id}'`),
    /part_unit_lid_weight_sane|check/i,
    "900 г — это уже не крышка, а перепутанное поле",
  );

  console.log(`Крышка (${ENGINE}): умолчания на старых строках, отказ без веса крышки, приведение, дедуп по состоянию, CHECK ✔`);
} finally {
  await close();
}
