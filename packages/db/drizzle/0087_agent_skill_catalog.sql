-- Каталог навыков (зеркало файлов, R-SD-1) и явный навык/параметры запуска у задачи (R-SD-3/4), спека 2026-09-05-skills-deck-cron-llm.
CREATE TABLE "agent_skill_catalog" (
	"agent_name" text NOT NULL,
	"skill" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"executor" text NOT NULL,
	"tier" text,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_effort" text,
	"max_tokens" integer,
	"has_code" boolean DEFAULT false NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skill_catalog_agent_name_skill_pk" PRIMARY KEY("agent_name","skill")
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "agent_skill" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "run_options" jsonb;
--> statement-breakpoint
CREATE INDEX "task_agent_skill_idx" ON "task" ("owner_ref", "agent_skill", "created_at" DESC) WHERE "agent_skill" IS NOT NULL;