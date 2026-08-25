#!/usr/bin/env node
/**
 * Дымовой прогон разового импорта истории склада (П8a) против НАСТОЯЩЕГО Postgres.
 *
 * ЗАЧЕМ. Юнит-тесты импорта работают на заглушке drizzle: она возвращает
 * заготовленный ответ и зеленеет на любом SQL. А весь смысл этого скрипта — в
 * трёх вещах, которых заглушка не исполняет:
 *
 *   · `on conflict (source, ext_id) where ext_id is not null do nothing` —
 *     ЧАСТИЧНЫЙ уникальный индекс. Забудь предикат — и Postgres ответит «no
 *     unique or exclusion constraint matching the ON CONFLICT specification»
 *     на проде, посреди разового шага выкатки;
 *   · идемпотентность: второй `--apply` обязан записать НОЛЬ строк. Проверить
 *     это можно только настоящим уникальным индексом;
 *   · чтение донора из другой схемы (`STOCK_SCHEMA`) — квалификация имён
 *     таблиц живёт в шаблонной строке postgres.js и типами не проверяется.
 *
 * ЧТО ДЕЛАЕТ. Заводит в scratch-БД схему `stock_donor` с пятью минимальными
 * таблицами донора и восемью строками — по одной на каждое правило переноса, —
 * гоняет скрипт `--dry-run`, затем `--apply` ДВАЖДЫ и сверяет числа и по
 * отчёту, и запросами к базе. В конце убирает за собой и схему, и свои строки
 * в mydon: следом в CI идёт `smoke-core.mjs`, и чужой приход в его выборках
 * никому не нужен.
 *
 * Запуск локально (scratch-база, НЕ прод):
 *   createdb p8asmoke_t3
 *   export DATABASE_URL=postgres://localhost/p8asmoke_t3
 *   pnpm --filter @mydon/db build
 *   node packages/db/dist/migrate.js
 *   node packages/db/dist/seed.js && node packages/db/dist/seed-vending.js
 *   node tools/smoke-import.mjs
 *   dropdb p8asmoke_t3
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `postgres` — зависимость @mydon/db, в корне монорепо её нет: резолвим оттуда,
// где она объявлена, а не подкладываем вторую копию ради дымового прогона.
const require = createRequire(path.join(КОРЕНЬ, "packages/db/package.json"));
const postgres = require("postgres");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL не задан — дымовой прогон импорта выполнять негде.");
  process.exit(1);
}

const СХЕМА = "stock_donor";
const СКРИПТ = path.join(КОРЕНЬ, "packages/db/dist/import-stock-history.js");

/** Серийник живого снек-аппарата — донор пишет его с приставкой «C». */
const СЕРИЙНИК = "C2508160376";
/** Канон того же серийника: с ним строка обязана лечь в `vending_refill`. */
const СЕРИЙНИК_КАНОН = "2508160376";
/** ext_id закупки, которая У НАС УЖЕ ЕСТЬ: сверка не должна её дублировать. */
const ЗАКУПКА_БЛИЗНЕЦ = "901";

// `onnotice` глушит болтовню Postgres («drop cascades to 5 other objects»):
// в логе CI она выглядит как ошибка и прячет настоящие строки прогона.
const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

function прогон(флаг) {
  const res = spawnSync("node", [СКРИПТ, флаг], {
    cwd: КОРЕНЬ,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL, STOCK_DATABASE_URL: DATABASE_URL, STOCK_SCHEMA: СХЕМА },
  });
  if (res.status !== 0) {
    throw new Error(`import-stock-history.js ${флаг} → код ${res.status}\n${res.stdout ?? ""}\n${res.stderr ?? ""}`);
  }
  const строка = (res.stdout ?? "").split("\n").find((s) => s.startsWith("ИТОГИ(json): "));
  if (!строка) throw new Error(`в отчёте нет разборной строки итогов:\n${res.stdout}`);
  console.log(res.stdout.trim());
  return JSON.parse(строка.slice("ИТОГИ(json): ".length));
}

function сверить(что, факт, ожидание) {
  const a = JSON.stringify(факт);
  const b = JSON.stringify(ожидание);
  if (a !== b) throw new Error(`${что}: получено ${a}, ожидалось ${b}`);
  console.log(`  ✓ ${что}: ${b}`);
}

async function число(запрос) {
  const [row] = await запрос;
  return Number(row.n);
}

