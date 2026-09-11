-- Волна 2б «Место принадлежит контрагенту» (М-1, М-2, М-11;
-- docs/SPEC_KONTRAGENT_MESTO_AVTOMAT.md, docs/PLAN_VNEDRENIE_2026-09-11.md).
--
-- Что добавляется и почему.
--   place_card — тонкая карточка места, тем же приёмом, что machine_card:
--     ссылку «место → контрагент» надо соединять запросом («все места KIUT»),
--     а строка в attrs без внешнего ключа молча пережила бы удаление
--     контрагента. Вид места остаётся entity.type (place-kinds.ts).
--   contractor_id — необязателен ПО СХЕМЕ, пустота значит «не знаем, чьё
--     помещение»; наши склады получают карточку own_company (М-11).
--     ON DELETE no action: удалить контрагента, у которого есть места, нельзя
--     молча — сначала перевесить места.
--   индекс по contractor_id — под «места контрагента» на его карточке.
--
-- ЗАМЕР ПРОДА (11.09.2026, до выката): мест 33 (30 точек продаж, 3 склада),
-- таблица новая — данных не переносит, блокировок существующих таблиц нет,
-- кроме FK-проверки при создании пустой таблицы.
--
-- ОТКАТ (руками, на проде):
--   DROP TABLE IF EXISTS "place_card";
--   DELETE FROM "drizzle"."__drizzle_migrations"
--     WHERE "created_at" = (select max("created_at") from "drizzle"."__drizzle_migrations");
-- Порядок важен: рецепт отката 0089 («удалить последнюю запись журнала») верен,
-- только пока 0089 последняя, — теперь сначала откатывается 0090, потом 0089.
-- Сценарии 0089 (tools/pglite-checks) поэтому докатывают ровно до 0089.

CREATE TABLE "place_card" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"contractor_id" uuid,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "place_card" ADD CONSTRAINT "place_card_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_card" ADD CONSTRAINT "place_card_contractor_id_entity_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_card_contractor_idx" ON "place_card" USING btree ("contractor_id");