-- Карточка физического узла part_unit (спека 2026-09-04-vendhub-parts-inventory, срез У1).
--
-- Файл собран из автогенерации (снапшот 0084 свежий, снят с schema.ts) и
-- дописан руками: колонка machine_part.part_unit_id сначала nullable, затем
-- бэкфилл восстанавливает нить узла из существующих периодов, и только потом
-- NOT NULL. Автогенерация дала бы `ADD COLUMN ... NOT NULL` и упала бы на
-- первой же строке живой базы.
--
-- Правило бэкфилла (спека §4.5): part_install / part_remove закрывают один
-- период и открывают другой ТОГО ЖЕ узла (общий log_id), part_replace —
-- разных; одинаковый непустой серийник — тот же узел; всё остальное —
-- отдельные карточки. Узел, у которого после бэкфилла нет открытого периода
-- (снят заменой до 0084 — swapPart не открывал период «вне автомата»),
-- считается «местонахождение неизвестно» и выправляется инвентаризацией.
--
-- Новые значения enum ('return', 'unknown') здесь только добавляются и НЕ
-- используются: постгрес запрещает использовать новое значение в той же
-- транзакции, а мигратор гонит файл одной транзакцией.
CREATE TYPE "public"."part_unit_origin" AS ENUM('auto', 'manual', 'count', 'backfill');
--> statement-breakpoint
ALTER TYPE "public"."stock_movement_kind" ADD VALUE 'return';
--> statement-breakpoint
ALTER TYPE "public"."part_location" ADD VALUE 'unknown';
--> statement-breakpoint
CREATE TABLE "part_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_kind" "part_kind" NOT NULL,
	"inventory_no" text,
	"label_pending" boolean DEFAULT false NOT NULL,
	"serial_number" text,
	"model" text,
	"manufacturer" text,
	"set_number" integer,
	"hopper_position" integer,
	"tare_weight" integer,
	"purchase_date" date,
	"purchase_price" numeric(14, 2),
	"warranty_until" date,
	"retired_at" date,
	"retired_reason" text,
	"origin" "part_unit_origin" DEFAULT 'manual' NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_unit_set_range" CHECK ("part_unit"."set_number" is null or "part_unit"."set_number" between 1 and 99),
	CONSTRAINT "part_unit_position_range" CHECK ("part_unit"."hopper_position" is null or "part_unit"."hopper_position" between 1 and 8),
	CONSTRAINT "part_unit_hopper_fields" CHECK (("part_unit"."set_number" is null and "part_unit"."hopper_position" is null) or "part_unit"."part_kind" = 'hopper'),
	CONSTRAINT "part_unit_tare_nonneg" CHECK ("part_unit"."tare_weight" is null or "part_unit"."tare_weight" >= 0)
);

--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD COLUMN "part_unit_id" uuid;
--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD COLUMN "stock_movement_id" uuid;
--> statement-breakpoint
ALTER TABLE "coffee_container_return" ADD COLUMN "part_unit_id" uuid;
--> statement-breakpoint
ALTER TABLE "coffee_container_return" ADD COLUMN "ingredient_id" uuid;
--> statement-breakpoint
ALTER TABLE "coffee_container_return" ADD COLUMN "net_weight" integer;
--> statement-breakpoint
ALTER TABLE "coffee_container_return" ADD COLUMN "stock_movement_id" uuid;
--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD COLUMN "part_unit_id" uuid;
--> statement-breakpoint
ALTER TABLE "machine_part" ADD COLUMN "part_unit_id" uuid;
--> statement-breakpoint
DO $$
DECLARE
  r record;
  v_unit uuid;
