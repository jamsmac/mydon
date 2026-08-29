CREATE TYPE "public"."llm_billing_kind" AS ENUM('metered', 'subscription');--> statement-breakpoint
CREATE TYPE "public"."llm_ledger_consumer" AS ENUM('agents', 'bot', 'cc', 'documents', 'embeddings');--> statement-breakpoint
CREATE TYPE "public"."llm_settlement_kind" AS ENUM('tokens', 'provider_reported');--> statement-breakpoint
CREATE TYPE "public"."llm_settlement_outcome" AS ENUM('success', 'provider_error', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."llm_spend_status" AS ENUM('reserved', 'settled', 'failed', 'released', 'denied');--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent_execution_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent_execution_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent_execution_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent_execution_blocked_reason" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent_run_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent_run_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_agent_run_generation_nonnegative" CHECK ("task"."agent_run_generation" >= 0);--> statement-breakpoint
CREATE TABLE "llm_model_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"billing_kind" "llm_billing_kind" DEFAULT 'metered' NOT NULL,
	"settlement_kind" "llm_settlement_kind" DEFAULT 'tokens' NOT NULL,
	"input_usd_per_mtok" numeric(24, 9) DEFAULT '0' NOT NULL,
	"output_usd_per_mtok" numeric(24, 9) DEFAULT '0' NOT NULL,
	"cache_read_usd_per_mtok" numeric(24, 9) DEFAULT '0' NOT NULL,
	"cache_write_5m_usd_per_mtok" numeric(24, 9) DEFAULT '0' NOT NULL,
	"cache_write_1h_usd_per_mtok" numeric(24, 9) DEFAULT '0' NOT NULL,
	"fixed_request_usd" numeric(24, 9) DEFAULT '0' NOT NULL,
	"reservation_ceiling_usd" numeric(24, 9),
	"code_execution_usd_per_request" numeric(24, 9) DEFAULT '0' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_model_price_valid_range" CHECK ("llm_model_price"."valid_to" is null or "llm_model_price"."valid_to" > "llm_model_price"."valid_from"),
	CONSTRAINT "llm_model_price_nonnegative" CHECK ("llm_model_price"."input_usd_per_mtok" >= 0 and "llm_model_price"."output_usd_per_mtok" >= 0 and "llm_model_price"."cache_read_usd_per_mtok" >= 0 and "llm_model_price"."cache_write_5m_usd_per_mtok" >= 0 and "llm_model_price"."cache_write_1h_usd_per_mtok" >= 0 and "llm_model_price"."fixed_request_usd" >= 0 and ("llm_model_price"."reservation_ceiling_usd" is null or "llm_model_price"."reservation_ceiling_usd" >= 0) and "llm_model_price"."code_execution_usd_per_request" >= 0)
);
--> statement-breakpoint
CREATE TABLE "llm_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"settlement_hash" text,
	"trace_key" text,
	"consumer" "llm_ledger_consumer" NOT NULL,
	"feature" text NOT NULL,
	"agent_id" uuid,
	"agent_name" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"resolved_model" text,
	"price_id" uuid,
	"price_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "llm_spend_status" NOT NULL,
	"outcome" "llm_settlement_outcome",
	"day" date NOT NULL,
	"input_token_ceiling" integer NOT NULL,
	"output_token_ceiling" integer NOT NULL,
	"reserved_usd" numeric(24, 9) DEFAULT '0' NOT NULL,
	"actual_usd" numeric(24, 9),
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_input_tokens" integer,
	"cache_creation_input_tokens" integer,
	"cache_creation_5m_input_tokens" integer,
	"cache_creation_1h_input_tokens" integer,
	"code_execution_requests" integer,
	"provider_request_id" text,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reserved_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_spend_money_nonnegative" CHECK ("llm_spend"."reserved_usd" >= 0 and ("llm_spend"."actual_usd" is null or "llm_spend"."actual_usd" >= 0)),
	CONSTRAINT "llm_spend_tokens_nonnegative" CHECK ("llm_spend"."input_token_ceiling" >= 0 and "llm_spend"."output_token_ceiling" >= 0 and ("llm_spend"."input_tokens" is null or "llm_spend"."input_tokens" >= 0) and ("llm_spend"."output_tokens" is null or "llm_spend"."output_tokens" >= 0) and ("llm_spend"."cache_read_input_tokens" is null or "llm_spend"."cache_read_input_tokens" >= 0) and ("llm_spend"."cache_creation_input_tokens" is null or "llm_spend"."cache_creation_input_tokens" >= 0) and ("llm_spend"."cache_creation_5m_input_tokens" is null or "llm_spend"."cache_creation_5m_input_tokens" >= 0) and ("llm_spend"."cache_creation_1h_input_tokens" is null or "llm_spend"."cache_creation_1h_input_tokens" >= 0) and ("llm_spend"."code_execution_requests" is null or "llm_spend"."code_execution_requests" >= 0))
);
--> statement-breakpoint
ALTER TABLE "llm_spend" ADD CONSTRAINT "llm_spend_price_id_llm_model_price_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."llm_model_price"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_model_price_active_provider_model_idx" ON "llm_model_price" USING btree ("provider","model") WHERE "llm_model_price"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "llm_model_price_lookup_idx" ON "llm_model_price" USING btree ("provider","model","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_spend_request_key_idx" ON "llm_spend" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_spend_provider_request_id_idx" ON "llm_spend" USING btree ("provider","provider_request_id") WHERE "llm_spend"."provider_request_id" is not null;--> statement-breakpoint
CREATE INDEX "llm_spend_day_status_idx" ON "llm_spend" USING btree ("day","status");--> statement-breakpoint
CREATE INDEX "llm_spend_agent_day_idx" ON "llm_spend" USING btree ("agent_id","day");--> statement-breakpoint
CREATE INDEX "llm_spend_trace_key_idx" ON "llm_spend" USING btree ("trace_key");--> statement-breakpoint
CREATE INDEX "llm_spend_provider_failed_at_idx" ON "llm_spend" USING btree ("provider","failed_at") WHERE "llm_spend"."failed_at" is not null;--> statement-breakpoint

-- Прайс — серверный справочник: клиент не может объявить другую цену.
-- Cache write 5m = 1.25x input, 1h = 2x input, cache read = 0.1x input.
-- Code execution считаем как один container minimum на Messages request:
-- 5 минут * $0.05/ч = $0.004166667; месячный free pool не применяем.
INSERT INTO "llm_model_price" (
	"provider", "model", "billing_kind", "settlement_kind",
	"input_usd_per_mtok", "output_usd_per_mtok",
	"cache_read_usd_per_mtok", "cache_write_5m_usd_per_mtok", "cache_write_1h_usd_per_mtok",
	"code_execution_usd_per_request", "valid_from"
) VALUES
	('anthropic', 'claude-opus-5', 'metered', 'tokens', 5, 25, 0.5, 6.25, 10, 0.004166667, '2026-08-29T00:00:00+05:00'),
	('anthropic', 'claude-sonnet-5', 'metered', 'tokens', 2, 10, 0.2, 2.5, 4, 0.004166667, '2026-08-29T00:00:00+05:00');
