CREATE TYPE "public"."stock_movement_kind" AS ENUM('intake', 'consumption', 'transfer');--> statement-breakpoint
CREATE TABLE "stock_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"counterparty_id" uuid,
	"dt" date NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(15, 2),
	"total" numeric(15, 2),
	"supplier" text,
	"domain" "domain" DEFAULT 'vendhub' NOT NULL,
	"currency" text DEFAULT 'UZS' NOT NULL,
	"source" text DEFAULT 'owner' NOT NULL,
	"ext_id" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_ingredient_id_entity_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_warehouse_id_entity_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_counterparty_id_entity_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movement_ing_idx" ON "stock_movement" USING btree ("ingredient_id","dt");--> statement-breakpoint
CREATE INDEX "stock_movement_wh_idx" ON "stock_movement" USING btree ("warehouse_id","dt");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_src_key" ON "stock_movement" USING btree ("source","ext_id");