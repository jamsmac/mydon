// Сигнал «стало известно» (Н-2, волна 6) — на настоящем SQL.
// Проверяется то, чего заглушка не покажет: переходы пробела между днями,
// идемпотентность повторного прогона, разница «появился» / «вернулся» и то,
// что пробел без устойчивого ключа в журнал не попадает вовсе.
import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { GapSignalService } = reqCore(path.join(REPO, "apps/core/dist/gaps/gap-signal.service.js"));
const { db, run, close } = await coreDb();

const gap = (key, topic, missing = `${topic}: не хватает данных`) => ({ key, topic, period: null, missing, scale: null, action: "заполнить" });

try {
  // Реестр подменяем списком: сверка не обязана уметь его считать, она обязана
  // уметь сравнивать. Настоящий `GapsService` тянет инкассации и финансы —
  // здесь проверяется не он.
  const signal = new GapSignalService(db, { list: async () => [] });

  // ── День 1: три пробела, один без ключа ─────────────────────────────────
  const day1 = [gap("tare", "тара бункера"), gap("price", "ингредиенты без цены"), { ...gap("x", "дыра в журнале"), key: null }];
  const r1 = await signal.reconcile("2026-09-10", day1);
  assert.deepEqual(r1, { seen: 2, closed: 0, appeared: 2, returned: 0 }, "пробел без ключа в журнал не попал");
  assert.equal((await run(`select count(*)::int as n from gap_state`))[0].n, 2);

  const d1 = await signal.digest("2026-09-10");
  assert.equal(d1.reconciled, true);
  assert.equal(d1.appeared.length, 2);
  assert.equal(d1.becameKnown.length, 0, "в первый день закрываться нечему");
  assert.equal(d1.open.total, 2);

  // ── Повтор того же дня ничего не меняет ─────────────────────────────────
  const again = await signal.reconcile("2026-09-10", day1);
  assert.deepEqual(again, { seen: 2, closed: 0, appeared: 0, returned: 0 }, "повторный прогон не заводит вторых строк");
  assert.equal((await run(`select count(*)::int as n from gap_state`))[0].n, 2);
  assert.equal((await run(`select count(*)::int as n from gap_reconcile_run`))[0].n, 1, "прогон за день один");

  // ── День 2: тару откалибровали — «стало известно» ────────────────────────
  const r2 = await signal.reconcile("2026-09-11", [gap("price", "ингредиенты без цены")]);
  assert.deepEqual(r2, { seen: 1, closed: 1, appeared: 0, returned: 0 });
  const d2 = await signal.digest("2026-09-11");
  assert.equal(d2.becameKnown.length, 1);
  assert.equal(d2.becameKnown[0].key, "tare");
  assert.equal(d2.becameKnown[0].openDays, 1, "сколько пробел провисел — считается от первого появления");
  assert.equal(d2.open.total, 1);
  // Вчерашняя сводка не переписывается задним числом: она про свой день.
  assert.equal((await signal.digest("2026-09-10")).becameKnown.length, 0);

  // ── День 3: тара снова разъехалась — это ВОЗВРАТ, а не новый пробел ─────
  const r3 = await signal.reconcile("2026-09-12", [gap("price", "ингредиенты без цены"), gap("tare", "тара бункера")]);
  assert.deepEqual(r3, { seen: 2, closed: 0, appeared: 0, returned: 1 });
  const d3 = await signal.digest("2026-09-12");
  assert.equal(d3.appeared.length, 0, "вернувшийся пробел не выдаётся за новый");
  assert.equal(d3.returned.length, 1);
  assert.equal(d3.returned[0].key, "tare");
  const [tare] = await run(`select first_seen_on::text as f, reopened_on::text as r, closed_on from gap_state where key='tare'`);
  assert.equal(tare.f, "2026-09-10", "день первого появления не переписан ради удобства счёта");
  assert.equal(tare.r, "2026-09-12");
  assert.equal(tare.closed_on, null);

  // ── День без сверки: «ничего не закрылось» ≠ «сверка не шла» ─────────────
  const quiet = await signal.digest("2026-09-13");
  assert.equal(quiet.reconciled, false, "сводка честно говорит, что сверки в этот день не было");
  assert.equal(quiet.becameKnown.length, 0);
  assert.equal(quiet.open.total, 2, "открытые пробелы при этом видны — они никуда не делись");

  // ── «Висит давно» считается от первого появления ─────────────────────────
  await signal.reconcile("2026-09-30", [gap("price", "ингредиенты без цены")]);
  const d4 = await signal.digest("2026-09-30");
  assert.equal(d4.open.stale.length, 1, "20 дней открытым — это уже «висит давно»");
  assert.equal(d4.open.stale[0].key, "price");
  assert.equal(d4.open.stale[0].openDays, 20);

  console.log(`Сигнал «стало известно» (${ENGINE}): переходы, идемпотентность, возврат ≠ появление, день без сверки ✔`);
} finally {
  await close();
}
