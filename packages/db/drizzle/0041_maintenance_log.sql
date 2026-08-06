CREATE TYPE "public"."maintenance_kind" AS ENUM('cleaning', 'sanitation', 'service', 'part_replace', 'inspection', 'calibration', 'repair', 'other');--> statement-breakpoint
CREATE TYPE "public"."maintenance_outcome" AS ENUM('done', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."part_kind" AS ENUM('bill_acceptor', 'coin_acceptor', 'brewer', 'grinder', 'mixer', 'hopper', 'water_filter', 'pump', 'boiler', 'cooling_unit', 'compressor', 'payment_terminal', 'display', 'mainboard', 'motor', 'valve', 'sensor', 'lock', 'spiral', 'elevator', 'other');--> statement-breakpoint
CREATE TYPE "public"."part_swap_reason" AS ENUM('failure', 'preventive', 'upgrade', 'warranty', 'moved');--> statement-breakpoint
CREATE TABLE "machine_part" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"part_kind" "part_kind" NOT NULL,
	"slot" integer,
	"serial_number" text,
	"model" text,
	"installed_on" date NOT NULL,
	"removed_on" date,
	"install_log_id" uuid,
	"remove_log_id" uuid,
	"warranty_until" date,
	"reason" "part_swap_reason",
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_part_slot_positive" CHECK ("machine_part"."slot" is null or "machine_part"."slot" > 0),
	CONSTRAINT "machine_part_dates" CHECK ("machine_part"."removed_on" is null or "machine_part"."removed_on" >= "machine_part"."installed_on")
);
--> statement-breakpoint
CREATE TABLE "maintenance_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" "maintenance_kind" NOT NULL,
	"part_kind" "part_kind",
	"person_id" uuid,
	"task_id" uuid,
	"performed_on" date NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "maintenance_outcome",
	"note" text,
	"counter_value" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_log_counter_nonneg" CHECK ("maintenance_log"."counter_value" is null or "maintenance_log"."counter_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "machine_part" ADD CONSTRAINT "machine_part_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_part" ADD CONSTRAINT "machine_part_install_log_id_maintenance_log_id_fk" FOREIGN KEY ("install_log_id") REFERENCES "public"."maintenance_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_part" ADD CONSTRAINT "machine_part_remove_log_id_maintenance_log_id_fk" FOREIGN KEY ("remove_log_id") REFERENCES "public"."maintenance_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_part_machine_idx" ON "machine_part" USING btree ("machine_id","part_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_part_open_key" ON "machine_part" USING btree ("machine_id","part_kind",coalesce("slot", 0)) WHERE removed_on is null;--> statement-breakpoint
CREATE INDEX "maintenance_log_entity_idx" ON "maintenance_log" USING btree ("entity_id","performed_on");--> statement-breakpoint
CREATE INDEX "maintenance_log_person_idx" ON "maintenance_log" USING btree ("person_id","performed_on");--> statement-breakpoint
CREATE INDEX "maintenance_log_done_idx" ON "maintenance_log" USING btree ("entity_id","kind","part_kind","performed_on") WHERE outcome is not null;