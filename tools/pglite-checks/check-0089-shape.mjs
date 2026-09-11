// Срез A3, застава формы 0089 на настоящем SQL.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЦЕНАРИЙ. `IF NOT EXISTS` защищает от повторного прогона
// (автодеплой применяет миграции без отката), но платит за это молчанием: если
// колонка или индекс УЖЕ есть ЛЮБОЙ ДРУГОЙ формы, оператор пропускается без
// ошибки. Для этого проекта правки через редактор Supabase не гипотетика.
// Опыт, с которого начался пункт M-2 круга починок 1, на базе уровня 0088:
//
//   alter table attachment add column tags text;   → 0089 применялась БЕЗ ОШИБКИ,
//   журнал говорил «90 записей», колонка оставалась `text NULL` без default,
//   и читатель получал в tags NULL там, где тип обещает string[] — ровно ту
//   null-ветку, которую комментарий схемы обещает не разбирать.
//
// Здесь воспроизводятся ТРИ вида расхождения (чужой тип, чужой default, чужая
// форма индекса) и проверяется, что каждое падает ГРОМКО: миграция не
// применяется, журнал 0089 не получает, строки полевого контура целы, а
// сообщение называет расхождение. Проверяется и обратное: как только
// расхождение снято руками, та же миграция применяется без правок.
//
// Где прогонялось (08.09.2026): pglite 17.5 и локальный кластер PostgreSQL 15.14
// через CHECKS_DATABASE_URL. postgres:17 — за CI (Docker в этой среде не отвечает).
import assert from "node:assert/strict";
import { migratedDb, migrationsUpto, ENGINE } from "./run-migrations.mjs";

// Докат — ровно до 0089: сценарий проверяет её рецепт отката («удалить последнюю
// запись журнала»), а он верен, только пока 0089 последняя. С появлением 0090
// (волна 2б) докат «до конца» делал последней чужую запись, и откат снимал 0090.
const ДО_0089 = migrationsUpto(89);

const OWNER = "00000000-0000-0000-0000-00000000a301";
const ФОТО = "00000000-0000-0000-0000-00000000a389";

const { client, applyMigrations } = await migratedDb({ upto: 88 });
const run = async (sql) => [...(await client.query(sql)).rows];
const форма = async () =>
  (
    await run(
      `select column_name, udt_name, is_nullable
         from information_schema.columns
        where table_name = 'attachment' and column_name in ('title', 'domain', 'tags')
        order by column_name`,
    )
  ).map((c) => [c.column_name, c.udt_name, c.is_nullable]);
const записей = async () => (await run(`select count(*)::int as n from "drizzle"."__drizzle_migrations"`))[0].n;
const строк = async () => (await run(`select count(*)::int as n from attachment`))[0].n;

// Строка полевого контура: она должна пережить каждую неудачную попытку.
await run(
  `insert into attachment (id, owner_type, owner_id, kind, storage_key, created_by)
   values ('${ФОТО}', 'entity', '${OWNER}', 'photo', 'k/a389.jpg', 'staff:1')`,
);
const журналДо = await записей();
assert.equal(журналДо, 89, "база должна стоять на 0088 (0000…0088 = 89 записей)");

const ОПЫТЫ = [
  {
    имя: "колонка чужого типа: tags text вместо jsonb",
    дрейф: `alter table attachment add column tags text`,
    снять: `alter table attachment drop column tags`,
    // Сообщение обязано назвать колонку, её фактическую форму и ожидаемую:
    // «миграция упала» без этого не говорит, что руками поправить.
    ждём: [/0089/, /tags text NULL/, /ожидалось title text NULL/],
  },
  {
    имя: "колонка с чужим default: tags jsonb default '{}'",
    дрейф: `alter table attachment add column tags jsonb not null default '{}'::jsonb`,
    снять: `alter table attachment drop column tags`,
    ждём: [/0089/, /attachment\.tags/, /DEFAULT/],
  },
  {
    имя: "индекс чужой формы: created_at DESC NULLS LAST",
    дрейф: `create index attachment_kind_created_idx on attachment using btree (kind, created_at desc nulls last)`,
    снять: `drop index attachment_kind_created_idx`,
    ждём: [/0089/, /attachment_kind_created_idx/, /NULLS LAST/],
  },
];

for (const опыт of ОПЫТЫ) {
  await run(опыт.дрейф);
  await assert.rejects(
    applyMigrations(ДО_0089),
    (e) => {
      const текст = `${e?.message ?? ""} ${e?.cause?.message ?? ""} ${e?.cause?.hint ?? ""}`;
      for (const re of опыт.ждём) assert.match(текст, re, `${опыт.имя}: в сообщении нет ${re}`);
      return true;
    },
    `${опыт.имя}: 0089 применилась молча — IF NOT EXISTS промолчал`,
  );
  // Мигратор drizzle применяет ожидающие файлы в ОДНОЙ транзакции, поэтому
  // падение заставы обязано откатить и запись журнала: иначе следующий деплой
  // посчитает 0089 применённой и расхождение останется навсегда.
  assert.equal(await записей(), журналДо, `${опыт.имя}: журнал получил 0089, хотя миграция упала`);
  assert.equal(await строк(), 1, `${опыт.имя}: неудачная миграция потеряла строки полевого контура`);
  await run(опыт.снять);
  assert.deepEqual(await форма(), [], `${опыт.имя}: после снятия дрейфа база не вернулась на 0088`);
}

// Расхождений нет — та же миграция применяется без единой правки.
await applyMigrations(ДО_0089);
assert.deepEqual(
  await форма(),
  [
    ["domain", "domain", "YES"],
    ["tags", "jsonb", "NO"],
    ["title", "text", "YES"],
  ],
  "на чистой базе 0089 не применилась",
);
assert.equal(await записей(), 90, "журнал мигратора: 0000…0089 = 90 записей");
// Повторный прогон на УЖЕ применённой 0089: заставы обязаны молчать, иначе они
// сами повесили бы автодеплой на второй попытке.
await applyMigrations(ДО_0089);
assert.equal(await записей(), 90, "повторный прогон задвоил запись журнала");

console.log(
  `застава формы 0089 (${ENGINE}): три вида расхождения роняют миграцию громко, журнал 0089 не получает, строки целы; на чистой базе и на повторном прогоне заставы молчат`,
);
await client.close();
