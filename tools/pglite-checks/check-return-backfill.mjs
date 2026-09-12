// Досчёт нетто у возвратов, записанных МИМО леджера (архивный импорт) — на
// настоящем SQL. Проверяется то, чего заглушка не покажет: тара берётся той же
// дверью, что и у живого ввода; склад НЕ трогается; разные основания
// взвешивания при неизвестной крышке нетто не получают.
import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { StockService } = reqCore(path.join(REPO, "apps/core/dist/stock/stock.service.js"));
const { CoffeeLedgerService } = reqCore(path.join(REPO, "apps/core/dist/coffee/coffee-ledger.service.js"));
const { db, run, close } = await coreDb();

const n = async (sql) => Number((await run(sql))[0].n);

try {
  await run(`insert into coffee_container_tare (container_number, position, tare_weight) values (27,1,640), (5,2,620)`);
  // Бункер с известным весом крышки — на нём проверяется приведение оснований.
  await run(`insert into part_unit (id, part_kind, inventory_no, label_pending, set_number, hopper_position, tare_weight, lid_weight)
             values ('00000000-0000-0000-0000-00000000cc01','hopper','H-27-1',false,27,1,640,90)`);
  // Строки, как их кладёт архивный импорт: без нетто, без узла, без движения.
  await run(`insert into coffee_container_return (position, container_number, weight, returned_date, created_by) values
    (1,27,1740,'2026-08-10','import:telegram-history'),
    (2,5,1500,'2026-08-11','import:telegram-history'),
    (3,9,1200,'2026-08-12','import:telegram-history'),
    (1,27,300,'2026-08-13','import:telegram-history')`);
  // Замер без крышки на бункере, у которого крышка известна: 1650 + 90 = 1740.
  await run(`insert into coffee_container_return (position, container_number, weight, weighed_with_lid, returned_date, created_by)
             values (1,27,1650,false,'2026-08-14','import:telegram-history')`);

  const ledger = new CoffeeLedgerService(db, new StockService(db));
  const res = await ledger.backfillReturnNetWeight("agent:test");

  assert.equal(res.considered, 5);
  assert.equal(res.filled, 3, "посчитаны те, у кого тара известна и брутто её больше");
  assert.equal(res.skipped.noTare, 1, "набор 9 таре неизвестен — нетто не выдумываем");
  assert.equal(res.skipped.lighterThanTare, 1, "брутто 300 при таре 640 — это не возврат, а ошибка ввода");

  const [a] = await run(`select net_weight, part_unit_id from coffee_container_return where returned_date='2026-08-10'`);
  assert.equal(a.net_weight, 1100, "1740 − 640");
  assert.equal(a.part_unit_id, "00000000-0000-0000-0000-00000000cc01", "заодно привязан узел-бункер");

  const [b] = await run(`select net_weight from coffee_container_return where returned_date='2026-08-11'`);
  assert.equal(b.net_weight, 880, "тара берётся из матрицы, когда карточки узла нет");

  const [c] = await run(`select net_weight from coffee_container_return where returned_date='2026-08-14'`);
  assert.equal(c.net_weight, 1100, "замер без крышки приведён к основанию тары по весу крышки этого бункера");

  // ── Склад не тронут: нетто — производная, приход — факт движения товара ──
  assert.equal(await n(`select count(*)::int as n from stock_movement`), 0, "ни одного движения склада");
  assert.equal(
    await n(`select count(*)::int as n from coffee_container_return where stock_movement_id is not null`),
    0,
    "возвраты не выданы за приходы",
  );

  // ── Повтор ничего не меняет: пересчитываются только пустые ───────────────
  const again = await ledger.backfillReturnNetWeight("agent:test");
  assert.equal(again.considered, 2, "посчитанные строки второй раз не рассматриваются");
  assert.equal(again.filled, 0);

  // ── Журнал: одна запись на прогон, а не 1232 ─────────────────────────────
  const audit = await run(`select count(*)::int as n from audit_log where action='coffee.return_net_backfilled'`);
  assert.equal(Number(audit[0].n), 2, "по одной записи на каждый прогон");

  console.log(`Досчёт нетто возвратов (${ENGINE}): тара той же дверью, крышка приведена, склад не тронут, повтор пуст ✔`);
} finally {
  await close();
}
