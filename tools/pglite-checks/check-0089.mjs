// Срез A3, миграция 0089 на настоящем SQL: 0088 → строка полевого контура → 0089 →
// строка цела, колонки с честными значениями → откат из комментария миграции →
// колонок нет, строки на месте → повторный прогон 0089 (IF NOT EXISTS) применяется заново.
// Движок — pglite локально, сервис postgres:17 в CI (см. run-migrations.mjs).
// Где ЭТОТ файл действительно прогоняли (08.09.2026): pglite 17.5 и локальный
// кластер PostgreSQL 15.14 через CHECKS_DATABASE_URL. postgres:17 в докере не
// поднимался — Docker в этой среде не отвечает (`timeout 12 docker info` → 124);
// на нём файл проверит CI. Прогон на настоящем сервере обязателен и не
// заменяется pglite: именно он поймал сравнение сырого Result драйвера с []
// (см. README, «сырую выдачу драйвера нельзя отдавать в deepEqual»).
import assert from "node:assert/strict";
import { migratedDb, migrationsUpto, ENGINE } from "./run-migrations.mjs";

// Докат — ровно до 0089: сценарий проверяет её рецепт отката («удалить последнюю
// запись журнала»), а он верен, только пока 0089 последняя. С появлением 0090
// (волна 2б) докат «до конца» делал последней чужую запись, и откат снимал 0090.
const ДО_0089 = migrationsUpto(89);

const OWNER = "00000000-0000-0000-0000-00000000a301";
const ФОТО = "00000000-0000-0000-0000-00000000a389";
const ДОК = "00000000-0000-0000-0000-00000000a390";

const { client, applyMigrations } = await migratedDb({ upto: 88 });
const run = async (sql) => (await client.query(sql)).rows;
const колонки = async () =>
  run(
    `select column_name, udt_name, is_nullable, column_default
       from information_schema.columns
      where table_name = 'attachment' and column_name in ('title', 'domain', 'tags')
      order by column_name`,
  );

// Строка полевого контура ДО 0089: фото карточки, без названия и направления.
await run(
  `insert into attachment (id, owner_type, owner_id, kind, storage_key, mime, bytes, created_by)
   values ('${ФОТО}', 'entity', '${OWNER}', 'photo', 'k/a389.jpg', 'image/jpeg', 100, 'staff:1')`,
);
// Копия массива, а не сам результат: в режиме CHECKS_DATABASE_URL сюда приходит
// сырой результат драйвера postgres-js — `class Result extends Array`, — а
// deepEqual из node:assert/strict сравнивает ещё и ПРОТОТИПЫ, поэтому пустой
// Result не равен []. Соседние сценарии этого не ловят: они сравнивают с []
// выдачу drizzle-СЕРВИСА, то есть обычный массив.
assert.deepEqual([...(await колонки())], [], "на 0088 новых колонок ещё нет");

await applyMigrations(ДО_0089);

let cols = await колонки();
assert.deepEqual(
  cols.map((c) => [c.column_name, c.udt_name, c.is_nullable]),
  [
    ["domain", "domain", "YES"],
    ["tags", "jsonb", "NO"],
    ["title", "text", "YES"],
  ],
  "типы и nullable трёх колонок",
);
assert.match(String(cols.find((c) => c.column_name === "tags").column_default), /'\[\]'::jsonb/);

// Старая строка цела и читается без null-веток: tags = [] от DEFAULT, title/domain NULL.
const [старая] = await run(
  `select title, domain, tags::text as tags, storage_key from attachment where id = '${ФОТО}'`,
);
// Сначала — что строка вообще нашлась: без этой проверки мутация «0089 чистит
// таблицу» валила сценарий TypeError'ом по `старая.title`, то есть красный был,
// а диагностики не было.
assert.ok(старая, "строка полевого контура исчезла — 0089 тронула существующие данные");
assert.equal(старая.title, null);
assert.equal(старая.domain, null);
assert.equal(старая.tags, "[]");
assert.equal(старая.storage_key, "k/a389.jpg");