async function завестиДонора() {
  await sql.unsafe(`drop schema if exists ${СХЕМА} cascade`);
  await sql.unsafe(`create schema ${СХЕМА}`);
  // Минимальный слепок донора: только колонки, которые читает импорт.
  await sql.unsafe(`
    create table ${СХЕМА}.products (id serial primary key, name text not null unique);
    create table ${СХЕМА}.machines (id serial primary key, name text not null unique, serial text);
    create table ${СХЕМА}.refills (
      id serial primary key, dt date not null, machine_id int not null references ${СХЕМА}.machines(id),
      product_id int not null references ${СХЕМА}.products(id), qty numeric not null check (qty > 0));
    create table ${СХЕМА}.stock_counts (
      id serial primary key, dt date not null, machine_id int references ${СХЕМА}.machines(id),
      product_id int not null references ${СХЕМА}.products(id), qty numeric not null check (qty >= 0),
      counted_at timestamptz);
    create table ${СХЕМА}.purchases (
      id serial primary key, dt date not null, product_id int not null references ${СХЕМА}.products(id),
      qty numeric not null check (qty > 0), unit_price numeric not null check (unit_price >= 0));
  `);

  // Имена — как они лежат у донора: с HTML-мусором панели и служебной строкой.
  await sql.unsafe(`
    insert into ${СХЕМА}.products (id, name) values
      (1, 'TUC Sour cream'), (2, 'M&amp;Ms'), (3, 'O&#39;zbegim'), (4, 'Недостача (Рустам)');
    insert into ${СХЕМА}.machines (id, name, serial) values
      (1, 'Olma [250816]', '${СЕРИЙНИК}'), (2, 'Снек-аппараты (общие)', null);

    -- 1. залив по живому серийнику → ляжет в vending_refill;
    -- 2. залив на «общий» аппарат без серийника → агрегат, не импортируется.
    insert into ${СХЕМА}.refills (id, dt, machine_id, product_id, qty) values
      (411, '2026-04-22', 1, 1, 6), (412, '2026-04-22', 2, 1, 9);

    -- 3. пересчёт склада; 4. служебная строка; 5. пересчёт ПО АВТОМАТУ (его
    -- отсекает сам SQL импорта); 8. пересчёт с HTML-именем и без counted_at.
    insert into ${СХЕМА}.stock_counts (id, dt, machine_id, product_id, qty, counted_at) values
      (77, '2026-07-14', null, 1, 24, '2026-07-14 18:30+05'),
      (78, '2026-07-14', null, 4, 1, null),
      (79, '2026-07-14', 1, 1, 5, null),
      (80, '2026-08-11', null, 3, 12, null);

    -- 6. близнец уже существующей у нас закупки; 7. новая, с HTML-именем.
    insert into ${СХЕМА}.purchases (id, dt, product_id, qty, unit_price) values
      (${ЗАКУПКА_БЛИЗНЕЦ}, '2025-08-18', 1, 24, 0), (902, '2026-07-13', 2, 6, 8000);
  `);

  // Зеркало закупок «как на проде»: одна из двух донорских строк у нас уже есть.
  await sql`
    insert into purchase (ext_id, dt, product, qty, unit_price, source)
    values (${ЗАКУПКА_БЛИЗНЕЦ}, '2025-08-18', 'TUC Sour cream', '24', '0', 'stock')
    on conflict (source, ext_id) do nothing`;
}

async function убратьЗаСобой() {
  await sql.unsafe(`drop schema if exists ${СХЕМА} cascade`);
  await sql`delete from vending_refill where source = 'stock-import'`;
  await sql`delete from vending_stock_count where source = 'stock-import'`;
  await sql`delete from purchase where source = 'stock' and ext_id in (${ЗАКУПКА_БЛИЗНЕЦ}, '902')`;
  await sql`delete from event where type = 'stock.history.imported'`;
}

