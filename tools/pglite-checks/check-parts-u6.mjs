import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { StockService } = reqCore(path.join(REPO, "apps/core/dist/stock/stock.service.js"));
const { VendingLedgerService } = reqCore(path.join(REPO, "apps/core/dist/stock/vending-ledger.js"));
const { VendingService } = reqCore(path.join(REPO, "apps/core/dist/vending/vending.service.js"));
const { RefillService } = reqCore(path.join(REPO, "apps/core/dist/vending/refill.service.js"));
const { db, run, close } = await coreDb();
try {
  const W = "00000000-0000-0000-0000-00000000ff01", BOUNTY = "00000000-0000-0000-0000-00000000bb01", RECIPE = "00000000-0000-0000-0000-00000000bb02";
  await run(`insert into entity (id, type, name, attrs) values ('${W}','warehouse','Склад','{}'), ('${BOUNTY}','product','Bounty','{"вид":"перепродажа"}'), ('${RECIPE}','product','Латте','{"вид":"рецепт"}')`);
  await run(`insert into vending_product (name, purchase_price) values ('Snickers', 8000), ('Bounty', 7000)`);
  const stock = new StockService(db), ledger = new VendingLedgerService(db);
  const vending = new VendingService(db, undefined, ledger), refill = new RefillService(db, vending, ledger);

  // Карточки реестра для прайса: Bounty связан по имени, Snickers заведён
  const dry = await ledger.ensureCards({ dryRun: true });
  assert.deepEqual(dry, { linked: ["Bounty"], created: ["Snickers"], ambiguous: [], already: 0 });
  assert.equal((await run(`select count(*)::int as n from entity where type='product'`))[0].n, 2, "dry-run ничего не завёл");
  const rep = await ledger.ensureCards({});
  assert.deepEqual(rep.created, ["Snickers"]);
  const [sn] = await run(`select e.id, e.attrs from vending_product vp join entity e on e.id = vp.entity_id where vp.name = 'Snickers'`);
  assert.equal(sn.attrs["единица"], "шт"); assert.equal(sn.attrs["цена покупки"], 8000);
  assert.deepEqual(await ledger.ensureCards({}), { linked: [], created: [], ambiguous: [], already: 2 }, "идемпотентно");

  // Леджер принимает товар на перепродажу, рецептурный — нет
  const mv = await stock.createMovement({ kind: "intake", ingredientId: sn.id, warehouseId: W, qty: 10, unit: "шт", clientKey: "in-1" });
  assert.equal(mv.kind, "intake");
  await assert.rejects(stock.createMovement({ kind: "intake", ingredientId: RECIPE, warehouseId: W, qty: 1, unit: "шт" }), /рецептурный товар/);
  const bal = await stock.pairBalance(W, sn.id);
  assert.equal(bal.baseUnit, "шт"); assert.equal(bal.qty, 10);
  const st = await stock.stocktake({ warehouseId: W, ingredientId: sn.id, actual: 8 });
  assert.equal(st.delta, -2); assert.equal((await stock.pairBalance(W, sn.id)).qty, 8);

  // Пересчёт склада вендинга → корректировка леджера от ЕГО остатка
  const ing = await vending.ingestStock({ items: [{ product: "Snickers", quantity: 40 }, { product: "Bounty", quantity: 20 }], countedAt: "2026-09-01T06:00:00Z" }, "owner");
  assert.ok(ing);
  assert.equal((await stock.pairBalance(W, sn.id)).qty, 40, "леджер: 8 → 40 корректировкой +32");
  assert.equal((await stock.pairBalance(W, BOUNTY)).qty, 20);
  let parity = await ledger.parity();
  assert.equal(parity.mismatched, 0); assert.equal(parity.unlinked, 0);
  assert.deepEqual(parity.rows.map((r) => [r.productName, r.table, r.ledger]), [["Bounty", 20, 20], ["Snickers", 40, 40]]);

  // Заливка автомата: проекция −3 и леджер −3, повтор по ключу не двоит
  const r1 = await refill.create({ machineSerial: "M1", productName: "Snickers", qty: 3, clientKey: "rf-1" });
  assert.equal(r1.stockLeft, 37);
  const r2 = await refill.create({ machineSerial: "M1", productName: "Snickers", qty: 3, clientKey: "rf-1" });
  assert.equal(r2.duplicate, true);
  assert.equal((await stock.pairBalance(W, sn.id)).qty, 37);
  parity = await ledger.parity(); assert.equal(parity.mismatched, 0);

  // Ручной приход мимо проекции → сверка видит расхождение
  await stock.createMovement({ kind: "intake", ingredientId: sn.id, warehouseId: W, qty: 5, unit: "шт", clientKey: "in-2" });
  parity = await ledger.parity();
  assert.equal(parity.mismatched, 1); assert.equal(parity.rows.find((r) => r.productName === "Snickers").diff, -5);

  // Катовер: чтение из леджера
  assert.equal((await vending.stockLevels()).find((r) => r.product === "Snickers").quantity, 37, "до катовера — таблица");
  await run(`insert into system_config (key, value) values ('VENDING_STOCK_SOURCE','ledger')`);
  assert.equal((await vending.stockLevels()).find((r) => r.product === "Snickers").quantity, 42, "после катовера — леджер");
  const r3 = await refill.create({ machineSerial: "M1", productName: "Snickers", qty: 2, clientKey: "rf-2" });
  assert.equal(r3.stockLeft, 40, "остаток в ответе — по леджеру");

  // Дата пересчёта из истории (R-GS-6): max(dt) приходит Date-объектом у postgres-js и строкой у pglite — ::text уравнивает
  const gs = await ledger.goodsStock();
  const snick = gs.rows.find((r) => r.productName === "Snickers");
  assert.ok(snick.countedAt instanceof Date && !Number.isNaN(snick.countedAt.getTime()), "countedAt — настоящая дата, не Invalid Date");
  assert.equal(snick.countedAt.toISOString().slice(0, 10), "2026-09-01", "дата пересчёта — 01.09, тот же день по ISO");
  assert.equal(gs.asOf.toISOString().slice(0, 10), "2026-09-01");

  // ── Срез 05.09: чтения — через одну дверь (R-GS-1…7) ─────────────────────
  // (а) Все активные позиции прайса, включая ноль и «неизвестно»: Pulpy без карточки → null
  await run(`insert into vending_product (name, purchase_price) values ('Pulpy', 5000)`);
  const levels = await vending.stockLevels();
  assert.deepEqual(levels.map((r) => [r.product, r.quantity]), [["Bounty", 20], ["Pulpy", null], ["Snickers", 40]], "ledger: список — прайс, без карточки — null, не 0");
  assert.equal(levels.find((r) => r.product === "Snickers").countedAt.slice(0, 10), "2026-09-01", "дата — из истории пересчётов");
  // (б) Повтор заливки по clientKey — остаток леджера, таблица не при чём
  const r4 = await refill.create({ machineSerial: "M1", productName: "Snickers", qty: 2, clientKey: "rf-2" });
  assert.equal(r4.duplicate, true); assert.equal(r4.stockLeft, 40);
  // (в) Пустая таблица при заполненном леджере → сверка НЕ зелёная
  await run(`delete from vending_stock`);
  parity = await ledger.parity();
  assert.equal(parity.missingRows, 2, "Snickers и Bounty без строки; Pulpy без карточки — это no_card, не no_row");
  assert.equal(parity.mismatched, 2, "Snickers 40 и Bounty 20 в леджере — расхождения; Pulpy без карточки — нет");
  assert.equal(parity.products, 3, "все три позиции прайса в сверке");
  assert.equal(parity.rows.find((r) => r.productName === "Snickers").status, "no_row");
  assert.equal(parity.rows.find((r) => r.productName === "Pulpy").status, "no_card");
  // (г) В режиме ledger список остатков и план не зависят от таблицы
  assert.equal((await vending.stockLevels()).find((r) => r.product === "Snickers").quantity, 40, "таблица пуста, остаток из леджера");
  // (д) Режим table — прежние числа: таблица пуста → пусто
  await run(`update system_config set value = 'table' where key = 'VENDING_STOCK_SOURCE'`);
  assert.deepEqual(await vending.stockLevels(), [], "table: читается таблица, она пуста");
  await run(`update system_config set value = 'ledger' where key = 'VENDING_STOCK_SOURCE'`);

  console.log(`У6 (${ENGINE}): карточки для прайса, товары в леджере, двойная запись (пересчёт, заливка), сверка, катовер ✔`);
} finally { await close(); }
