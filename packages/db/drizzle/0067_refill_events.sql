-- vending_refill_event (П4 «Полевой снек-контур»): событие детектора по снимкам.
-- Детектор сравнивает соседние снимки слотов (slot_snapshot) и там, где остаток
-- вырос, фиксирует заливку без участия оператора. unique(machine_serial,
-- window_to) — идемпотентность прогона: повторный запуск детектора по тому же
-- автомату и тому же концу окна не плодит дубль. matched_refill_id — запись
-- оператора (vending_refill), сопоставленная по окну ±3 ч; NULL — заливка без
-- отчёта мастера.
--
-- Таблица НОВАЯ — бэкфилла нет, CREATE TABLE IF NOT EXISTS создаёт её сразу с
-- финальными ограничениями (NOT NULL и т.д.), без риска для чужих строк.
--
-- Файл написан руками по защитному паттерну 0059/0060: IF NOT EXISTS / FK через
-- DO $$ … EXCEPTION WHEN duplicate_object, CREATE INDEX IF NOT EXISTS. Автодеплой
-- применяет миграции без отката — упавший оператор вешает выкатку молча и
-- навсегда, поэтому каждый оператор ниже обязан быть безопасен на повторном
-- прогоне. Снапшот 0067 снят с текущей schema.ts, так что следующий db:generate
-- снова честен.

CREATE TABLE IF NOT EXISTS "vending_refill_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_serial" text NOT NULL,
	"machine_id" uuid,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"units" integer NOT NULL,
	"slots" jsonb NOT NULL,
	"matched_refill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "vending_refill_event"
    ADD CONSTRAINT "vending_refill_event_machine_id_entity_id_fk"
    FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "vending_refill_event"
    ADD CONSTRAINT "vending_refill_event_matched_refill_id_vending_refill_id_fk"
    FOREIGN KEY ("matched_refill_id") REFERENCES "public"."vending_refill"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "vending_refill_event_serial_to" ON "vending_refill_event" USING btree ("machine_serial","window_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vending_refill_event_to_idx" ON "vending_refill_event" USING btree ("window_to");
