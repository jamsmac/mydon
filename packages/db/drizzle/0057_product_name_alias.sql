CREATE TABLE "product_name_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_name_alias_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "product_name_alias" ADD CONSTRAINT "product_name_alias_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_name_alias_entity_idx" ON "product_name_alias" USING btree ("entity_id");