-- Журнал ВВОДОВ расходников (аудит видимости 18.08, задача «append-only»).
--
-- Строка coffee_consumable — состояние дня (upsert): историю правок и автора
-- каждого ввода она не хранит, и правка задним числом переписывала прошлое
-- ленты действий. События вводов теперь копятся здесь; агрегат дня остаётся.
CREATE TABLE "coffee_consumable_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "entity"("id"),
  "logged_date" date NOT NULL,
  "water" integer DEFAULT 0 NOT NULL,
  "cups" integer DEFAULT 0 NOT NULL,
  "lids" integer DEFAULT 0 NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "coffee_consumable_log_created_idx" ON "coffee_consumable_log" ("created_at");
--> statement-breakpoint
-- Бэкфилл: расходники, внесённые ДО журнала, не должны исчезнуть из ленты
-- действий. Момент берём из updated_at строки-состояния — точнее данных нет.
INSERT INTO "coffee_consumable_log" ("location_id", "logged_date", "water", "cups", "lids", "created_by", "created_at")
SELECT "location_id", "logged_date", "water", "cups", "lids", "created_by", "updated_at"
FROM "coffee_consumable";
