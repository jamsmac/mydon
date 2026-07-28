-- Убираем направление TRent (решение владельца 2026-07-28).
-- PostgreSQL не умеет удалять значение из enum — тип пересоздаётся целиком.
-- Порядок важен: сначала колонки в text, потом чистка данных trent, и только
-- затем новый тип. Иначе обратное приведение упало бы на строке 'trent'.
ALTER TABLE "org" ALTER COLUMN "code" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "task" ALTER COLUMN "domain" SET DATA TYPE text;--> statement-breakpoint

-- Данных по TRent нет (проверено до миграции: 0 сущностей, 0 денег, 0 задач,
-- 0 агентов) — удаляется только структурная строка направления.
UPDATE "task" SET "domain" = NULL WHERE "domain" = 'trent';--> statement-breakpoint
DELETE FROM "org" WHERE "code" = 'trent';--> statement-breakpoint

DROP TYPE "public"."domain";--> statement-breakpoint
CREATE TYPE "public"."domain" AS ENUM('globerent', 'vendhub', 'personal', 'mydon');--> statement-breakpoint
ALTER TABLE "org" ALTER COLUMN "code" SET DATA TYPE "public"."domain" USING "code"::"public"."domain";--> statement-breakpoint
ALTER TABLE "task" ALTER COLUMN "domain" SET DATA TYPE "public"."domain" USING "domain"::"public"."domain";