BEGIN
  FOR r IN
    SELECT mp.*, il.kind AS install_kind
      FROM machine_part mp
      LEFT JOIN maintenance_log il ON il.id = mp.install_log_id
     ORDER BY mp.installed_on, mp.created_at, mp.id
  LOOP
    v_unit := NULL;

    -- 1. Тот же узел, снятый/перенесённый этой же записью журнала: снятие с
    --    автомата открывает период «на складе/мойке» (removePart), установка
    --    со склада закрывает складской период (installPart). Замена
    --    (part_replace) связывает РАЗНЫЕ узлы — её не берём.
    IF r.install_log_id IS NOT NULL AND r.install_kind IN ('part_install', 'part_remove') THEN
      SELECT mp2.part_unit_id INTO v_unit
        FROM machine_part mp2
       WHERE mp2.remove_log_id = r.install_log_id
         AND mp2.id <> r.id
         AND mp2.part_unit_id IS NOT NULL
       ORDER BY mp2.removed_on DESC
       LIMIT 1;
    END IF;

    -- 2. Тот же непустой серийник того же вида — тот же узел.
    IF v_unit IS NULL AND r.serial_number IS NOT NULL AND btrim(r.serial_number) <> '' THEN
      SELECT mp2.part_unit_id INTO v_unit
        FROM machine_part mp2
       WHERE mp2.serial_number = r.serial_number
         AND mp2.part_kind = r.part_kind
         AND mp2.part_unit_id IS NOT NULL
       ORDER BY mp2.installed_on DESC
       LIMIT 1;
    END IF;

    -- Страховка: у узла не может быть двух открытых периодов (индекс ниже).
    -- Один серийник на двух автоматах сразу — ошибка ввода, а не один узел:
    -- такому периоду заводим отдельную карточку, чтобы миграция не упала.
    IF v_unit IS NOT NULL AND r.removed_on IS NULL AND EXISTS (
      SELECT 1 FROM machine_part mp3 WHERE mp3.part_unit_id = v_unit AND mp3.removed_on IS NULL
    ) THEN
      v_unit := NULL;
    END IF;

    -- 3. Иначе — новая карточка из того, что знал период.
    IF v_unit IS NULL THEN
      INSERT INTO part_unit (part_kind, serial_number, model, warranty_until, origin, note, created_by, created_at)
      VALUES (
        r.part_kind,
        NULLIF(btrim(r.serial_number), ''),
        r.model,
        r.warranty_until,
        'backfill',
        'заведено миграцией 0084 из истории периодов machine_part',
        r.created_by,
        r.created_at
      )
      RETURNING id INTO v_unit;
    END IF;

    UPDATE machine_part SET part_unit_id = v_unit WHERE id = r.id;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "machine_part" ALTER COLUMN "part_unit_id" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "part_unit_inventory_no_key" ON "part_unit" USING btree (upper(regexp_replace("inventory_no", '\s', '', 'g'))) WHERE inventory_no is not null;
--> statement-breakpoint
CREATE INDEX "part_unit_kind_idx" ON "part_unit" USING btree ("part_kind");
--> statement-breakpoint
CREATE INDEX "part_unit_serial_idx" ON "part_unit" USING btree ("serial_number") WHERE serial_number is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "part_unit_hopper_set_key" ON "part_unit" USING btree ("set_number","hopper_position") WHERE set_number is not null and hopper_position is not null;
--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD CONSTRAINT "coffee_refill_part_unit_id_part_unit_id_fk" FOREIGN KEY ("part_unit_id") REFERENCES "public"."part_unit"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "coffee_refill" ADD CONSTRAINT "coffee_refill_stock_movement_id_stock_movement_id_fk" FOREIGN KEY ("stock_movement_id") REFERENCES "public"."stock_movement"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "coffee_container_return" ADD CONSTRAINT "coffee_container_return_part_unit_id_part_unit_id_fk" FOREIGN KEY ("part_unit_id") REFERENCES "public"."part_unit"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "coffee_container_return" ADD CONSTRAINT "coffee_container_return_ingredient_id_coffee_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."coffee_ingredient"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "coffee_container_return" ADD CONSTRAINT "coffee_container_return_stock_movement_id_stock_movement_id_fk" FOREIGN KEY ("stock_movement_id") REFERENCES "public"."stock_movement"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "maintenance_log" ADD CONSTRAINT "maintenance_log_part_unit_id_part_unit_id_fk" FOREIGN KEY ("part_unit_id") REFERENCES "public"."part_unit"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "machine_part" ADD CONSTRAINT "machine_part_part_unit_id_part_unit_id_fk" FOREIGN KEY ("part_unit_id") REFERENCES "public"."part_unit"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "machine_part_unit_open_key" ON "machine_part" USING btree ("part_unit_id") WHERE removed_on is null;
--> statement-breakpoint
CREATE INDEX "machine_part_unit_idx" ON "machine_part" USING btree ("part_unit_id","installed_on");
