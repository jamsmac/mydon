CREATE TYPE "public"."task_quality" AS ENUM('excellent', 'accepted', 'redo');--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "domain" "domain";--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "quality" "task_quality";