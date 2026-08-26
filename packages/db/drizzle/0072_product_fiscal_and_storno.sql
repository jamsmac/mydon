-- П6: фискальный блок карточки снека (R-P6-1/R-P6-5) и сторно снек-записей
-- (R-P6-3/R-P6-10). Идемпотентно; дефолты безопасны для 52 живых строк прайса.
--
-- IF NOT EXISTS везде — защитный паттерн 0067/0069/0070/0071: автодеплой
-- применяет миграции без отката, и каждый оператор обязан быть безопасен на
-- повторе.

-- 1. Фискальные поля прайса. CHECK'и СТРУКТУРНЫЕ (длина и цифры); набор
--    значений (12/0/15, семь кодов ОКЕИ) живёт в @mydon/shared — R-P6-6:
--    ставки НДС меняют законом, и в день изменения не должно требоваться
--    миграции.
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "ikpu" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "mxik" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "vat_pct" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "barcode" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "package_code" text DEFAULT '796' NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "marked" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_ikpu_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_ikpu_check"
  CHECK ("ikpu" IS NULL OR "ikpu" ~ '^[0-9]{17}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_mxik_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_mxik_check"
  CHECK ("mxik" IS NULL OR "mxik" ~ '^[0-9]{17}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_barcode_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_barcode_check"
  CHECK ("barcode" IS NULL OR "barcode" ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13})$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_package_code_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_package_code_check"
  CHECK ("package_code" ~ '^[0-9]{3}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_vat_pct_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_vat_pct_check"
  CHECK ("vat_pct" >= 0 AND "vat_pct" <= 100);--> statement-breakpoint

-- 2. Сторно заправок. qty — ДЕЛЬТА, поэтому противознак; старый CHECK
--    «qty > 0» его бы отверг. Ослабляем РОВНО на источник 'storno':
--    обычная заправка на минус по-прежнему невозможна.
ALTER TABLE "vending_refill" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_refill"("id");--> statement-breakpoint
ALTER TABLE "vending_refill" DROP CONSTRAINT IF EXISTS "vending_refill_qty_positive";--> statement-breakpoint
ALTER TABLE "vending_refill" ADD CONSTRAINT "vending_refill_qty_positive"
  CHECK (("source" = 'storno' AND "qty" < 0) OR ("source" <> 'storno' AND "qty" > 0));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vending_refill_reverses_idx"
  ON "vending_refill" USING btree ("reverses_id") WHERE "reverses_id" IS NOT NULL;--> statement-breakpoint

-- 3. Сторно пересчётов. qty — СНИМОК, противознака нет, строка это МЕТКА:
--    «−19 штук на складе» никто не считал, и записать это значило бы выдумать
--    факт. Идемпотентность своим частичным уникальным: own_key её не
--    покрывает (он ограничен source='own').
ALTER TABLE "vending_stock_count" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_stock_count"("id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_stock_count_storno_key"
  ON "vending_stock_count" USING btree ("reverses_id") WHERE "source" = 'storno';--> statement-breakpoint

-- 4. Сторно касс закупа. Колонки source у таблицы не было вовсе.
ALTER TABLE "vending_cash_session" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_cash_session" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_cash_session"("id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_cash_session_storno_key"
  ON "vending_cash_session" USING btree ("reverses_id") WHERE "source" = 'storno';
