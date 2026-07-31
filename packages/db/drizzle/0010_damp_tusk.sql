CREATE TYPE "public"."raw_link_kind" AS ENUM('machine', 'product', 'point');--> statement-breakpoint
CREATE TABLE "raw_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_code" text NOT NULL,
	"kind" "raw_link_kind" NOT NULL,
	"external_key" text NOT NULL,
	"external_label" text NOT NULL,
	"entity_id" uuid,
	"decided_by" text DEFAULT 'owner' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"cells" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_code" text NOT NULL,
	"report_code" text NOT NULL,
	"domain" "domain" DEFAULT 'vendhub' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"period_from" date,
	"period_to" date,
	"account" text,
	"rows_total" integer,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raw_link" ADD CONSTRAINT "raw_link_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_row" ADD CONSTRAINT "raw_row_snapshot_id_raw_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."raw_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "raw_link_key" ON "raw_link" USING btree ("source_code","kind","external_key");--> statement-breakpoint
CREATE INDEX "raw_link_entity_idx" ON "raw_link" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_row_key" ON "raw_row" USING btree ("snapshot_id","idx");--> statement-breakpoint
CREATE INDEX "raw_row_snapshot_idx" ON "raw_row" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_snapshot_key" ON "raw_snapshot" USING btree ("source_code","report_code","fetched_at");--> statement-breakpoint
CREATE INDEX "raw_snapshot_report_idx" ON "raw_snapshot" USING btree ("source_code","report_code","fetched_at");