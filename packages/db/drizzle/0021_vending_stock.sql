CREATE TABLE "vending_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_name" text NOT NULL,
	"product_id" uuid,
	"quantity" integer DEFAULT 0 NOT NULL,
	"counted_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vending_stock_product_name_unique" UNIQUE("product_name")
);
--> statement-breakpoint
ALTER TABLE "vending_stock" ADD CONSTRAINT "vending_stock_product_id_vending_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."vending_product"("id") ON DELETE no action ON UPDATE no action;