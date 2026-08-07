-- Срез Б: справочник мест вливается в реестр.
--
-- ЗАЧЕМ. Мест в системе было три штуки в разных домах: кофейные точки в своей
-- таблице `coffee_location`, склады типом карточки `entity type='warehouse'`
-- (в коде, без единой записи), а мастерских не было вовсе. Владелец 07.08.2026
-- попросил заводить места ремонта и хранения — и без слияния это дало бы
-- четвёртый дом.
--
-- ПОЧЕМУ В РЕЕСТР, А НЕ ПЕРЕИМЕНОВАНИЕМ. У `coffee_location` нет и не было
-- своих координат: на карту точка попадала ЧЕРЕЗ колонку `entity_id`, ссылку
-- на стоящий там автомат. Переименование таблицы (как предполагал первый
-- вариант ТЗ) отобрало бы у точек карту вместе с этой колонкой. В реестре
-- координаты уже есть: `geo_point.entity_id` — первичный ключ со ссылкой на
-- `entity`, и место получает карту, утверждение владельцем и вложения даром.
--
-- ИДЕНТИФИКАТОРЫ СОХРАНЯЮТСЯ. Точка становится карточкой С ТЕМ ЖЕ UUID,
-- поэтому шесть таблиц с `location_id` просто перецеливают внешний ключ, а
-- значения не трогаются вовсе: 1143 заливки, 25 размещений, мойки, расходники
-- и продажи остаются связанными с теми же местами.

-- 1. Точки → карточки реестра. Направление то же, что у автоматов (vendhub).
INSERT INTO "entity" (id, org_id, type, name, attrs, approved_at, approved_by, created_from, created_at, updated_at)
SELECT cl.id,
       (SELECT o.id FROM "org" o WHERE o.code = 'vendhub' LIMIT 1),
       'location',
       cl.name,
       '{}'::jsonb,
       -- Точки завёл владелец и по ним годами идёт работа: считать их
       -- неутверждёнными значило бы объявить фактом не то, что работает.
       now(),
       'owner',
       'coffee_location',
       cl.created_at,
       now()
FROM "coffee_location" cl;--> statement-breakpoint

-- 2. Координаты: берём у автомата, который на точке стоит.
--
-- Это не догадка — это ровно тот путь, которым точка попадала на карту до сих
-- пор (через coffee_location.entity_id). Переносим связь в данные, пока
-- колонка ещё существует. У 24 из 28 точек координаты есть.
INSERT INTO "geo_point" (entity_id, lat, lng, address, updated_at)
SELECT cl.id, g.lat, g.lng, g.address, now()
FROM "coffee_location" cl
JOIN "geo_point" g ON g.entity_id = cl.entity_id
WHERE cl.entity_id IS NOT NULL
ON CONFLICT (entity_id) DO NOTHING;--> statement-breakpoint

-- 3. Внешние ключи шести таблиц перецеливаем на реестр. Значения не меняются.
ALTER TABLE "coffee_consumable" DROP CONSTRAINT "coffee_consumable_location_id_coffee_location_id_fk";--> statement-breakpoint
ALTER TABLE "coffee_consumable" ADD CONSTRAINT "coffee_consumable_location_id_entity_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."entity"("id");--> statement-breakpoint
ALTER TABLE "coffee_refill" DROP CONSTRAINT "coffee_refill_location_id_coffee_location_id_fk";--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD CONSTRAINT "coffee_refill_location_id_entity_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."entity"("id");--> statement-breakpoint
ALTER TABLE "coffee_sale" DROP CONSTRAINT "coffee_sale_location_id_coffee_location_id_fk";--> statement-breakpoint
ALTER TABLE "coffee_sale" ADD CONSTRAINT "coffee_sale_location_id_entity_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."entity"("id");--> statement-breakpoint
ALTER TABLE "coffee_wash_log" DROP CONSTRAINT "coffee_wash_log_location_id_coffee_location_id_fk";--> statement-breakpoint
ALTER TABLE "coffee_wash_log" ADD CONSTRAINT "coffee_wash_log_location_id_entity_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."entity"("id");--> statement-breakpoint
ALTER TABLE "coffee_wash_schedule" DROP CONSTRAINT "coffee_wash_schedule_location_id_coffee_location_id_fk";--> statement-breakpoint
ALTER TABLE "coffee_wash_schedule" ADD CONSTRAINT "coffee_wash_schedule_location_id_entity_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."entity"("id");--> statement-breakpoint

-- 4. История размещений становится общей: она про ЛЮБОЙ автомат и ЛЮБОЕ место.
ALTER TABLE "coffee_machine_placement" DROP CONSTRAINT "coffee_machine_placement_location_id_coffee_location_id_fk";--> statement-breakpoint
ALTER TABLE "coffee_machine_placement" RENAME TO "machine_placement";--> statement-breakpoint
ALTER TABLE "machine_placement" ADD CONSTRAINT "machine_placement_location_id_entity_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."entity"("id");--> statement-breakpoint
ALTER INDEX "coffee_machine_placement_location_idx" RENAME TO "machine_placement_location_idx";--> statement-breakpoint
ALTER INDEX "coffee_machine_placement_entity_idx" RENAME TO "machine_placement_entity_idx";--> statement-breakpoint
ALTER INDEX "coffee_machine_placement_entity_open_key" RENAME TO "machine_placement_entity_open_key";--> statement-breakpoint

-- 5. «Один аппарат на месте» снимается — решение владельца 07.08.2026.
--
-- На точке может стоять несколько аппаратов, в том числе одинаковых, а склад и
-- мастерская многоместны по определению: второй сломанный автомат не должен
-- выселять первого. Обратный индекс — «аппарат стоит не более чем в одном
-- месте» — ОСТАЁТСЯ: это физика железа, верная для любого вида места.
DROP INDEX IF EXISTS "coffee_machine_placement_location_open_key";--> statement-breakpoint

-- 6. Денормализованный «текущий аппарат точки» больше не выразим: аппаратов
--    может быть несколько. Текущий состав считается из размещений по
--    `end_date is null` — там он и был, просто читать было дешевле из колонки.
DROP TABLE "coffee_location";
