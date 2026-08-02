ALTER TABLE "vending_purchase_order" ADD COLUMN "distributed_units" integer;--> statement-breakpoint
ALTER TABLE "vending_purchase_order" ADD COLUMN "unmatched_distribution" jsonb;