// Визит: приезд на точку (слово владельца 12.09.2026) — на настоящем SQL.
// Проверяется то, чего заглушка не покажет: визит СОБИРАЕТСЯ из разных таблиц
// в один день, границы окна включительные, а точка без единого визита не
// пропадает из ответа — «ни разу» и есть та новость, ради которой читают.
import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { VisitsService } = reqCore(path.join(REPO, "apps/core/dist/coffee/visits.service.js"));
const { db, run, close } = await coreDb();

try {
  const A = "00000000-0000-0000-0000-0000000000a1";
  const B = "00000000-0000-0000-0000-0000000000b1";
  const C = "00000000-0000-0000-0000-0000000000c1";
  await run(`insert into entity (id, type, name) values ('${A}','location','Школа'), ('${B}','location','Клиника'), ('${C}','location','Заброшенная')`);
  // Один визит = заливки + расходники в один день на одной точке.
  await run(`insert into coffee_refill (location_id, position, filled_weight, entered_date, occurred_at, created_by) values
    ('${A}',1,1700,'2026-09-05','2026-09-05T04:00:00Z','person:volody'),
    ('${A}',2,1650,'2026-09-05','2026-09-05T04:05:00Z','person:volody'),
    ('${B}',1,1600,'2026-09-07','2026-09-07T04:00:00Z','person:rustam')`);
  await run(`insert into coffee_consumable (location_id, logged_date, water, cups, lids, created_by)
             values ('${A}','2026-09-05',2,10,5,'person:volody')`);
  // Визит БЕЗ заливки: только расходники — приехал, убрался, бункера не менял.
  await run(`insert into coffee_consumable (location_id, logged_date, water, cups, lids, created_by)
             values ('${B}','2026-09-09',1,0,0,'person:rustam')`);

  const visits = new VisitsService(db);
  const list = await visits.list("2026-09-01", "2026-09-30");

  assert.equal(list.length, 3, "два визита на Школу+Клинику 05 и 07 и один расходный 09");
  const школа = list.find((v) => v.locationName === "Школа" && v.day === "2026-09-05");
  assert.equal(школа.refills, 2, "две заливки одного дня — один визит, а не два");
  assert.equal(школа.consumables, true, "расходники того же дня вошли в тот же визит");
  assert.deepEqual(школа.actors, ["person:volody"]);

  const тихий = list.find((v) => v.day === "2026-09-09");
  assert.equal(тихий.refills, 0, "визит без заливки виден — приехал, убрался");
  assert.equal(тихий.consumables, true);

  // ── Границы окна включительные: день «по» не теряется ────────────────────
  assert.equal((await visits.list("2026-09-05", "2026-09-05")).length, 1, "окно в один день находит этот день");
  assert.equal((await visits.list("2026-09-01", "2026-09-04")).length, 0);

  // ── «Ни разу» — тоже ответ ───────────────────────────────────────────────
  const seen = await visits.lastSeen("2026-09-01", "2026-09-30", "2026-09-12");
  assert.equal(seen.length, 3, "точка без визитов из ответа не исчезает");
  const заброшенная = seen.find((s) => s.locationName === "Заброшенная");
  assert.equal(заброшенная.lastVisit, null);
  assert.equal(заброшенная.daysAgo, null, "«ни разу» — это не ноль дней назад");
  assert.equal(seen[0].locationName, "Заброшенная", "самые забытые — первыми");
  assert.equal(seen.find((s) => s.locationName === "Школа").daysAgo, 7);
  assert.equal(seen.find((s) => s.locationName === "Клиника").daysAgo, 3, "берётся ПОСЛЕДНИЙ визит, а не первый");

  console.log(`Визиты (${ENGINE}): день собирается из разных таблиц, границы включительные, «ни разу» не теряется ✔`);
} finally {
  await close();
}
