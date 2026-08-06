CREATE TABLE "maintenance_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" "maintenance_kind" NOT NULL,
	"part_kind" "part_kind",
	"title" text,
	"every_days" integer,
	"every_months" integer,
	"every_count" integer,
	"counter_label" text,
	"due_on" date,
	"task_lead_days" integer DEFAULT 3 NOT NULL,
	"auto_task" boolean DEFAULT true NOT NULL,
	"assignee_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_plan_period_set" CHECK ("maintenance_plan"."every_days" is not null or "maintenance_plan"."every_months" is not null or "maintenance_plan"."every_count" is not null),
	CONSTRAINT "maintenance_plan_lead_nonneg" CHECK ("maintenance_plan"."task_lead_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_plan" ADD CONSTRAINT "maintenance_plan_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plan" ADD CONSTRAINT "maintenance_plan_assignee_id_person_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_plan_due_idx" ON "maintenance_plan" USING btree ("due_on") WHERE is_active;--> statement-breakpoint
CREATE INDEX "maintenance_plan_entity_idx" ON "maintenance_plan" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_plan_key" ON "maintenance_plan" USING btree ("entity_id","kind",coalesce("part_kind"::text, '')) WHERE is_active;--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_plan_id_maintenance_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."maintenance_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_log_plan_done_idx" ON "maintenance_log" USING btree ("plan_id","performed_on") WHERE outcome is not null;