#!/usr/bin/env node
/**
 * Дымовой прогон бэкфилла ключей и правки времени инкассаций (срез «правда о
 * пробеле») против НАСТОЯЩЕГО Postgres.
 *
 * ЗАЧЕМ. Юнит-тесты обоих скриптов работают на заглушке drizzle: она отвечает
 * заготовленным ответом и зеленеет на любом SQL. Заглушка НЕ исполняет:
 *   · уникальный индекс `collection_client_key` по nullable-колонке — NULL'ы
 *     обязаны сосуществовать, а дубль настоящего ключа обязан упасть;
 *   · `on conflict (client_key) do nothing` по этому индексу — идемпотентность
 *     писателя `collections.service.ts` проверяется только сервером;
 *   · транзакционность разовой правки времени: `UPDATE` + построчный
 *     `audit_log` + одно `event` одной транзакцией — заглушка не откатывает;
 *   · заставу «повторный прогон отказывает» — она читает `event`/`audit_log`
 *     настоящими запросами, а не массивом в памяти теста.
 *
 * ЭТОТ ПРОГОН ПИШЕТ В ДЕНЕЖНЫЙ ЖУРНАЛ ВЛАДЕЛЬЦА — И ПОТОМУ ОТКАЗЫВАЕТСЯ
 * РАБОТАТЬ НЕ НА SCRATCH. Инкассации — не «мало строк», а НИ ОДНОЙ: прогон
 * заводит и убирает СВОИ фикстурные строки, и чужую инкассацию трогать не
 * имеет права. Три заставы до первой записи — тот же приём, что у
 * `smoke-import.mjs`:
 *   1. явное согласие: `SMOKE_SCRATCH=1` в окружении ЛИБО имя базы со словом
 *      `smoke`. Эту заставу не обойти SSH-туннелем на `localhost:5432`;
 *   2. хост `DATABASE_URL` обязан быть локальным;
 *   3. в базе не должно быть НИ ОДНОЙ инкассации, ни одной отметки правки
 *      времени в `event`, ни одной записи `collection.time_corrected` в
 *      `audit_log`.
 *
 * НИ ОДНО СООБЩЕНИЕ НЕ ПЕЧАТАЕТ СТРОКУ ПОДКЛЮЧЕНИЯ (R-FW-S1) — наружу идёт
 * только `host`, вывод дочерних процессов чистится `безСекретов`.
 *
 * ЧТО ДЕЛАЕТ. Заводит фикстурного донора в схеме `vendcash_donor` (та же
 * база — тесту нужен только SQL, не отдельная СУБД) и пять зеркальных строк
 * `collection`, по одной на каждое правило сопоставления и на каждую заставу:
 * нормализация регистра кода, добивка нулём, расхождение статуса (печатается,
 * не мешает паре), неоднозначность (не пишем ни одной). Гоняет
 * `backfill-collection-keys.js` (примерка → запись → повтор), затем
 * `fix-collection-time.js` (отказ без ключей → примерка → запись → повтор,
 * обязан отказать по отметке события). В конце убирает за собой — следом в
 * CI идёт `smoke-core.mjs`, и чужая инкассация в его выборках никому не нужна.
 *
 * Запуск локально (scratch-база, НЕ прод):
 *   createdb inkasssmoke_fw
 *   export DATABASE_URL=postgres://localhost/inkasssmoke_fw
 *   pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build
 *   node packages/db/dist/migrate.js && node packages/db/dist/seed.js
 *   SMOKE_SCRATCH=1 node tools/smoke-collections.mjs
 *   dropdb inkasssmoke_fw
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(КОРЕНЬ, "packages/db/package.json"));
const postgres = require("postgres");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL не задан — дымовой прогон инкассаций выполнять негде.");
  process.exit(1);
}

const СХЕМА = "vendcash_donor";
const КЛЮЧИ = path.join(КОРЕНЬ, "packages/db/dist/backfill-collection-keys.js");
const ВРЕМЯ = path.join(КОРЕНЬ, "packages/db/dist/fix-collection-time.js");

/** Ровно те ключи, которые может создать ЭТА фикстура, — по ним и убираем. */
const СВОИ_КЛЮЧИ = ["vendcash:collection:d1", "vendcash:collection:d2", "vendcash:collection:d3"];
/** Коды автоматов фикстуры: в разном регистре и один короткий на символ. */
const КОДЫ = { верхний: "AB01181F0000", короткий: "039ec91c000", обычный: "fa86d0060000" };

