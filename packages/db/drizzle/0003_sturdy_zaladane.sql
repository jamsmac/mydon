CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TABLE "task_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_ref" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "tg_username" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "tg_chat_id" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "active" text DEFAULT 'yes' NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "priority" "task_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "result_note" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_comment_task_idx" ON "task_comment" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_owner_idx" ON "task" USING btree ("owner_kind","owner_ref");--> statement-breakpoint
CREATE INDEX "task_due_idx" ON "task" USING btree ("due");--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_tg_chat_id_unique" UNIQUE("tg_chat_id");