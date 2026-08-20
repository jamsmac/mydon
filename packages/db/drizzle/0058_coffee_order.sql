CREATE TABLE "coffee_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ext_id" text NOT NULL,
	"source" text DEFAULT 'gjvending' NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"brewed_at" timestamp with time zone,
	"machine_serial" text NOT NULL,
	"machine_id" uuid,
	"address" text,
	"goods_name" text NOT NULL,
	"flavour_name" text,
	"product_id" uuid,
	"amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'UZS' NOT NULL,
	"payment_status" text,
	"brew_status" text,
	"order_resource" text,
	"countable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coffee_order" ADD CONSTRAINT "coffee_order_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_order" ADD CONSTRAINT "coffee_order_product_id_entity_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_order_src_key" ON "coffee_order" USING btree ("source","ext_id");--> statement-breakpoint
CREATE INDEX "coffee_order_ts_idx" ON "coffee_order" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "coffee_order_machine_idx" ON "coffee_order" USING btree ("machine_id","ts");--> statement-breakpoint
CREATE INDEX "coffee_order_countable_idx" ON "coffee_order" USING btree ("countable","ts");