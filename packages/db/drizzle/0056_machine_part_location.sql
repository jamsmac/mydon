-- Узел вне автомата: machine_id становится NULL-able, место узла — part_location.
-- Снятый купюроприёмник в ремонте — это узел, который вернётся; раньше строка
-- «узел на складе» была невыразима, и снятие теряло экземпляр из учёта.
--
-- Файл написан руками (как 0049–0055): автогенерация diff'ится от снапшота
-- 0048 и тащит чужие правки. Снапшот 0056 при этом СВЕЖИЙ — снят с текущей
-- schema.ts, так что следующий db:generate снова честен.
CREATE TYPE "public"."part_location" AS ENUM('machine', 'warehouse', 'washing', 'drying', 'repair');--> statement-breakpoint
ALTER TYPE "public"."maintenance_kind" ADD VALUE 'part_install';--> statement-breakpoint
ALTER TYPE "public"."maintenance_kind" ADD VALUE 'part_remove';--> statement-breakpoint
ALTER TABLE "machine_part" ALTER COLUMN "machine_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_part" ADD COLUMN "location" "part_location" DEFAULT 'machine' NOT NULL;--> statement-breakpoint
DROP INDEX "machine_part_open_key";--> statement-breakpoint
-- Уникальность «одно место — один открытый узел» только на автоматах:
-- вне автомата (machine_id NULL) одинаковых узлов сколько угодно.
CREATE UNIQUE INDEX "machine_part_open_key" ON "machine_part" USING btree ("machine_id","part_kind",coalesce("slot", 0)) WHERE removed_on is null and machine_id is not null;--> statement-breakpoint
CREATE INDEX "machine_part_serial_idx" ON "machine_part" USING btree ("serial_number") WHERE serial_number is not null;--> statement-breakpoint
ALTER TABLE "machine_part" ADD CONSTRAINT "machine_part_location_matches" CHECK (("machine_part"."machine_id" is not null and "machine_part"."location" = 'machine') or ("machine_part"."machine_id" is null and "machine_part"."location" <> 'machine'));
