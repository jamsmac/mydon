-- П5a: правила закупа товара как данные (решение владельца 24.08.2026, донор vending-ops).
-- Идемпотентно; дефолты безопасны для живых строк; бэкфилл — сидом seed-vending.js (overlay).
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "excluded_from_purchase" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "fixed_purchase_qty" integer;--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_fixed_purchase_qty_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_fixed_purchase_qty_check" CHECK ("fixed_purchase_qty" IS NULL OR "fixed_purchase_qty" > 0);
--> statement-breakpoint
-- Кратность закупки обязана быть положительной: ceil(buy/0)×0 = NaN, и NaN×цена
-- молча уносит в NaN всю сумму закупа (ревью безопасности П5a). Расчёт тоже
-- страхуется (Math.max(1, pack)), но данные чинятся здесь — на входе.
UPDATE "vending_product" SET "pack_size" = 1 WHERE "pack_size" IS NULL OR "pack_size" < 1;--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_pack_size_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_pack_size_check" CHECK ("pack_size" > 0);
