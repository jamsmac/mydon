-- Волна 5 «Два времени операции» (R-H-1…R-H-4, R-H-12, R-H-13;
-- docs/SPEC_VVOD_ZADNIM_CHISLOM.md). Первая операция контура — заливка бункера.
--
-- Что добавляется и почему.
--   occurred_at       — КОГДА ПРОИЗОШЛА заливка, до минуты. Расчёты идут по
--                       нему: техник заливает утром, в панель это попадает
--                       вечером, а `entered_date` знает только день — две
--                       заливки одного бункера за день неразличимы по порядку.
--   occurred_precision— у строк ДО этой миграции известен только день, и их
--                       occurred_at = полночь Ташкента. Это НЕ «залили в 00:00»,
--                       и колонка отличает такую полночь от настоящей.
--   recorded_at       — КОГДА ЗАПИСАНО; аудит идёт по обоим временам.
--   approval_id       — запись задним числом ждёт одобрения владельца, но
--                       СЧИТАЕТСЯ сразу (R-H-13);
--   cancelled_at/by   — отклонение одобрения отменяет запись.
--
-- ЗАМЕР ПРОДА (12.09.2026, до выката): coffee_refill — 1254 строки,
-- 10.12.2025…11.09.2026. У 1135 день записи ≠ день события — это АВГУСТОВСКИЙ
-- ИМПОРТ истории из Telegram (в августе 1182 строки, 1135 «разных дней»); в
-- сентябре 72 строки и НИ ОДНОЙ задним числом. То есть обычная смена вводит в
-- тот же день, и очередь одобрений (R-H-12) не захлебнётся, а импорт истории
-- одобряется пачкой (R-H-15).
--
-- ПОЧЕМУ ТРИ ШАГА, А НЕ `ADD COLUMN NOT NULL`: на 1254 строках такой ADD
-- упал бы — значения нет. Добавляем nullable, заполняем из entered_date
-- (полночь Ташкента, смещение +5 зашито здесь так же, как в коде:
-- TASHKENT_OFFSET_MS), и только потом включаем NOT NULL.
--
-- ОТКАТ (руками): ALTER TABLE coffee_refill DROP COLUMN cancelled_by,
-- DROP COLUMN cancelled_at, DROP COLUMN approval_id, DROP COLUMN recorded_at,
-- DROP COLUMN occurred_precision, DROP COLUMN occurred_at; удалить последнюю
-- запись drizzle.__drizzle_migrations (0092 должна быть последней).
ALTER TABLE "coffee_refill" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD COLUMN "occurred_precision" text DEFAULT 'minute' NOT NULL;--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD COLUMN "recorded_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
UPDATE "coffee_refill"
   SET "occurred_at" = ("entered_date"::timestamp - interval '5 hours') AT TIME ZONE 'UTC',
       "occurred_precision" = 'day',
       "recorded_at" = "created_at"
 WHERE "occurred_at" IS NULL;--> statement-breakpoint
ALTER TABLE "coffee_refill" ALTER COLUMN "occurred_at" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "coffee_refill" ADD CONSTRAINT "coffee_refill_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD CONSTRAINT "coffee_refill_entered_date_matches_occurred" CHECK (((occurred_at at time zone 'UTC') + interval '5 hours')::date = entered_date);