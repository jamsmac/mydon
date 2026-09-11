-- Волна 3 «Номер автомата» (М-6…М-8, М-12; docs/SPEC_KONTRAGENT_MESTO_AVTOMAT.md).
--
-- Что добавляется и почему.
--   inventory_no — наш инвентарный номер с буквой вида (K-014 кофе, S снек,
--     D напитки, C комбо). Серийник — заводской и чужой (entity.external_ref),
--     по нему сходится Ourvend: это два разных номера (М-6).
--   label_pending — правда о наклейке: номер присвоен системой, но на автомат
--     ещё не наклеен и не подтверждён. Как у part_unit (0083).
--   machine_card_inventory_no_key — та же форма, что part_unit_inventory_no_key:
--     upper + без пробелов, «k-014» и «K-014 » — одна наклейка.
--   machine_card_inventory_no_canonical — одна форма номера В БАЗЕ (K-014, не
--     K-14): иначе «K-14» рядом с «K-014» прошёл бы мимо уникального индекса,
--     и у двух автоматов оказался бы «номер 14». Серии K/S/D/C.
--
-- ЗАМЕР ПРОДА (11.09.2026, до выката): machine_card — 31 строка (coffee 25,
-- snack 5, drink 1). ADD COLUMN с DEFAULT false на PG 11+ не переписывает
-- таблицу; индекс по 31 строке — мгновенно.
--
-- ОТКАТ (руками): DROP INDEX machine_card_inventory_no_key; ALTER TABLE
-- machine_card DROP CONSTRAINT machine_card_inventory_no_canonical, DROP COLUMN label_pending, DROP COLUMN inventory_no; удалить
-- последнюю запись drizzle.__drizzle_migrations (0091 должна быть последней).

ALTER TABLE "machine_card" ADD COLUMN "inventory_no" text;--> statement-breakpoint
ALTER TABLE "machine_card" ADD COLUMN "label_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_card_inventory_no_key" ON "machine_card" USING btree (upper(regexp_replace("inventory_no", '\s', '', 'g'))) WHERE inventory_no is not null;--> statement-breakpoint
ALTER TABLE "machine_card" ADD CONSTRAINT "machine_card_inventory_no_canonical" CHECK (inventory_no is null or inventory_no ~ '^[KSDC]-[0-9]{3,6}$');