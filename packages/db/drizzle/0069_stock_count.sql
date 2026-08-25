-- vending_stock_count (П8a «История склада + сторож сбора», R-P8a-3): ИСТОРИЯ
-- инвентаризаций склада — леджер, а не перезапись.
--
-- Зачем таблица, если есть vending_stock. Та — перезаписная, «одна строка на
-- товар», текущий баланс; вопрос «сколько было на складе в июне» не имел
-- ответа ни в одной таблице mydon (inventory-prod.md §3: vending_stock 20
-- строк, два момента 25.08, событий vending.stock.recounted — всего 2).
-- Здесь каждая строка — один пересчёт одной позиции, ничего не перезаписывает.
--
-- Почему ДВА индекса и оба ЧАСТИЧНЫЕ, а не один сплошной UNIQUE. Донор
-- mydon-stock несёт законные дубли: 5 групп повторов по (dt, место, товар,
-- qty), включая пары с одинаковым counted_at и товаром — реальность склада
-- (два независимых пересчёта одной позиции в один момент), а не ошибка ввода
-- (inventory-donor.md §2, §4.4). Сплошной (source, counted_at, product_name)
-- отверг бы такие строки при импорте. Поэтому ключ импорта —
-- (source, ext_id) WHERE ext_id IS NOT NULL (идемпотентность по внешнему id
-- донора), а ключ своих пересчётов — (source, counted_at, product_name)
-- WHERE source = 'own' (идемпотентность по моменту переучёта); частичность
-- не даёт им мешать друг другу.
--
-- qty — numeric(12,2), не integer: донор хранит дробные остатки склада,
-- integer тихо срезал бы дробную часть.
--
-- Бэкфилла здесь нет: разовый перенос 460 донорских строк делает скрипт T3
-- (import-stock-history.ts), а не эта миграция — резолв канонического имени
-- товара это КОД (vending_alias/normalizeProductName), повторять его в SQL
-- значило бы завести вторую реализацию того же правила.
--
-- Таблица НОВАЯ — бэкфилла нет, CREATE TABLE IF NOT EXISTS создаёт её сразу с
-- финальными ограничениями (NOT NULL и т.д.), без риска для чужих строк.
--
-- Файл написан руками по защитному паттерну 0067: IF NOT EXISTS / FK через
-- DO $$ … EXCEPTION WHEN duplicate_object, CREATE UNIQUE/обычный INDEX IF NOT
-- EXISTS. Автодеплой применяет миграции без отката — упавший оператор вешает
-- выкатку молча и навсегда, поэтому каждый оператор ниже обязан быть безопасен
-- на повторном прогоне. Снапшот 0069 снят генератором с текущей schema.ts, так
-- что следующий db:generate снова честен.

CREATE TABLE IF NOT EXISTS "vending_stock_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dt" date NOT NULL,
	"product_name" text NOT NULL,
	"product_id" uuid,
	"qty" numeric(12, 2) NOT NULL,
	"source" text NOT NULL,
	"ext_id" text,
	"counted_at" timestamp with time zone NOT NULL,
	"person_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "vending_stock_count"
    ADD CONSTRAINT "vending_stock_count_product_id_vending_product_id_fk"
    FOREIGN KEY ("product_id") REFERENCES "public"."vending_product"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "vending_stock_count"
    ADD CONSTRAINT "vending_stock_count_person_id_person_id_fk"
    FOREIGN KEY ("person_id") REFERENCES "public"."person"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "vending_stock_count_src_key" ON "vending_stock_count" USING btree ("source","ext_id") WHERE "vending_stock_count"."ext_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_stock_count_own_key" ON "vending_stock_count" USING btree ("source","counted_at","product_name") WHERE "vending_stock_count"."source" = 'own';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vending_stock_count_product_dt_idx" ON "vending_stock_count" USING btree ("product_name","dt");
