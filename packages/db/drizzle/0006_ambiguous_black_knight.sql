CREATE TYPE "public"."collection_source" AS ENUM('realtime', 'manual_history', 'import');--> statement-breakpoint
CREATE TYPE "public"."collection_status" AS ENUM('collected', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE "collection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"operator_id" uuid,
	"manager_ref" text,
	"collected_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone,
	"amount" numeric(15, 2),
	"status" "collection_status" DEFAULT 'collected' NOT NULL,
	"source" "collection_source" DEFAULT 'realtime' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_operator_id_person_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_machine_date_idx" ON "collection" USING btree ("machine_id","collected_at");--> statement-breakpoint
CREATE INDEX "collection_status_idx" ON "collection" USING btree ("status");