// Новая строка-артефакт: enum принимает значения money_flow, метки пишутся; чужое значение отвергается.
await run(
  `insert into attachment (id, owner_type, owner_id, kind, storage_key, title, domain, tags)
   values ('${ДОК}', 'person', '${OWNER}', 'doc', 'k/a390.docx', 'Дебиторка GLOBERENT за август', 'globerent', '["bot"]'::jsonb)`,
);
await assert.rejects(
  run(
    `insert into attachment (id, owner_type, owner_id, kind, storage_key, domain)
     values ('00000000-0000-0000-0000-00000000a391', 'person', '${OWNER}', 'doc', 'k/a391', 'nope')`,
  ),
  /invalid input value for enum domain/,
);
const [док] = await run(`select title, domain, tags::text as tags from attachment where id = '${ДОК}'`);
assert.deepEqual([док.title, док.domain, док.tags], ["Дебиторка GLOBERENT за август", "globerent", '["bot"]']);

// Индекс есть, не уникальный, по (kind, created_at DESC NULLS FIRST).
const [idx] = await run(
  `select indexdef from pg_indexes where tablename = 'attachment' and indexname = 'attachment_kind_created_idx'`,
);
assert.ok(idx, "индекса attachment_kind_created_idx нет");
// Порядок NULL в выводе НЕ ПЕЧАТАЕТСЯ, и это признак верной формы: для
// DESC-колонки умолчание — NULLS FIRST, а pg_get_indexdef() опускает то, что
// и так по умолчанию. То есть «created_at DESC» без хвоста = NULLS FIRST =
// путь сортировки витрины (`desc(createdAt), desc(id)`). Прежняя форма с
// .desc() без .nullsFirst() печаталась как «DESC NULLS LAST» — и половина
// индекса была мертва: планировщик брал равенство по kind и сортировал
// заново. Измерено 08.09.2026 на pglite 17.5 и PostgreSQL 15.14 — вывод
// одинаковый на обоих движках.
assert.match(
  idx.indexdef,
  /^CREATE INDEX attachment_kind_created_idx ON public\.attachment USING btree \(kind, created_at DESC\)$/,
);

// Откат — ровно операторы из заголовка миграции 0089.
await run(`DROP INDEX IF EXISTS "attachment_kind_created_idx"`);
await run(`ALTER TABLE "attachment" DROP COLUMN IF EXISTS "tags"`);
await run(`ALTER TABLE "attachment" DROP COLUMN IF EXISTS "domain"`);
await run(`ALTER TABLE "attachment" DROP COLUMN IF EXISTS "title"`);
// Удаляется САМАЯ ПОЗДНЯЯ запись журнала — и это не сокращение записи, а
// условие, при котором рецепт откатa вообще работает (круг починок 3, C-2).
// Мигратор drizzle сравнивает файлы с ОДНОЙ последней строкой
// (`order by created_at desc limit 1` в pg-core/dialect.js), поэтому пока
// 0089 последняя, удаление её строки возвращает миграцию в очередь. Появится
// 0090 — эта же строка окажется в СЕРЕДИНЕ колонки, её удаление ничего не
// вернёт, и сценарий обязан будет измениться вместе с рецептом в заголовке
// миграции. Проверка ниже (`= 90 записей`) держит это соответствие числом.
await run(
  `DELETE FROM "drizzle"."__drizzle_migrations"
    WHERE "created_at" = (select max("created_at") from "drizzle"."__drizzle_migrations")`,
);
assert.deepEqual([...(await колонки())], [], "после отката колонок быть не должно");
const [n] = await run(`select count(*)::int as n from attachment`);
assert.equal(n.n, 2, "откат не удаляет строк — файлы остаются");

// Повторный прогон: IF NOT EXISTS + журнал мигратора без 0089 → применяется заново без ошибок.
await applyMigrations(ДО_0089);
cols = await колонки();
assert.equal(cols.length, 3, "после повторного прогона колонки снова на месте");
const [idx2] = await run(
  `select 1 from pg_indexes where tablename = 'attachment' and indexname = 'attachment_kind_created_idx'`,
);
assert.ok(idx2, "после повторного прогона индекс снова на месте");
const [m] = await run(`select count(*)::int as n from "drizzle"."__drizzle_migrations"`);
assert.equal(m.n, 90, "журнал мигратора: 0000…0089 = 90 записей");

console.log(`0088 → 0089 → откат → 0089 (${ENGINE}): attachment расширена, старые строки целы, откат обратим`);
await client.close();
