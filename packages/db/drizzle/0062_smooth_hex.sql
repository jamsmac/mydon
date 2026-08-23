ALTER TABLE "raw_snapshot" ADD COLUMN "completed_at" timestamp with time zone;
--> statement-breakpoint
-- Все снимки, существовавшие до пакетного протокола, были опубликованы
-- одноразовым импортом и считаются завершёнными.
UPDATE "raw_snapshot"
SET "completed_at" = "created_at"
WHERE "completed_at" IS NULL;
--> statement-breakpoint
-- Локации без организации невидимы в панели. Этот backfill раньше лежал
-- отдельным файлом 0062 без записи в meta/_journal.json, поэтому drizzle-orm
-- его не применял. Включаем его в настоящую миграцию; условие идемпотентно.
UPDATE "entity"
SET "org_id" = (SELECT "id" FROM "org" WHERE "code" = 'vendhub')
WHERE "type" = 'location'
  AND "org_id" IS NULL
  AND "created_from" = 'coffee-import'
  AND EXISTS (SELECT 1 FROM "org" WHERE "code" = 'vendhub');
--> statement-breakpoint
-- Эти точки появились только после явного одобрения исторического импорта
-- владельцем. Старый исполнитель не заполнял approved_at/approved_by, поэтому
-- подтверждённая запись ошибочно продолжала выглядеть черновиком.
UPDATE "entity"
SET "approved_at" = COALESCE("approved_at", "created_at"),
    "approved_by" = COALESCE("approved_by", 'owner')
WHERE "type" = 'location'
  AND "created_from" = 'coffee-import'
  AND "approved_at" IS NULL;
