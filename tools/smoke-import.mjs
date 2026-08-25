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
 * ЭТОТ ПРОГОН ПИШЕТ В БАЗУ — И ПОТОМУ ОТКАЗЫВАЕТСЯ РАБОТАТЬ НЕ НА SCRATCH.
 * Рядом, в отчёте выкатки, операторов учат `export DATABASE_URL=…`; один такой
 * экспорт с боевой строкой — и прогон снёс бы 107 перенесённых заливов, 460
 * инвентаризаций и единственную отметку R-P8a-5, а в прод завёл фикстурную
 * схему. Пока донор жив, это лечилось бы повторным `--apply`; после П8
 * (гашения донора) — уже нет. Поэтому ТРИ заставы до первой записи:
 *   1. явное согласие: `SMOKE_SCRATCH=1` в окружении ЛИБО имя базы со словом
 *      `smoke` (`p8asmoke_fw`). Эту заставу не обойти SSH-туннелем на
 *      `localhost:5432`, которым обходились две прежние (R-FW-S4);
 *   2. хост `DATABASE_URL` обязан быть локальным;
 *   3. в базе не должно быть НИ ОДНОЙ строки импорта, ни одной его отметки и
 *      ни одной закупки с фикстурными `ext_id`.
 * И уборка сносит только СВОИ строки — по точным ключам фикстуры и по id
 * события, которое этот прогон своими глазами увидел появившимся.
 *
 * НИ ОДНО СООБЩЕНИЕ НЕ ПЕЧАТАЕТ СТРОКУ ПОДКЛЮЧЕНИЯ (R-FW-S1). Застава
 * срабатывает ровно тогда, когда оператор экспортировал БОЕВОЙ `DATABASE_URL`,
 * — и пароль из неё уехал бы в stderr, в скроллбек и в лог CI. Наружу идёт
 * только `host`, а вывод дочернего процесса чистится `безСекретов`.
 *
 * ЧТО ДЕЛАЕТ. Заводит в scratch-БД схему `stock_donor` с шестью минимальными
 * таблицами донора и строками-образцами — по одной на каждое правило переноса
 * и на каждую заставу годности, — гоняет скрипт `--dry-run`, затем `--apply`
 * ДВАЖДЫ и сверяет числа и по отчёту, и запросами к базе. В конце убирает за
 * собой: следом в CI идёт `smoke-core.mjs`, и чужой приход в его выборках
 * никому не нужен.
 *
 * Запуск локально (scratch-база, НЕ прод):
 *   createdb p8asmoke_fw
 *   export DATABASE_URL=postgres://localhost/p8asmoke_fw
 *   pnpm --filter @mydon/db build
 *   node packages/db/dist/migrate.js
 *   node packages/db/dist/seed.js && node packages/db/dist/seed-vending.js
 *   SMOKE_SCRATCH=1 node tools/smoke-import.mjs
 *   dropdb p8asmoke_fw
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

/**
 * Мост `ourvend_name` (R-FW-P1): имя донорской карточки, которого в прайсе
 * mydon нет вовсе, и её же `ourvend_name` — точный алиас владельца из сида.
 * На проде так находят карточку 13 имён (228 строк из 567).
 */
const МОСТ_ИМЯ = "Coca Cola CAN 0.25";
const МОСТ_АЛИАС = "CocaCola Classic CAN 250ml";

/** Ровно те ключи, которые может создать ЭТА фикстура, — по ним и убираем. */
const СВОИ_ЗАЛИВЫ = ["stock:refill:411", "stock:refill:412"];
const СВОИ_ПЕРЕСЧЁТЫ = ["77", "78", "79", "80", "81", "82", "83", "84"];
/** Застава смотрит на них ДО старта: уборка закупок иначе не покрыта ничем. */
const СВОИ_ЗАКУПКИ = [ЗАКУПКА_БЛИЗНЕЦ, "902", "903"];
/** id событий импорта, появившихся ПРИ ЭТОМ прогоне (до него их было 0). */
const СВОИ_СОБЫТИЯ = new Set();

/** Заводили ли мы фикстуру: не заводили — и убирать нечего. */
let завёл = false;

/**
 * Локальный ли хост базы. Ремень поверх подтяжек: даже пустая база на боевом
 * сервере — не место для прогона, который создаёт схемы и пишет строки.
 */
