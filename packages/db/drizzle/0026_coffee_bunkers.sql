CREATE TYPE "public"."coffee_wash_event_kind" AS ENUM('wash', 'clean', 'replace', 'service');--> statement-breakpoint
CREATE TABLE "coffee_bunker_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"ingredient_id" uuid NOT NULL,
	CONSTRAINT "coffee_bunker_config_position_range" CHECK ("coffee_bunker_config"."position" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "coffee_consumable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"logged_date" date NOT NULL,
	"water" integer DEFAULT 0 NOT NULL,
	"cups" integer DEFAULT 0 NOT NULL,
	"lids" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coffee_container_tare" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"container_number" integer NOT NULL,
	"position" integer NOT NULL,
	"tare_weight" integer,
	CONSTRAINT "coffee_container_tare_container_range" CHECK ("coffee_container_tare"."container_number" between 1 and 27),
	CONSTRAINT "coffee_container_tare_position_range" CHECK ("coffee_container_tare"."position" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "coffee_ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'g' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_ingredient_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "coffee_location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_location_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "coffee_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"recipe" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_product_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "coffee_refill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"container_number" integer,
	"ingredient_id" uuid,
	"filled_weight" integer NOT NULL,
	"measured_before" integer,
	"package_count" integer DEFAULT 1 NOT NULL,
	"entered_date" date NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_refill_position_range" CHECK ("coffee_refill"."position" between 1 and 8),
	CONSTRAINT "coffee_refill_container_range" CHECK ("coffee_refill"."container_number" is null or "coffee_refill"."container_number" between 1 and 27)
);
--> statement-breakpoint
CREATE TABLE "coffee_sale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"logged_date" date NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coffee_wash_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"position" integer,
	"kind" "coffee_wash_event_kind" DEFAULT 'wash' NOT NULL,
	"note" text,
	"performed_by" text,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_wash_log_position_range" CHECK ("coffee_wash_log"."position" is null or "coffee_wash_log"."position" between 1 and 8)
);
--> statement-breakpoint
ALTER TABLE "coffee_bunker_config" ADD CONSTRAINT "coffee_bunker_config_ingredient_id_coffee_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."coffee_ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_consumable" ADD CONSTRAINT "coffee_consumable_location_id_coffee_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."coffee_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD CONSTRAINT "coffee_refill_location_id_coffee_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."coffee_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD CONSTRAINT "coffee_refill_ingredient_id_coffee_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."coffee_ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_sale" ADD CONSTRAINT "coffee_sale_location_id_coffee_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."coffee_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_sale" ADD CONSTRAINT "coffee_sale_product_id_coffee_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."coffee_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_wash_log" ADD CONSTRAINT "coffee_wash_log_location_id_coffee_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."coffee_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_bunker_config_position_ingredient_key" ON "coffee_bunker_config" USING btree ("position","ingredient_id");--> statement-breakpoint
CREATE INDEX "coffee_bunker_config_position_idx" ON "coffee_bunker_config" USING btree ("position");--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_consumable_location_date_key" ON "coffee_consumable" USING btree ("location_id","logged_date");--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_container_tare_key" ON "coffee_container_tare" USING btree ("container_number","position");--> statement-breakpoint
CREATE INDEX "coffee_refill_location_position_idx" ON "coffee_refill" USING btree ("location_id","position","entered_date");--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_sale_location_product_date_key" ON "coffee_sale" USING btree ("location_id","product_id","logged_date");--> statement-breakpoint
CREATE INDEX "coffee_wash_log_location_idx" ON "coffee_wash_log" USING btree ("location_id","performed_at");