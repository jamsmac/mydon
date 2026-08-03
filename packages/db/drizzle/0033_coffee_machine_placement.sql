CREATE TABLE "coffee_machine_placement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"start_date" date,
	"end_date" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_machine_placement_dates" CHECK ("coffee_machine_placement"."end_date" is null or "coffee_machine_placement"."start_date" is null or "coffee_machine_placement"."end_date" >= "coffee_machine_placement"."start_date")
);
--> statement-breakpoint
ALTER TABLE "coffee_machine_placement" ADD CONSTRAINT "coffee_machine_placement_location_id_coffee_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."coffee_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coffee_machine_placement" ADD CONSTRAINT "coffee_machine_placement_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coffee_machine_placement_location_idx" ON "coffee_machine_placement" USING btree ("location_id","start_date");--> statement-breakpoint
CREATE INDEX "coffee_machine_placement_entity_idx" ON "coffee_machine_placement" USING btree ("entity_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_machine_placement_location_open_key" ON "coffee_machine_placement" USING btree ("location_id") WHERE "coffee_machine_placement"."end_date" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_machine_placement_entity_open_key" ON "coffee_machine_placement" USING btree ("entity_id") WHERE "coffee_machine_placement"."end_date" is null;--> statement-breakpoint
-- Бэкфилл: существующие привязки точка→аппарат становятся открытыми
-- размещениями «с неизвестной даты» — история начинается с текущего факта.
INSERT INTO "coffee_machine_placement" ("location_id", "entity_id")
SELECT "id", "entity_id" FROM "coffee_location" WHERE "entity_id" IS NOT NULL;