/** Наши id — фиксированные, чтобы уборка их знала заранее. */
const МАШИНА = "00000000-0000-4000-8000-0000006c0001";
const M = {
  m1: "00000000-0000-4000-8000-0000006d0001",
  m2: "00000000-0000-4000-8000-0000006d0002",
  m3: "00000000-0000-4000-8000-0000006d0003",
  m4: "00000000-0000-4000-8000-0000006d0004",
  m5: "00000000-0000-4000-8000-0000006d0005",
};
const СВОИ_СТРОКИ = Object.values(M);
/** id событий правки времени, появившихся ПРИ ЭТОМ прогоне (до него их было 0). */
const СВОИ_СОБЫТИЯ = new Set();

let завёл = false;

function безопасныйХост(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return ["", "localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function scratchПоИмени(url) {
  try {
    return /smoke/i.test(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
}

function хост(url) {
  try {
    return new URL(url).host || "unix-сокет";
  } catch {
    return "неразбираемый URL";
  }
}

const СТРОКА_ПОДКЛЮЧЕНИЯ = /postgres(?:ql)?:\/\/\S+/gi;
function безСекретов(текст) {
  return String(текст ?? "").replace(СТРОКА_ПОДКЛЮЧЕНИЯ, "postgres://***");
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

function прогон(скрипт, флаги) {
  const res = spawnSync("node", [скрипт, ...флаги], {
    cwd: КОРЕНЬ,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL, VENDCASH_DATABASE_URL: DATABASE_URL, VENDCASH_SCHEMA: СХЕМА },
  });
  const вывод = безСекретов(res.stdout);
  if (res.status !== 0) {
    throw new Error(`${path.basename(скрипт)} ${флаги.join(" ")} → код ${res.status}\n${вывод}\n${безСекретов(res.stderr)}`);
  }
  const строка = вывод.split("\n").find((s) => s.startsWith("ИТОГИ(json): "));
  if (!строка) throw new Error(`в отчёте нет разборной строки итогов:\n${вывод}`);
  console.log(вывод.trim());
  return { ...JSON.parse(строка.slice("ИТОГИ(json): ".length)), текст: вывод };
}

/** Прогон, который ОБЯЗАН завершиться конкретным кодом (застава — не «упало», а «отказало»). */
function прогонОжидаяКод(скрипт, флаги, ожидаемыйКод) {
  const res = spawnSync("node", [скрипт, ...флаги], {
    cwd: КОРЕНЬ,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL, VENDCASH_DATABASE_URL: DATABASE_URL, VENDCASH_SCHEMA: СХЕМА },
  });
  console.log(безСекретов(res.stdout).trim());
  if (res.status !== ожидаемыйКод) {
    throw new Error(
      `${path.basename(скрипт)} ${флаги.join(" ")} → код ${res.status}, ожидался ${ожидаемыйКод}\n` +
        `${безСекретов(res.stdout)}\n${безСекретов(res.stderr)}`,
    );
  }
  return безСекретов(res.stderr) || безСекретов(res.stdout);
}

function сверить(что, факт, ожидание) {
  const a = JSON.stringify(факт);
  const b = JSON.stringify(ожидание);
  if (a !== b) throw new Error(`${что}: получено ${a}, ожидалось ${b}`);
  console.log(`  ✓ ${что}: ${b}`);
}

async function обязанОтказать(что, действие) {
  const ошибка = await Promise.resolve()
    .then(действие)
    .then(() => null, (e) => e);
  if (!ошибка) throw new Error(`${что}: отказа не было, а он обязателен`);
  console.log(`  ✓ ${что} → «${ошибка.message.split("\n")[0]}»`);
}

async function число(запрос) {
  const [row] = await запрос;
  return Number(row.n);
}

/**
 * Застава: денежный журнал обязан быть пустым.
 *
 * Не «мало инкассаций», а НИ ОДНОЙ: прогон пишет ключи и время реальным
 * строкам, и чужая инкассация здесь — это уже не scratch, а чей-то журнал.
 */
async function проверитьScratch() {
  const [инкассаций, отметок, аудита] = await Promise.all([
    число(sql`select count(*) n from collection`),
    число(sql`select count(*) n from event where type = 'cash.collection_time_corrected'`),
    число(sql`select count(*) n from audit_log where action = 'collection.time_corrected'`),
  ]);
  if (инкассаций + отметок + аудита > 0) {
    throw new Error(
      `база уже содержит инкассации — смоук только на scratch (инкассаций ${инкассаций}, отметок правки ${отметок}, аудита ${аудита})`,
    );
  }
}

async function запомнитьСобытия() {
  for (const r of await sql`select id from event where type = 'cash.collection_time_corrected'`) СВОИ_СОБЫТИЯ.add(r.id);
}

async function завестиДонора() {
  await sql.unsafe(`drop schema if exists ${СХЕМА} cascade`);
  await sql.unsafe(`create schema ${СХЕМА}`);
  завёл = true;
  await sql.unsafe(`
    create table ${СХЕМА}.machines (id text primary key, code text not null);
    create table ${СХЕМА}.collections (
      id text primary key, machine_id text references ${СХЕМА}.machines(id),
      collected_at timestamp not null, amount numeric, status text not null);
  `);
  await sql.unsafe(`
    insert into ${СХЕМА}.machines (id, code) values
      ('mm1', '${КОДЫ.верхний}'), ('mm2', '${КОДЫ.короткий}'), ('mm3', '${КОДЫ.обычный}');
    insert into ${СХЕМА}.collections (id, machine_id, collected_at, amount, status) values
      ('d1', 'mm1', '2026-01-30 06:40:42.626', 1250000.00, 'received'),
      ('d2', 'mm2', '2026-01-30 07:15:00', 900000.00, 'received'),
      ('d3', 'mm3', '2026-01-30 08:00:00', null, 'collected'),
      ('d4', 'mm3', '2026-01-30 12:46:00', 3831000.00, 'collected'),
      ('d5', 'mm3', '2026-01-30 12:46:00', 3831000.00, 'collected');
  `);

  await sql`
    insert into entity (id, type, name, external_ref) values
      (${МАШИНА}::uuid, 'machine', 'Смоук-автомат инкассаций', 'ab01181f0000')`;
  // Второй и третий автомат зеркала опознаются по своим кодам через тот же
  // резолвер (`entity.external_ref`), поэтому заводим по карточке на каждый.
  await sql`
    insert into entity (id, type, name, external_ref) values
      (gen_random_uuid(), 'machine', 'Смоук-автомат 2', '039ec91c0000'),
      (gen_random_uuid(), 'machine', 'Смоук-автомат 3', 'fa86d0060000')`;

  // Зеркальные строки MYDON — прочитаны прошлым импортом КАК ТАШКЕНТСКИЕ
  // настенные часы (та же ошибка, которую правит T3): ключ сопоставления
  // сравнивает `tashkentInstant(donor.collected_at)` (Tashkent-чтение, минус
  // 5ч от UTC-цифр донора) с нашим collectedAt — они ОБЯЗАНЫ быть тем же
  // моментом, иначе d↔m не найдут пару вовсе. donor '06:40:42.626' без зоны
  // читается как Tashkent 06:40:42.626 = UTC 01:40:42.626.
  await sql`
    insert into collection (id, machine_id, collected_at, amount, status, source, client_key) values
      (${M.m1}::uuid, ${МАШИНА}::uuid, '2026-01-30 01:40:42.626+00', 1250000.00, 'received', 'import', null)`;
  const [m2m] = await sql`select id from entity where external_ref = '039ec91c0000'`;
  const [m3m] = await sql`select id from entity where external_ref = 'fa86d0060000'`;
  await sql`
    insert into collection (id, machine_id, collected_at, amount, status, source, client_key) values
      (${M.m2}::uuid, ${m2m.id}::uuid, '2026-01-30 02:15:00+00', 900000.00, 'received', 'import', null)`;
  // m3: расхождение статуса (у нас cancelled, у донора collected) — паре не
  // мешает, но печатается; manual_history — правка времени её НЕ трогает.
  await sql`
    insert into collection (id, machine_id, collected_at, amount, status, source, client_key) values
      (${M.m3}::uuid, ${m3m.id}::uuid, '2026-01-30 03:00:00+00', null, 'cancelled', 'manual_history', null)`;
  // m4/m5: тот же момент и та же сумма, что d4/d5 — тройной дубль сжимается
  // до пары кандидатов с каждой стороны, бэкфилл печатает неоднозначность.
  await sql`
    insert into collection (id, machine_id, collected_at, amount, status, source, client_key) values
      (${M.m4}::uuid, ${m3m.id}::uuid, '2026-01-30 07:46:00+00', 3831000.00, 'collected', 'manual_history', null),
      (${M.m5}::uuid, ${m3m.id}::uuid, '2026-01-30 07:46:00+00', 3831000.00, 'collected', 'manual_history', null)`;
}

/** Убираем ТОЛЬКО своё: точные id фикстуры и id событий, которые сами увидели появившимися. */
async function убратьЗаСобой() {
  if (!завёл) return;
  await запомнитьСобытия().catch(() => {});
  await sql.unsafe(`drop schema if exists ${СХЕМА} cascade`);
  if (СВОИ_СОБЫТИЯ.size > 0) {
    await sql`delete from audit_log where action = 'collection.time_corrected' and target in ${sql(СВОИ_СТРОКИ)}`;
    await sql`delete from event where id in ${sql([...СВОИ_СОБЫТИЯ])}`;
  }
  await sql`delete from collection where id in ${sql(СВОИ_СТРОКИ)}`;
  await sql`delete from entity where external_ref in ('ab01181f0000', '039ec91c0000', 'fa86d0060000')`;
}

try {
  // ── Заставы до первой записи ──
  if (process.env.SMOKE_SCRATCH !== "1" && !scratchПоИмени(DATABASE_URL)) {
    throw new Error(
      `смоук пишет в денежный журнал и потому требует ЯВНОГО scratch: SMOKE_SCRATCH=1 либо имя базы со словом ` +
        `«smoke» (хост ${хост(DATABASE_URL)}).`,
    );
  }
  if (!безопасныйХост(DATABASE_URL)) {
    throw new Error(`DATABASE_URL смотрит не на локальную базу — смоук только на scratch, он ПИШЕТ (хост ${хост(DATABASE_URL)})`);
  }
  сверить("явное согласие на запись есть", process.env.SMOKE_SCRATCH === "1" || scratchПоИмени(DATABASE_URL), true);
  сверить("боевое имя базы без SMOKE_SCRATCH отвергнуто", scratchПоИмени("postgres://smoke:pw@localhost:5432/mydon"), false);
  сверить("scratch опознан по имени базы", scratchПоИмени("postgres://smoke:pw@localhost:5432/inkasssmoke_fw"), true);
  сверить("хост базы локальный", безопасныйХост(DATABASE_URL), true);
  сверить("удалённый хост был бы отвергнут", безопасныйХост("postgres://smoke:pw@203.0.113.10:5432/smokedb"), false);
  сверить(
    "пароль не уедет в лог: наружу идёт только host",
    [хост("postgres://smoke:s3cret@203.0.113.10:5432/smokedb"), безСекретов("упало на postgres://smoke:s3cret@db/x")],
    ["203.0.113.10:5432", "упало на postgres://***"],
  );
  сверить("инкассаций в базе нет ни одной", await число(sql`select count(*) n from collection`), 0);
  сверить(
    "отметок правки времени нет",
    await число(sql`select count(*) n from event where type = 'cash.collection_time_corrected'`),
    0,
  );
  сверить(
    "записей аудита о правке нет",
    await число(sql`select count(*) n from audit_log where action = 'collection.time_corrected'`),
    0,
  );
  await проверитьScratch();

  await завестиДонора();
  console.log("Фикстурный донор заведён в схеме vendcash_donor (5 строк) + 5 зеркальных инкассаций.\n");

  // 1. Правка времени ДО ключей обязана ОТКАЗАТЬ: происхождение не доказано.
  //    прогонОжидаяКод сам бросает, если код НЕ совпал с ожидаемым — обёртка
  //    обязанОтказать здесь была бы лишней: успешный код 3 не бросает исключение.
  прогонОжидаяКод(ВРЕМЯ, ["--dry-run", "--expect=2"], 3);
  console.log("  ✓ правка времени без ключей отказывает кодом 3");

  // 2. Примерка ключей: числа полные, база нетронута.
  const примерка = прогон(КЛЮЧИ, ["--dry-run"]);
  сверить("сопоставлено", примерка.сопоставлено, 3);
  сверить("к записи", примерка.кЗаписи, 3);
  // ИТОГИ(json) отчёта — уже свёрнутые счётчики (см. formatReport), не
  // массивы: полные списки живут только в тексте отчёта, для дыма достаточно
  // числа.
  сверить("неоднозначно — одна группа из двух строк с каждой стороны", примерка.неоднозначно, 1);
  сверить("расхождение статуса напечатано", примерка.расхождениеСтатуса, 1);
  сверить(
    "примерка не записала ни одного ключа",
    await число(sql`select count(*) n from collection where id in ${sql(СВОИ_СТРОКИ)} and client_key is not null`),
    0,
  );

  // 3. Запись, потом повтор: второй --apply обязан дать «записано 0».
  сверить("записано", прогон(КЛЮЧИ, ["--apply"]).записано, 3);
  сверить("повтор записывает ноль", прогон(КЛЮЧИ, ["--apply"]).записано, 0);
  сверить(
    "неоднозначная пара осталась без ключа",
    await число(sql`select count(*) n from collection where id in (${M.m4}, ${M.m5}) and client_key is null`),
    2,
  );

  // 4. Правка времени: примерка, запись, повтор.
  сверить("к правке", прогон(ВРЕМЯ, ["--dry-run", "--expect=2"]).кПравке, 2);
  const правка = прогон(ВРЕМЯ, ["--apply", "--expect=2"]);
  await запомнитьСобытия();
  сверить("правлено", правка.правлено, 2);
  сверить("суммы до и после совпали", JSON.stringify(правка.суммыДо), JSON.stringify(правка.суммыПосле));
  сверить("сутки не поехали", JSON.stringify(правка.суткиДо), JSON.stringify(правка.суткиПосле));
  прогонОжидаяКод(ВРЕМЯ, ["--apply", "--expect=2"], 3);
  console.log("  ✓ повтор правки отказывает по отметке события");

  // 5. Проверки по базе, а не по отчёту.
  сверить(
    "сдвинулись ровно две строки source='import' из этой фикстуры",
    await число(sql`select count(*) n from collection where id in (${M.m1}, ${M.m2}) and source = 'import'
                     and collected_at > '2026-01-30 01:40:42.626+00'`),
    2,
  );
  сверить(
    "manual_history не тронут",
    await число(sql`select count(*) n from collection where id in (${M.m3}, ${M.m4}, ${M.m5})
                     and collected_at <> '2026-01-30 03:00:00+00' and collected_at <> '2026-01-30 07:46:00+00'`),
    0,
  );
  сверить(
    "`amount IS NULL` осталось NULL",
    await число(sql`select count(*) n from collection where id = ${M.m3} and amount is null`),
    1,
  );
  сверить(
    "записей аудита правки — по одной на строку своей фикстуры",
    await число(sql`select count(*) n from audit_log where action = 'collection.time_corrected' and target in ${sql(СВОИ_СТРОКИ)}`),
    2,
  );
  сверить("отметка события ровно одна", СВОИ_СОБЫТИЯ.size, 1);

  // ── Застава работает и в обратную сторону ──
  await обязанОтказать("на базе с инкассациями смоук отказывается работать", проверитьScratch);

  console.log("\nДымовой прогон инкассаций: ОК.");
} catch (err) {
  console.error(`\nДымовой прогон инкассаций ПРОВАЛЕН: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await убратьЗаСобой().catch((e) => console.error(`уборка не удалась: ${e instanceof Error ? e.message : e}`));
  await sql.end({ timeout: 5 });
}
