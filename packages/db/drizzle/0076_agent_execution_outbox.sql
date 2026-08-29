CREATE TYPE "public"."outbox_delivery_status" AS ENUM('pending', 'dispatching', 'sent', 'skipped', 'unknown', 'dead');--> statement-breakpoint
CREATE TYPE "public"."task_agent_execution_status" AS ENUM('ready', 'committed', 'abandoned');--> statement-breakpoint
CREATE TABLE "outbox_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"task_agent_execution_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "outbox_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"provider_ref" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_delivery_attempts_nonnegative" CHECK ("outbox_delivery"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_agent_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"execution_attempt_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"skill" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"task_input_hash" text NOT NULL,
	"checkpoint_kind" text NOT NULL,
	"checkpoint_payload" jsonb NOT NULL,
	"checkpoint_hash" text NOT NULL,
	"status" "task_agent_execution_status" DEFAULT 'ready' NOT NULL,
	"outcome_payload" jsonb,
	"outcome_hash" text,
	"approval_id" uuid,
	"committed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"abandon_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_agent_execution_schema_version_positive" CHECK ("task_agent_execution"."schema_version" > 0),
	CONSTRAINT "task_agent_execution_terminal_fields_consistent" CHECK (("task_agent_execution"."status" = 'ready' and "task_agent_execution"."outcome_payload" is null and "task_agent_execution"."outcome_hash" is null and "task_agent_execution"."committed_at" is null and "task_agent_execution"."abandoned_at" is null and "task_agent_execution"."abandon_reason" is null) or ("task_agent_execution"."status" = 'committed' and "task_agent_execution"."outcome_payload" is not null and "task_agent_execution"."outcome_hash" is not null and "task_agent_execution"."committed_at" is not null and "task_agent_execution"."abandoned_at" is null and "task_agent_execution"."abandon_reason" is null) or ("task_agent_execution"."status" = 'abandoned' and "task_agent_execution"."outcome_payload" is null and "task_agent_execution"."outcome_hash" is null and "task_agent_execution"."committed_at" is null and "task_agent_execution"."abandoned_at" is not null and "task_agent_execution"."abandon_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "client_key" text;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "client_key" text;--> statement-breakpoint
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "outbox_delivery_task_agent_execution_id_task_agent_execution_id_fk" FOREIGN KEY ("task_agent_execution_id") REFERENCES "public"."task_agent_execution"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD CONSTRAINT "task_agent_execution_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD CONSTRAINT "task_agent_execution_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_delivery_key" ON "outbox_delivery" USING btree ("key");--> statement-breakpoint
CREATE INDEX "outbox_delivery_destination_status_created_idx" ON "outbox_delivery" USING btree ("destination","status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_delivery_execution_idx" ON "outbox_delivery" USING btree ("task_agent_execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_agent_execution_attempt_key" ON "task_agent_execution" USING btree ("execution_attempt_id");--> statement-breakpoint
CREATE INDEX "task_agent_execution_task_idx" ON "task_agent_execution" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_agent_execution_status_idx" ON "task_agent_execution" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_client_key" ON "approval" USING btree ("client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "event_client_key" ON "event" USING btree ("client_key");
