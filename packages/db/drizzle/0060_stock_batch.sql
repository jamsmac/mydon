-- Партия сырья/товара (stock_batch): что, откуда, почём, до какого числа.
-- WAREHOUSE_SPEC §4.3 + документ прихода (Р3/Р4 плана учёта сырья).
--
-- Таблица НОВАЯ — бэкфилла нет, поэтому CREATE TABLE IF NOT EXISTS создаёт её
-- сразу с финальными ограничениями (в т.ч. NOT NULL), без риска для чужих строк.
--
-- Колонка stock_movement.batch_id — NULLABLE. На 21.08.2026 склад уже наполнен
-- снимком остатка владельца: движения kind='adjustment' БЕЗ партии (кофе 43 кг,
-- сухое молоко 26 кг, матча 1,5 кг, MacCoffee 10 600 г и т.д.), плюс синк
-- снабжения пишет приход без партии вовсе. NOT NULL здесь сделал бы эти
-- движения невалидными и остановил бы синк насмерть.
--
-- Файл написан руками (как 0049–0059) по защитному паттерну 0059:
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / FK через DO $$ … EXCEPTION WHEN
-- duplicate_object, только частичные CREATE INDEX IF NOT EXISTS. Автодеплой
-- применяет миграции без отката — упавший оператор вешает выкатку молча и
-- навсегда, поэтому каждый оператор ниже обязан быть безопасен на повторном
-- прогоне и на живых данных. Снапшот 0060 снят с текущей schema.ts, так что
-- следующий db:generate снова честен.

CREATE TABLE IF NOT EXISTS "stock_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_code" text,
	"expiry_date" date,
	"manufacture_date" date,
	"received_on" date NOT NULL,
	"qty_received" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"opened_on" date,
	"opened_by" uuid,
	"person_id" uuid,
	"supplier_id" uuid,
	"invoice_no" text,
	"invoice_date" date,
	"ikpu" text,
	"unit_price_net" numeric(14, 4),
	"vat_rate" numeric(5, 2),
	"unit_price_gross" numeric(14, 4),
	"base_unit_snapshot" text,
	"package_weight_snapshot" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"ext_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Приход без партии остаётся законным (см. шапку) — колонка nullable, без дефолта.
ALTER TABLE "stock_movement" ADD COLUMN IF NOT EXISTS "batch_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "stock_batch"
    ADD CONSTRAINT "stock_batch_ingredient_id_entity_id_fk"
    FOREIGN KEY ("ingredient_id") REFERENCES "public"."entity"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "stock_batch"
    ADD CONSTRAINT "stock_batch_warehouse_id_entity_id_fk"
    FOREIGN KEY ("warehouse_id") REFERENCES "public"."entity"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "stock_batch"
    ADD CONSTRAINT "stock_batch_opened_by_person_id_fk"
    FOREIGN KEY ("opened_by") REFERENCES "public"."person"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "stock_batch"
    ADD CONSTRAINT "stock_batch_person_id_person_id_fk"
    FOREIGN KEY ("person_id") REFERENCES "public"."person"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "stock_batch"
    ADD CONSTRAINT "stock_batch_supplier_id_entity_id_fk"
    FOREIGN KEY ("supplier_id") REFERENCES "public"."entity"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "stock_movement"
    ADD CONSTRAINT "stock_movement_batch_id_stock_batch_id_fk"
    FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batch"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Срок годности и вскрытая пачка — частичные индексы: NULL встречается часто
-- (партия ещё не вскрыта / срок не задан), индексировать его незачем.
CREATE INDEX IF NOT EXISTS "stock_batch_expiry_idx" ON "stock_batch" USING btree ("expiry_date") WHERE expiry_date is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_batch_open_idx" ON "stock_batch" USING btree ("opened_on") WHERE opened_on is not null;--> statement-breakpoint

-- Код партии уникален в рамках карточки, но только когда задан (партия без
-- кода — законна, R-C7). Идемпотентность источника — по source+ext_id, тоже
-- только когда ext_id задан (у ручного ввода его нет).
CREATE UNIQUE INDEX IF NOT EXISTS "stock_batch_code_key" ON "stock_batch" USING btree ("ingredient_id","batch_code") WHERE batch_code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_batch_ext_key" ON "stock_batch" USING btree ("source","ext_id") WHERE ext_id is not null;
