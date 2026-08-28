-- Приёмка задачи менеджером и отметка «тебе поручили» (срез П7).
-- Колонки, а не пятое значение task_status: существующие условия вида
-- status <> 'done' иначе посчитали бы принятую задачу открытой.
-- IF NOT EXISTS оставляет операторы безопасными при повторе. CONCURRENTLY не
-- используется: мигратор Drizzle применяет файл внутри транзакции.

ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "assign_notified_at" timestamp with time zone;--> statement-breakpoint

-- Старые назначения считаются уже доставленными: первый тик после деплоя
-- не должен разослать сотрудникам старые задачи как новые.
UPDATE "task"
   SET "assign_notified_at" = "created_at"
 WHERE "owner_ref" IS NOT NULL
   AND "assign_notified_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "task_assign_pending_idx"
    ON "task" USING btree ("owner_ref")
 WHERE "assign_notified_at" IS NULL AND "owner_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_awaiting_idx"
    ON "task" USING btree ("completed_at")
 WHERE "confirmed_at" IS NULL;
