CREATE TABLE "machine_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dt" date NOT NULL,
	"machine_serial" text NOT NULL,
	"machine_id" uuid,
	"product" text NOT NULL,
	"qty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ext_id" text NOT NULL,
	"dt" date NOT NULL,
	"product" text NOT NULL,
	"unit" text,
	"qty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"unit_price" numeric(15, 2),
	"total" numeric(15, 2),
	"note" text,
	"expiry_date" date,
	"source" text DEFAULT 'stock' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_stock" ADD CONSTRAINT "machine_stock_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_stock_day_key" ON "machine_stock" USING btree ("dt","machine_serial","product");--> statement-breakpoint
CREATE INDEX "machine_stock_serial_idx" ON "machine_stock" USING btree ("machine_serial","dt");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_src_key" ON "purchase" USING btree ("source","ext_id");--> statement-breakpoint
CREATE INDEX "purchase_dt_idx" ON "purchase" USING btree ("dt");