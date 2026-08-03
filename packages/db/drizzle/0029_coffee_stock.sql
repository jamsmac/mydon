CREATE TABLE "coffee_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"counted_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_stock_ingredient_id_unique" UNIQUE("ingredient_id")
);
--> statement-breakpoint
ALTER TABLE "coffee_stock" ADD CONSTRAINT "coffee_stock_ingredient_id_coffee_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."coffee_ingredient"("id") ON DELETE no action ON UPDATE no action;