try {
  // Канон алиаса `O'zbegim` берём ИЗ БАЗЫ, а не переписываем сюда: смысл
  // проверки в том, что HTML-имя донора доехало до карточки прайса тем же
  // правилом, что у Core, — а не в том, что мы угадали строку сида.
  const [алиас] = await sql`
    select p.name as canon from vending_alias a join vending_product p on p.id = a.product_id
     where a.alias = 'O''zbegim' limit 1`;
  if (!алиас) throw new Error("в базе нет алиаса «O'zbegim» — сначала node packages/db/dist/seed-vending.js");

  await завестиДонора();
  console.log("Фикстурный донор заведён в схеме stock_donor (8 строк истории).\n");

  // ── Примерка: отчёт полный, база нетронута ──
  const примерка = прогон("--dry-run");
  сверить("--dry-run ничего не записал", [примерка.apply, примерка.refills, примерка.stockCounts, примерка.purchasesAdded], [false, 0, 0, 0]);
  сверить(
    "после примерки в базе пусто",
    [
      await число(sql`select count(*) n from vending_refill where source = 'stock-import'`),
      await число(sql`select count(*) n from vending_stock_count where source = 'stock-import'`),
    ],
    [0, 0],
  );

  // ── Перенос ──
  const перенос = прогон("--apply");
  сверить(
    "первый --apply перенёс историю",
    [перенос.refills, перенос.stockCounts, перенос.purchasesAdded],
    [1, 2, 1],
  );
  сверить("список нерешённых имён не зависит от режима", перенос.unresolved, примерка.unresolved);
  сверить(
    "залив лёг с КАНОНИЧЕСКИМ серийником (донор пишет с «C», ключ — без)",
    await sql`select machine_serial, qty, product_name from vending_refill where source = 'stock-import'`.then((rows) =>
      rows.map((r) => [r.machine_serial, Number(r.qty), r.product_name]),
    ),
    [[СЕРИЙНИК_КАНОН, 6, "TUC Sour cream"]],
  );
  сверить(
    "инвентаризации: склад импортирован (служебная и машинная — нет), HTML-имя доехало до карточки через алиас",
    await sql`
      select ext_id, product_name, product_id is not null as linked
        from vending_stock_count where source = 'stock-import' order by ext_id`.then((rows) =>
      rows.map((r) => [r.ext_id, r.product_name, r.linked]),
    ),
    [
      ["77", "TUC Sour cream", false],
      ["80", алиас.canon, true],
    ],
  );
  сверить(
    "закупки: дописана только отсутствующая, имя донора очищено от HTML, но НЕ канонизировано (зеркало хранит написание источника)",
    await sql`
      select ext_id, product from purchase
       where source = 'stock' and ext_id in (${ЗАКУПКА_БЛИЗНЕЦ}, '902') order by ext_id`.then((rows) =>
      rows.map((r) => [r.ext_id, r.product]),
    ),
    [
      [ЗАКУПКА_БЛИЗНЕЦ, "TUC Sour cream"],
      ["902", "M&Ms"],
    ],
  );
  // Отчёт обещает владельцу список имён без карточки — он обязан совпасть с
  // тем, что реально легло с product_id NULL, иначе обещание пустое.
  сверить(
    "«не разрешено N» в отчёте — это ровно те строки, что легли с product_id NULL",
    перенос.unresolved,
    await число(sql`
      select count(distinct product_name) n from (
        select product_name from vending_refill where source = 'stock-import' and product_id is null
        union
        select product_name from vending_stock_count where source = 'stock-import' and product_id is null
      ) x`),
  );

  // ── Повтор: ноль новых строк и НИ ОДНОЙ лишней отметки в журнале ──
  const повтор = прогон("--apply");
  сверить("повторный --apply не записал ничего", [повтор.refills, повтор.stockCounts, повтор.purchasesAdded], [0, 0, 0]);
  сверить(
    "после повтора строк столько же",
    [
      await число(sql`select count(*) n from vending_refill where source = 'stock-import'`),
      await число(sql`select count(*) n from vending_stock_count where source = 'stock-import'`),
      await число(sql`select count(*) n from purchase where source = 'stock' and ext_id in (${ЗАКУПКА_БЛИЗНЕЦ}, '902')`),
    ],
    [1, 2, 2],
  );
  сверить(
    "отметка в журнале одна: событие ставится на факт переноса, а не на факт запуска",
    await число(sql`select count(*) n from event where type = 'stock.history.imported'`),
    1,
  );

  console.log("\nДымовой прогон импорта истории склада: ОК.");
} catch (err) {
  console.error(`\nДымовой прогон импорта истории склада ПРОВАЛЕН: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await убратьЗаСобой().catch((e) => console.error(`уборка не удалась: ${e instanceof Error ? e.message : e}`));
  await sql.end({ timeout: 5 });
}
