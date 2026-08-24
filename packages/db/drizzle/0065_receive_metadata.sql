-- П3a: метаданные приёмки накладной. Без бэкфилла: у принятых ранее накладных
-- момент приёмки неизвестен — NULL честнее выдуманного времени.
ALTER TABLE "vending_purchase_order" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vending_purchase_order" ADD COLUMN "received_by" text;
