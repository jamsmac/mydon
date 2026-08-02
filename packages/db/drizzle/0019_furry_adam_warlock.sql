ALTER TABLE "agent" ADD COLUMN "budget_on_exceeded" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "web_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "break_glass" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "idea_channels" jsonb DEFAULT '[]'::jsonb NOT NULL;