-- Крышка бункера: состояние замера и вес крышки (решение владельца 12.09.2026,
-- отменяет допущение R-B-19 «взвешивают всегда с крышкой»).
--
-- Что добавляется и почему.
--   part_unit.lid_weight  — вес крышки ЭТОГО бункера (крышка пронумерована и
--     принадлежит своему бункеру). Знаем его — замеры «с крышкой» и «без»
--     приводятся друг к другу, и техник взвешивает так, как удобно на месте.
--   part_unit.tare_basis  — с чем взвешена хранимая тара. Умолчание with_lid:
--     до решения действовало правило «всегда с крышкой», так её и мерили.
--   coffee_refill.weighed_with_lid, coffee_container_return.weighed_with_lid —
--     состояние КАЖДОГО замера. Раньше состояние было требованием к человеку;
--     теперь это свойство записи, и разнобой «до/после» перестаёт давать
--     систематический сдвиг ровно в вес крышки каждый цикл.
--   CHECK'и: основание — одно из двух известных; вес крышки положительный и
--     не больше 800 г (LID_WEIGHT_MAX в @mydon/shared): «крышка 900 г» — это
--     перепутанные поля, а не крышка.
--
-- ЗАМЕР ПРОДА (12.09.2026, до выката): part_unit — 375 узлов, из них 200
-- бункеров, и тара известна лишь у 103 из них; coffee_refill — 1254 строки;
-- coffee_container_return — 1080. Все ADD COLUMN с DEFAULT на PG 11+ идут без
-- переписывания таблиц.
--
-- 97 бункеров без тары — это и есть случай R-B-15 «весы обязательны там, где
-- числа нет»: им состояние замера тем более важно, иначе первое же взвешивание
-- ляжет в неизвестном основании.
--
-- ЧЕГО МИГРАЦИЯ НЕ ДЕЛАЕТ: не выдумывает вес крышки (R-B-9). Пока он не
-- измерен, сравнение замеров в разных состояниях честно отказывает.
--
-- ОТКАТ (руками): ALTER TABLE part_unit DROP CONSTRAINT part_unit_lid_weight_sane,
-- DROP CONSTRAINT part_unit_tare_basis_known, DROP COLUMN lid_weight,
-- DROP COLUMN tare_basis; ALTER TABLE coffee_refill DROP COLUMN weighed_with_lid;
-- ALTER TABLE coffee_container_return DROP COLUMN weighed_with_lid; удалить
-- последнюю запись drizzle.__drizzle_migrations.

ALTER TABLE "coffee_container_return" ADD COLUMN "weighed_with_lid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD COLUMN "weighed_with_lid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "part_unit" ADD COLUMN "tare_basis" text DEFAULT 'with_lid' NOT NULL;--> statement-breakpoint
ALTER TABLE "part_unit" ADD COLUMN "lid_weight" integer;--> statement-breakpoint
ALTER TABLE "part_unit" ADD CONSTRAINT "part_unit_tare_basis_known" CHECK (tare_basis in ('with_lid', 'without_lid'));--> statement-breakpoint
ALTER TABLE "part_unit" ADD CONSTRAINT "part_unit_lid_weight_sane" CHECK (lid_weight is null or (lid_weight > 0 and lid_weight <= 800));