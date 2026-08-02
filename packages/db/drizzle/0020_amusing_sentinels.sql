CREATE TYPE "public"."vending_alias_source" AS ENUM('ourvend', 'warehouse', 'manual');--> statement-breakpoint
CREATE TYPE "public"."vending_category" AS ENUM('drink', 'snack', 'other');--> statement-breakpoint
CREATE TYPE "public"."vending_sync_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "machine_sale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_serial" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"total_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_slot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid,
	"machine_serial" text NOT NULL,
	"coil_id" text NOT NULL,
	"product_name" text,
	"product_id" uuid,
	"capacity" integer DEFAULT 0 NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_sale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_serial" text NOT NULL,
	"product_name" text NOT NULL,
	"product_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_serial" text NOT NULL,
	"coil_id" text NOT NULL,
	"product_name" text,
	"capacity" integer DEFAULT 0 NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vending_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"source" "vending_alias_source" DEFAULT 'ourvend' NOT NULL,
	CONSTRAINT "vending_alias_alias_unique" UNIQUE("alias")
);
--> statement-breakpoint
CREATE TABLE "vending_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" "vending_category" DEFAULT 'other' NOT NULL,
	"purchase_price" numeric(10, 2),
	"pack_size" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vending_product_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "vending_sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "vending_sync_status" DEFAULT 'running' NOT NULL,
	"machines_total" integer DEFAULT 0 NOT NULL,
	"machines_ok" integer DEFAULT 0 NOT NULL,
	"error" text,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "vending_unmatched" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_name" text NOT NULL,
	"source" "vending_alias_source" DEFAULT 'ourvend' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_product_id" uuid,
	CONSTRAINT "vending_unmatched_external_name_unique" UNIQUE("external_name")
);
--> statement-breakpoint
ALTER TABLE "machine_slot" ADD CONSTRAINT "machine_slot_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_slot" ADD CONSTRAINT "machine_slot_product_id_vending_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."vending_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sale" ADD CONSTRAINT "product_sale_product_id_vending_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."vending_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vending_alias" ADD CONSTRAINT "vending_alias_product_id_vending_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."vending_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vending_unmatched" ADD CONSTRAINT "vending_unmatched_resolved_product_id_vending_product_id_fk" FOREIGN KEY ("resolved_product_id") REFERENCES "public"."vending_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_sale_machine_captured_idx" ON "machine_sale" USING btree ("machine_serial","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_slot_key" ON "machine_slot" USING btree ("machine_serial","coil_id");--> statement-breakpoint
CREATE INDEX "product_sale_machine_captured_idx" ON "product_sale" USING btree ("machine_serial","captured_at");--> statement-breakpoint
CREATE INDEX "slot_snapshot_machine_captured_idx" ON "slot_snapshot" USING btree ("machine_serial","captured_at");--> statement-breakpoint
CREATE INDEX "vending_alias_alias_idx" ON "vending_alias" USING btree ("alias");