function безопасныйХост(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  // Пустой хост — подключение через unix-сокет, то есть та же машина.
  return ["", "localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

/**
 * Scratch ли база ПО ИМЕНИ. Единственная застава, которую не обходит
 * `ssh -L 5432:прод` + `DATABASE_URL=postgres://localhost/mydon`: хост тогда
 * локальный, строк импорта до первого прогона ноль, а имя базы — боевое.
 */
function scratchПоИмени(url) {
  try {
    return /smoke/i.test(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
}

/** Хост базы — ЕДИНСТВЕННОЕ, что можно печатать наружу: в URL живёт пароль. */
function хост(url) {
  try {
    return new URL(url).host || "unix-сокет";
  } catch {
    return "неразбираемый URL";
  }
}

/** Строка подключения в чужом тексте (вывод дочернего процесса) → без пароля. */
const СТРОКА_ПОДКЛЮЧЕНИЯ = /postgres(?:ql)?:\/\/\S+/gi;
function безСекретов(текст) {
  return String(текст ?? "").replace(СТРОКА_ПОДКЛЮЧЕНИЯ, "postgres://***");
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

function прогон(флаг) {
  const res = spawnSync("node", [СКРИПТ, флаг], {
    cwd: КОРЕНЬ,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL, STOCK_DATABASE_URL: DATABASE_URL, STOCK_SCHEMA: СХЕМА },
  });
  // Вывод дочернего процесса — чужой текст: ошибка postgres.js вполне может
  // принести в нём строку подключения целиком (R-FW-S1).
  const вывод = безСекретов(res.stdout);
  if (res.status !== 0) {
    throw new Error(`import-stock-history.js ${флаг} → код ${res.status}\n${вывод}\n${безСекретов(res.stderr)}`);
  }
  const строка = вывод.split("\n").find((s) => s.startsWith("ИТОГИ(json): "));
  if (!строка) throw new Error(`в отчёте нет разборной строки итогов:\n${вывод}`);
  console.log(вывод.trim());
  // Текст отчёта едет вместе с числами: причины отказа живут только в нём.
  return { ...JSON.parse(строка.slice("ИТОГИ(json): ".length)), текст: вывод };
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
  console.log(`  ✓ ${что} → «${ошибка.message}»`);
}

async function число(запрос) {
  const [row] = await запрос;
  return Number(row.n);
}

/**
 * Застава: база обязана быть пустой по части импорта.
 *
 * Проверяется РОВНО то, что этот прогон создаёт и потом удаляет: строки
 * `source='stock-import'` в обеих таблицах и отметки `stock.history.imported`.
 * Есть хоть одна — это не scratch, а чья-то история, и трогать её нельзя.
 */
async function проверитьScratch() {
  const [заливов, пересчётов, отметок, закупок] = await Promise.all([
    число(sql`select count(*) n from vending_refill where source = 'stock-import'`),
    число(sql`select count(*) n from vending_stock_count where source = 'stock-import'`),
    число(sql`select count(*) n from event where type = 'stock.history.imported'`),
    // Уборка сносит закупки по ext_id 901/902/903 — значит и застава обязана
    // их видеть: у донора max `purchases.id` = 381, реальной строкой зеркала
    // эти ext_id быть не могут, но проверяет это застава, а не наша память.
    число(sql`select count(*) n from purchase where source = 'stock' and ext_id in ${sql(СВОИ_ЗАКУПКИ)}`),
  ]);
  if (заливов + пересчётов + отметок + закупок > 0) {
    throw new Error(
      `база уже содержит импорт — смоук только на scratch (заливов ${заливов}, инвентаризаций ${пересчётов}, ` +
        `отметок ${отметок}, закупок с фикстурными ext_id ${закупок})`,
    );
  }
}

/** id событий импорта, которые видны сейчас, — запоминаем как СВОИ. */
async function запомнитьСобытия() {
  for (const r of await sql`select id from event where type = 'stock.history.imported'`) СВОИ_СОБЫТИЯ.add(r.id);
}

async function завестиДонора() {
  await sql.unsafe(`drop schema if exists ${СХЕМА} cascade`);
  await sql.unsafe(`create schema ${СХЕМА}`);
  завёл = true;
  // Минимальный слепок донора: только колонки, которые читает импорт.
  // `product_id` НЕ `not null` намеренно: карточку импорт тянет LEFT JOIN'ом,
  // и строка без товара обязана попасть в отчёт причиной, а не исчезнуть.
  await sql.unsafe(`
    create table ${СХЕМА}.products (
      id serial primary key, name text not null unique, unit text not null default 'шт', ourvend_name text);
    create table ${СХЕМА}.machines (id serial primary key, name text not null unique, serial text);
    create table ${СХЕМА}.locations (id serial primary key, name text not null unique, kind text not null);
    create table ${СХЕМА}.refills (
      id serial primary key, dt date not null, machine_id int not null references ${СХЕМА}.machines(id),
      product_id int references ${СХЕМА}.products(id), qty numeric not null check (qty > 0));
    create table ${СХЕМА}.stock_counts (
      id serial primary key, dt date not null, machine_id int references ${СХЕМА}.machines(id),
      location_id int references ${СХЕМА}.locations(id),
      product_id int references ${СХЕМА}.products(id), qty numeric not null check (qty >= 0),
      counted_at timestamptz);
    create table ${СХЕМА}.purchases (
      id serial primary key, dt date not null, product_id int references ${СХЕМА}.products(id),
      qty numeric not null check (qty > 0), unit_price numeric not null check (unit_price >= 0),
      total numeric generated always as (qty * unit_price) stored, note text);
  `);

  // Имена — как они лежат у донора: с HTML-мусором панели и служебной строкой.
  // `&#0;` — не выдумка: панель кодирует что угодно, а Postgres на U+0000 в
  // тексте отвечает «invalid byte sequence» и роняет ПАЧКУ (R-FW-S2). В самой
  // фикстуре его нет — есть его КОД, который разворачивает уже импорт.
  await sql.unsafe(`
    insert into ${СХЕМА}.products (id, name, ourvend_name) values
      (1, 'TUC Sour cream', null), (2, 'M&amp;Ms', null), (3, 'O&#39;zbegim', null),
      (4, 'Недостача (Рустам)', null),
      (5, '${МОСТ_ИМЯ}', '${МОСТ_АЛИАС}'),
      (6, 'TUC&#0; Sour cream', null),
      (7, 'M&amp;amp;Ms', null);
    insert into ${СХЕМА}.machines (id, name, serial) values
      (1, 'Olma [250816]', '${СЕРИЙНИК}'), (2, 'Снек-аппараты (общие)', null);
    insert into ${СХЕМА}.locations (id, name, kind) values
      (1, 'Склад (основной)', 'main'), (2, 'Холодильник', 'storage');

    -- 1. залив по живому серийнику → ляжет в vending_refill;
    -- 2. залив на «общий» аппарат без серийника → агрегат, не импортируется.
    insert into ${СХЕМА}.refills (id, dt, machine_id, product_id, qty) values
      (411, '2026-04-22', 1, 1, 6), (412, '2026-04-22', 2, 1, 9);

    -- 3. пересчёт основного склада; 4. служебная строка; 5. пересчёт ПО
    -- АВТОМАТУ (его отсекает сам SQL импорта); 6. HTML-имя без counted_at;
    -- 7. ДРУГОЕ место, «Холодильник», имя товара приходит мостом ourvend_name;
    -- 8. управляющий символ в имени; 9. двойное кодирование (&amp;amp; это
    -- &amp;, а не &); 10. строка без карточки товара.
    insert into ${СХЕМА}.stock_counts (id, dt, machine_id, location_id, product_id, qty, counted_at) values
      (77, '2026-07-14', null, 1, 1, 24, '2026-07-14 18:30+05'),
      (78, '2026-07-14', null, 1, 4, 1, null),
      (79, '2026-07-14', 1, null, 1, 5, null),
      (80, '2026-08-11', null, 1, 3, 12, null),
      (81, '2026-07-05', null, 2, 5, 7, null),
      (82, '2026-07-05', null, 1, 6, 3, null),
      (83, '2026-07-05', null, 1, 7, 4, null),
      (84, '2026-07-05', null, 1, null, 2, null);

    -- 11. близнец уже существующей у нас закупки; 12. новая, с HTML-именем;
    -- 13. закупка без карточки товара — дописывать её нечем.
    insert into ${СХЕМА}.purchases (id, dt, product_id, qty, unit_price, note) values
      (${ЗАКУПКА_БЛИЗНЕЦ}, '2025-08-18', 1, 24, 0, 'импорт:vendhub'),
      (902, '2026-07-13', 2, 6, 8000, 'импорт:закупки'),
      (903, '2026-07-13', null, 3, 1000, 'импорт:закупки');
  `);

  // Зеркало закупок «как на проде»: одна из двух донорских строк у нас уже есть.
  await sql`
    insert into purchase (ext_id, dt, product, qty, unit_price, source)
    values (${ЗАКУПКА_БЛИЗНЕЦ}, '2025-08-18', 'TUC Sour cream', '24', '0', 'stock')
    on conflict (source, ext_id) do nothing`;
}

/**
 * Убираем ТОЛЬКО своё: точные ключи фикстуры и id событий, которые этот прогон
 * увидел появившимися. `delete … where source='stock-import'` здесь был бы
 * ровно тем оружием, от которого стоят заставы выше.
 */
async function убратьЗаСобой() {
  if (!завёл) return;
  // Ещё раз добираем id событий: прогон мог упасть между записью и
  // `запомнитьСобытия`. Это по-прежнему «только своё» — застава выше доказала,
  // что до старта событий этого типа в базе не было НИ ОДНОГО.
  await запомнитьСобытия().catch(() => {});
  await sql.unsafe(`drop schema if exists ${СХЕМА} cascade`);
  await sql`delete from vending_refill where source = 'stock-import' and client_key in ${sql(СВОИ_ЗАЛИВЫ)}`;
  await sql`delete from vending_stock_count where source = 'stock-import' and ext_id in ${sql(СВОИ_ПЕРЕСЧЁТЫ)}`;
  await sql`delete from purchase where source = 'stock' and ext_id in ${sql(СВОИ_ЗАКУПКИ)}`;
  if (СВОИ_СОБЫТИЯ.size > 0) await sql`delete from event where id in ${sql([...СВОИ_СОБЫТИЯ])}`;
}

try {
  // ── Заставы до первой записи ──
  // Ни одно сообщение ниже не несёт строку подключения: в ней пароль (R-FW-S1).
  if (process.env.SMOKE_SCRATCH !== "1" && !scratchПоИмени(DATABASE_URL)) {
    throw new Error(
      `смоук пишет в базу и потому требует ЯВНОГО scratch: SMOKE_SCRATCH=1 либо имя базы со словом «smoke» ` +
        `(хост ${хост(DATABASE_URL)}). Так закрыт SSH-туннель на localhost:5432, которым обходились заставы по хосту.`,
    );
  }
  if (!безопасныйХост(DATABASE_URL)) {
    throw new Error(`DATABASE_URL смотрит не на локальную базу — смоук только на scratch, он ПИШЕТ (хост ${хост(DATABASE_URL)})`);
  }
  сверить("явное согласие на запись есть", process.env.SMOKE_SCRATCH === "1" || scratchПоИмени(DATABASE_URL), true);
  // Адреса в проверках — из документационного диапазона RFC 5737: боевым IP в
  // репозитории не место, а застава от этого не слабеет.
  сверить("боевое имя базы без SMOKE_SCRATCH отвергнуто", scratchПоИмени("postgres://smoke:pw@localhost:5432/mydon"), false);
  сверить("scratch опознан по имени базы", scratchПоИмени("postgres://smoke:pw@localhost:5432/p8asmoke_fw"), true);
  сверить("хост базы локальный", безопасныйХост(DATABASE_URL), true);
  сверить("удалённый хост был бы отвергнут", безопасныйХост("postgres://smoke:pw@203.0.113.10:5432/smokedb"), false);
  сверить("хост с опечаткой тоже отвергнут", безопасныйХост("не-адрес"), false);
  сверить(
    "пароль не уедет в лог: наружу идёт только host",
    [хост("postgres://smoke:s3cret@203.0.113.10:5432/smokedb"), безСекретов("упало на postgres://smoke:s3cret@db/x")],
    ["203.0.113.10:5432", "упало на postgres://***"],
  );
  await проверитьScratch();

  // Канон алиаса `O'zbegim` берём ИЗ БАЗЫ, а не переписываем сюда: смысл
  // проверки в том, что HTML-имя донора доехало до карточки прайса тем же
  // правилом, что у Core, — а не в том, что мы угадали строку сида.
  const [алиас] = await sql`
    select p.name as canon from vending_alias a join vending_product p on p.id = a.product_id
     where a.alias = 'O''zbegim' limit 1`;
  if (!алиас) throw new Error("в базе нет алиаса «O'zbegim» — сначала node packages/db/dist/seed-vending.js");

  // Мост `ourvend_name`: канон берём из базы по той же причине, а заодно
  // доказываем, что САМО донорское имя карточки не имеет — иначе проверка
  // моста была бы проверкой обычного резолва.
  const [мост] = await sql`
    select p.name as canon from vending_alias a join vending_product p on p.id = a.product_id
     where a.alias = ${МОСТ_АЛИАС} limit 1`;
  if (!мост) throw new Error(`в базе нет алиаса «${МОСТ_АЛИАС}» — сначала node packages/db/dist/seed-vending.js`);
  const [своё] = await sql`
    select 1 as есть from vending_product p where lower(p.name) = lower(${МОСТ_ИМЯ})
     union all
    select 1 from vending_alias a where lower(a.alias) = lower(${МОСТ_ИМЯ}) limit 1`;
  if (своё) throw new Error(`«${МОСТ_ИМЯ}» есть в каталоге mydon — фикстура моста ourvend_name ничего не доказывает`);

  await завестиДонора();
  console.log("Фикстурный донор заведён в схеме stock_donor (13 строк истории).\n");

  // ── Примерка: отчёт полный, база нетронута ──
  const примерка = прогон("--dry-run");
  сверить(
    "--dry-run ничего не записал, но сказал, ЧТО запишет",
    [примерка.apply, примерка.refills, примерка.stockCounts, примерка.purchasesAdded, примерка.toWrite],
    [false, 0, 0, 0, { refills: 1, stockCounts: 4, purchasesAdded: 1 }],
  );
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
  await запомнитьСобытия();
  сверить("первый --apply перенёс историю", [перенос.refills, перенос.stockCounts, перенос.purchasesAdded], [1, 4, 1]);
  сверить(
    "примерка обещала ровно то, что записала запись",
    примерка.toWrite,
    { refills: перенос.refills, stockCounts: перенос.stockCounts, purchasesAdded: перенос.purchasesAdded },
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
    "инвентаризации: склад импортирован (служебная, машинная и негодные — нет), HTML-имя доехало до карточки через алиас, мост ourvend_name сработал, место — в note",
    await sql`
      select ext_id, product_name, product_id is not null as linked, note
        from vending_stock_count where source = 'stock-import' order by ext_id`.then((rows) =>
      rows.map((r) => [r.ext_id, r.product_name, r.linked, r.note]),
    ),
    [
      ["77", "TUC Sour cream", false, "импорт истории mydon-stock · место: Склад (основной)"],
      ["80", алиас.canon, true, "импорт истории mydon-stock · место: Склад (основной)"],
      // Мост: донорского имени в прайсе нет, а `ourvend_name` — точный алиас.
      ["81", мост.canon, true, "импорт истории mydon-stock · место: Холодильник"],
      // Двойное кодирование: `&amp;amp;` — это `&amp;`, и один проход это знает.
      ["83", "M&amp;Ms", false, "импорт истории mydon-stock · место: Склад (основной)"],
    ],
  );
  сверить(
    "враждебные строки донора отложены ПОИМЁННО, а не уронили пачку (R-FW-S2)",
    [
      /управляющие символы в имени 1/.test(перенос.текст),
      /строка донора без карточки товара 1/.test(перенос.текст),
      /Закупки, которые дописать нельзя \(1\)/.test(перенос.текст),
    ],
    [true, true, true],
  );
  сверить(
    "негодная закупка в зеркало не поехала",
    await число(sql`select count(*) n from purchase where source = 'stock' and ext_id = '903'`),
    0,
  );
  сверить(
    "закупка дописана НЕОТЛИЧИМО от соседей зеркала: unit, note и GENERATED-total донора, имя без HTML и без канонизации",
    await sql`
      select ext_id, product, unit, total::text, note from purchase
       where source = 'stock' and ext_id = '902'`.then((rows) => rows.map((r) => [r.ext_id, r.product, r.unit, r.total, r.note])),
    [["902", "M&Ms", "шт", "48000.00", "импорт:закупки"]],
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

  // ── Застава работает и в обратную сторону ──
  await обязанОтказать("на базе с импортом смоук отказывается работать", проверитьScratch);

  // ── Повтор: ноль новых строк и НИ ОДНОЙ лишней отметки в журнале ──
  const повтор = прогон("--apply");
  await запомнитьСобытия();
  сверить("повторный --apply не записал ничего", [повтор.refills, повтор.stockCounts, повтор.purchasesAdded], [0, 0, 0]);
  // Заливы и пересчёты остаются «годными к записи» и на повторе: их
  // идемпотентность держит уникальный ключ на вставке, а не предварительный
  // взгляд в базу. У закупок наоборот — сверка СМОТРИТ в зеркало, и как только
  // строка в нём появилась, дописывать больше нечего. Разные механизмы, и
  // отчёт обязан показывать именно их, а не усреднённое «к записи».
  сверить(
    "повтор: заливы и пересчёты всё ещё годны и просто уже лежат, а закупкам дописывать нечего",
    повтор.toWrite,
    { refills: 1, stockCounts: 4, purchasesAdded: 0 },
  );
  сверить(
    "после повтора строк столько же",
    [
      await число(sql`select count(*) n from vending_refill where source = 'stock-import'`),
      await число(sql`select count(*) n from vending_stock_count where source = 'stock-import'`),
      await число(sql`select count(*) n from purchase where source = 'stock' and ext_id in ${sql(СВОИ_ЗАКУПКИ)}`),
    ],
    [1, 4, 2],
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
