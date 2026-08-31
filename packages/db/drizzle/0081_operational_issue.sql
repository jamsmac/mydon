CREATE TYPE "public"."operational_issue_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "operational_projection_state" (
	"key" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_projection_state_key_nonempty" CHECK (char_length(btrim("operational_projection_state"."key")) > 0)
);--> statement-breakpoint
CREATE TABLE "operational_issue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" "domain" NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"scope_date" date NOT NULL,
	"scope_key" text NOT NULL,
	"status" "operational_issue_status" DEFAULT 'open' NOT NULL,
	"episode" integer DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_issue_episode_positive" CHECK ("operational_issue"."episode" >= 1),
	CONSTRAINT "operational_issue_kind_nonempty" CHECK (char_length(btrim("operational_issue"."kind")) > 0),
	CONSTRAINT "operational_issue_scope_key_nonempty" CHECK (char_length(btrim("operational_issue"."scope_key")) > 0),
	CONSTRAINT "operational_issue_fingerprint_sha256" CHECK ("operational_issue"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "operational_issue_resolution_consistent" CHECK (("operational_issue"."status" = 'open' and "operational_issue"."resolved_at" is null) or ("operational_issue"."status" = 'resolved' and "operational_issue"."resolved_at" is not null))
);--> statement-breakpoint
ALTER TABLE "operational_issue" ADD CONSTRAINT "operational_issue_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_issue_kind_fingerprint_key" ON "operational_issue" USING btree ("kind","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_issue_task_key" ON "operational_issue" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "operational_issue_open_domain_idx" ON "operational_issue" USING btree ("domain","last_seen_at") WHERE "operational_issue"."status" = 'open';--> statement-breakpoint
CREATE INDEX "operational_issue_open_kind_date_idx" ON "operational_issue" USING btree ("kind","scope_date") WHERE "operational_issue"."status" = 'open';--> statement-breakpoint
CREATE INDEX "operational_issue_kind_date_idx" ON "operational_issue" USING btree ("kind","scope_date");--> statement-breakpoint
CREATE INDEX "operational_issue_scope_date_idx" ON "operational_issue" USING btree ("scope_date");
