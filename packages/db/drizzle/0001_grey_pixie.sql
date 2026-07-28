CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"business" text DEFAULT 'shared' NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"description" text,
	"mission" text,
	"non_goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"autonomy_default" "approval_tier" DEFAULT 'T1' NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_per_day_usd" numeric(10, 2),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "agent_status_idx" ON "agent" USING btree ("status");