-- П5a: правила закупа товара как данные (решение владельца 24.08.2026, донор vending-ops).
-- Идемпотентно; дефолты безопасны для живых строк; бэкфилл — сидом seed-vending.js (overlay).
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "excluded_from_purchase" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "fixed_purchase_qty" integer;--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_fixed_purchase_qty_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_fixed_purchase_qty_check" CHECK ("fixed_purchase_qty" IS NULL OR "fixed_purchase_qty" > 0);
