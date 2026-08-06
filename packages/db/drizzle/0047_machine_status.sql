CREATE TYPE "public"."machine_status" AS ENUM('in_service', 'warehouse', 'repair');--> statement-breakpoint
ALTER TABLE "machine_card" ADD COLUMN "status" "machine_status" DEFAULT 'in_service' NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_card" ADD COLUMN "status_note" text;--> statement-breakpoint
ALTER TABLE "machine_card" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
-- Два автомата парка не в поле — со слов владельца 07.08.2026.
-- Остальные остаются в умолчании `in_service`: парк работает, и молчаливое
-- исключение автомата из обслуживания опаснее лишней задачи.
--
-- Даты НЕ подставляем `now()`. Признак заводится ровно потому, что система
-- записывала догадки как факты, и первая же строка миграции не должна
-- повторить эту ошибку. Для автомата в ремонте дата известна со слов
-- владельца (05.08.2026), для склада — нет, и там остаётся NULL: «состояние
-- с неизвестной даты». Прецедент — `start_date` у размещения, где nullable
-- заведён ровно для этого случая.
--
-- Автор смены не пишется по той же причине: миграция — не владелец. Первая
-- же правка через PATCH /entities/:id/machine-status проставит `updated_by`.
--
-- Двум новым автоматам (2508160355, 2508160358) состояние НЕ проставляем:
-- «новые и ещё не заведены» — про реестр, а не про то, стоят ли они в поле.
--
-- На пустой базе (CI прогоняет цепочку с нуля) обновит ноль строк.
UPDATE "machine_card" mc
SET "status" = 'warehouse',
    "status_note" = 'Стоит на складе (со слов владельца 07.08.2026; дата постановки неизвестна)'
FROM "entity" e
WHERE e.id = mc.entity_id AND e.external_ref = 'da0a191f0000';--> statement-breakpoint
UPDATE "machine_card" mc
SET "status" = 'repair',
    "status_note" = 'Отправлен в ремонт (со слов владельца 07.08.2026)',
    "status_changed_at" = timestamptz '2026-08-05 00:00:00+05'
FROM "entity" e
WHERE e.id = mc.entity_id AND e.external_ref = '039ec91c0000';
