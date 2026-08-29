CREATE TYPE "public"."agent_task_llm_authorization_decision" AS ENUM('denied', 'granted');--> statement-breakpoint
CREATE TYPE "public"."agent_task_llm_job_kind" AS ENUM('chat', 'embedding');--> statement-breakpoint
CREATE TYPE "public"."agent_task_llm_job_status" AS ENUM('waiting_budget', 'ready', 'dispatching', 'succeeded', 'rejected', 'unknown', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_task_llm_result_kind" AS ENUM('success', 'provider_rejection');--> statement-breakpoint
ALTER TABLE "task_agent_execution" DROP CONSTRAINT "task_agent_execution_terminal_fields_consistent";--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."task_agent_execution_status" RENAME TO "task_agent_execution_status_old";--> statement-breakpoint
CREATE TYPE "public"."task_agent_execution_status" AS ENUM('active', 'ready', 'committed', 'abandoned');--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "status" TYPE "public"."task_agent_execution_status" USING "status"::text::"public"."task_agent_execution_status";--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "status" SET DEFAULT 'ready';--> statement-breakpoint
DROP TYPE "public"."task_agent_execution_status_old";--> statement-breakpoint
CREATE TABLE "agent_task_llm_authorization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"day" date NOT NULL,
	"spend_id" uuid NOT NULL,
	"decision" "agent_task_llm_authorization_decision" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_task_llm_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_agent_execution_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"provider_attempt_no" integer NOT NULL,
	"kind" "agent_task_llm_job_kind" NOT NULL,
	"feature" text NOT NULL,
	"adapter" text NOT NULL,
	"adapter_version" integer NOT NULL,
	"endpoint_profile" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_token_ceiling" integer NOT NULL,
	"output_token_ceiling" integer NOT NULL,
	"job_key" text NOT NULL,
	"operation_hash" text NOT NULL,
	"request_payload" jsonb,
	"spend_id" uuid,
	"status" "agent_task_llm_job_status" DEFAULT 'waiting_budget' NOT NULL,
	"dispatch_count" integer DEFAULT 0 NOT NULL,
	"dispatch_token" uuid,
	"dispatch_run_id" uuid,
	"dispatch_granted_at" timestamp with time zone,
	"dispatch_deadline_at" timestamp with time zone,
	"unknown_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_task_llm_job_attempt_version_positive" CHECK ("agent_task_llm_job"."provider_attempt_no" > 0 and "agent_task_llm_job"."adapter_version" > 0),
	CONSTRAINT "agent_task_llm_job_token_ceilings_nonnegative" CHECK ("agent_task_llm_job"."input_token_ceiling" >= 0 and "agent_task_llm_job"."output_token_ceiling" >= 0),
	CONSTRAINT "agent_task_llm_job_dispatch_count_range" CHECK ("agent_task_llm_job"."dispatch_count" >= 0 and "agent_task_llm_job"."dispatch_count" <= 1),
	CONSTRAINT "agent_task_llm_job_operation_hash_format" CHECK ("agent_task_llm_job"."operation_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_task_llm_job_request_payload_bounded" CHECK ("agent_task_llm_job"."request_payload" is null or (jsonb_typeof("agent_task_llm_job"."request_payload") = 'object' and octet_length("agent_task_llm_job"."request_payload"::text) <= 1048576)),
	CONSTRAINT "agent_task_llm_job_state_fields_consistent" CHECK (("agent_task_llm_job"."status" = 'waiting_budget' and "agent_task_llm_job"."spend_id" is null and "agent_task_llm_job"."request_payload" is not null and "agent_task_llm_job"."dispatch_count" = 0 and "agent_task_llm_job"."dispatch_token" is null and "agent_task_llm_job"."dispatch_run_id" is null and "agent_task_llm_job"."dispatch_granted_at" is null and "agent_task_llm_job"."dispatch_deadline_at" is null and "agent_task_llm_job"."unknown_at" is null and "agent_task_llm_job"."completed_at" is null and "agent_task_llm_job"."cancelled_at" is null) or ("agent_task_llm_job"."status" = 'ready' and "agent_task_llm_job"."spend_id" is not null and "agent_task_llm_job"."request_payload" is not null and "agent_task_llm_job"."dispatch_count" = 0 and "agent_task_llm_job"."dispatch_token" is null and "agent_task_llm_job"."dispatch_run_id" is null and "agent_task_llm_job"."dispatch_granted_at" is null and "agent_task_llm_job"."dispatch_deadline_at" is null and "agent_task_llm_job"."unknown_at" is null and "agent_task_llm_job"."completed_at" is null and "agent_task_llm_job"."cancelled_at" is null) or ("agent_task_llm_job"."status" = 'dispatching' and "agent_task_llm_job"."spend_id" is not null and "agent_task_llm_job"."request_payload" is not null and "agent_task_llm_job"."dispatch_count" = 1 and "agent_task_llm_job"."dispatch_token" is not null and "agent_task_llm_job"."dispatch_run_id" is not null and "agent_task_llm_job"."dispatch_granted_at" is not null and "agent_task_llm_job"."dispatch_deadline_at" is not null and "agent_task_llm_job"."unknown_at" is null and "agent_task_llm_job"."completed_at" is null and "agent_task_llm_job"."cancelled_at" is null) or ("agent_task_llm_job"."status" in ('succeeded', 'rejected') and "agent_task_llm_job"."spend_id" is not null and "agent_task_llm_job"."request_payload" is null and "agent_task_llm_job"."dispatch_count" = 1 and "agent_task_llm_job"."dispatch_token" is not null and "agent_task_llm_job"."dispatch_run_id" is not null and "agent_task_llm_job"."dispatch_granted_at" is not null and "agent_task_llm_job"."dispatch_deadline_at" is not null and "agent_task_llm_job"."completed_at" is not null and "agent_task_llm_job"."cancelled_at" is null) or ("agent_task_llm_job"."status" = 'unknown' and "agent_task_llm_job"."spend_id" is not null and "agent_task_llm_job"."request_payload" is null and "agent_task_llm_job"."dispatch_count" = 1 and "agent_task_llm_job"."dispatch_token" is not null and "agent_task_llm_job"."dispatch_run_id" is not null and "agent_task_llm_job"."dispatch_granted_at" is not null and "agent_task_llm_job"."dispatch_deadline_at" is not null and "agent_task_llm_job"."unknown_at" is not null and "agent_task_llm_job"."completed_at" is null and "agent_task_llm_job"."cancelled_at" is null) or ("agent_task_llm_job"."status" = 'cancelled' and "agent_task_llm_job"."request_payload" is null and "agent_task_llm_job"."dispatch_count" = 0 and "agent_task_llm_job"."dispatch_token" is null and "agent_task_llm_job"."dispatch_run_id" is null and "agent_task_llm_job"."dispatch_granted_at" is null and "agent_task_llm_job"."dispatch_deadline_at" is null and "agent_task_llm_job"."unknown_at" is null and "agent_task_llm_job"."completed_at" is null and "agent_task_llm_job"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "agent_task_llm_result" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"kind" "agent_task_llm_result_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"result_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_task_llm_result_hash_format" CHECK ("agent_task_llm_result"."result_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_task_llm_result_payload_bounded" CHECK (jsonb_typeof("agent_task_llm_result"."payload") = 'object' and octet_length("agent_task_llm_result"."payload"::text) <= 1048576)
);
--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "checkpoint_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "checkpoint_payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "checkpoint_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD COLUMN "workflow_version" integer;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD COLUMN "execution_plan" jsonb;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD COLUMN "execution_plan_hash" text;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "task_agent_execution"
SET "workflow_version" = 1,
	"execution_plan" = '{"version":1,"steps":[]}'::jsonb,
	"execution_plan_hash" = 'a5dd3ce7993c63ad01d8a9a45922bc5f17d2c41c5f21a10671ec8c05c5ffc4aa',
	"started_at" = "created_at";--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "workflow_version" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "workflow_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "execution_plan" SET DEFAULT '{"version":1,"steps":[]}'::jsonb;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "execution_plan" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "execution_plan_hash" SET DEFAULT 'a5dd3ce7993c63ad01d8a9a45922bc5f17d2c41c5f21a10671ec8c05c5ffc4aa';--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "execution_plan_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "task_agent_execution" ALTER COLUMN "started_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_task_llm_authorization" ADD CONSTRAINT "agent_task_llm_authorization_job_id_agent_task_llm_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_task_llm_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_llm_authorization" ADD CONSTRAINT "agent_task_llm_authorization_spend_id_llm_spend_id_fk" FOREIGN KEY ("spend_id") REFERENCES "public"."llm_spend"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_llm_job" ADD CONSTRAINT "agent_task_llm_job_task_agent_execution_id_task_agent_execution_id_fk" FOREIGN KEY ("task_agent_execution_id") REFERENCES "public"."task_agent_execution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_llm_job" ADD CONSTRAINT "agent_task_llm_job_spend_id_llm_spend_id_fk" FOREIGN KEY ("spend_id") REFERENCES "public"."llm_spend"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_llm_result" ADD CONSTRAINT "agent_task_llm_result_job_id_agent_task_llm_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_task_llm_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_llm_authorization_job_day_key" ON "agent_task_llm_authorization" USING btree ("job_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_llm_authorization_spend_key" ON "agent_task_llm_authorization" USING btree ("spend_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_llm_authorization_job_granted_key" ON "agent_task_llm_authorization" USING btree ("job_id") WHERE "agent_task_llm_authorization"."decision" = 'granted';--> statement-breakpoint
CREATE INDEX "agent_task_llm_authorization_day_decision_idx" ON "agent_task_llm_authorization" USING btree ("day","decision");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_llm_job_job_key" ON "agent_task_llm_job" USING btree ("job_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_llm_job_execution_step_attempt_key" ON "agent_task_llm_job" USING btree ("task_agent_execution_id","step_key","provider_attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_llm_job_spend_key" ON "agent_task_llm_job" USING btree ("spend_id") WHERE "agent_task_llm_job"."spend_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_task_llm_job_execution_idx" ON "agent_task_llm_job" USING btree ("task_agent_execution_id");--> statement-breakpoint
CREATE INDEX "agent_task_llm_job_status_idx" ON "agent_task_llm_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_task_llm_job_status_deadline_idx" ON "agent_task_llm_job" USING btree ("status","dispatch_deadline_at");--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD CONSTRAINT "task_agent_execution_workflow_version_positive" CHECK ("task_agent_execution"."workflow_version" > 0);--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD CONSTRAINT "task_agent_execution_plan_bounded" CHECK (jsonb_typeof("task_agent_execution"."execution_plan") = 'object' and octet_length("task_agent_execution"."execution_plan"::text) <= 65536);--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD CONSTRAINT "task_agent_execution_plan_hash_format" CHECK ("task_agent_execution"."execution_plan_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "task_agent_execution" ADD CONSTRAINT "task_agent_execution_terminal_fields_consistent" CHECK (("task_agent_execution"."status" = 'active' and "task_agent_execution"."checkpoint_kind" is null and "task_agent_execution"."checkpoint_payload" is null and "task_agent_execution"."checkpoint_hash" is null and "task_agent_execution"."outcome_payload" is null and "task_agent_execution"."outcome_hash" is null and "task_agent_execution"."committed_at" is null and "task_agent_execution"."abandoned_at" is null and "task_agent_execution"."abandon_reason" is null) or ("task_agent_execution"."status" = 'ready' and "task_agent_execution"."checkpoint_kind" is not null and "task_agent_execution"."checkpoint_payload" is not null and "task_agent_execution"."checkpoint_hash" is not null and "task_agent_execution"."outcome_payload" is null and "task_agent_execution"."outcome_hash" is null and "task_agent_execution"."committed_at" is null and "task_agent_execution"."abandoned_at" is null and "task_agent_execution"."abandon_reason" is null) or ("task_agent_execution"."status" = 'committed' and "task_agent_execution"."checkpoint_kind" is not null and "task_agent_execution"."checkpoint_payload" is not null and "task_agent_execution"."checkpoint_hash" is not null and "task_agent_execution"."outcome_payload" is not null and "task_agent_execution"."outcome_hash" is not null and "task_agent_execution"."committed_at" is not null and "task_agent_execution"."abandoned_at" is null and "task_agent_execution"."abandon_reason" is null) or ("task_agent_execution"."status" = 'abandoned' and (("task_agent_execution"."checkpoint_kind" is null and "task_agent_execution"."checkpoint_payload" is null and "task_agent_execution"."checkpoint_hash" is null) or ("task_agent_execution"."checkpoint_kind" is not null and "task_agent_execution"."checkpoint_payload" is not null and "task_agent_execution"."checkpoint_hash" is not null)) and "task_agent_execution"."outcome_payload" is null and "task_agent_execution"."outcome_hash" is null and "task_agent_execution"."committed_at" is null and "task_agent_execution"."abandoned_at" is not null and "task_agent_execution"."abandon_reason" is not null));
