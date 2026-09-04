-- Инвентаризация узлов (спека vendhub-parts, R-PU-7, У4): сессия по месту + строки.
-- Ничего не удаляется и не переписывается: только новые таблицы и enum.
CREATE TYPE "public"."part_count_result" AS ENUM('found', 'new', 'missing', 'reversed');
--> statement-breakpoint
CREATE TABLE "part_count_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location" "part_location" NOT NULL,
	"warehouse_id" uuid,
	"person_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"applied_by" text,
	"reverses_id" uuid,
	"note" text,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_count_session_off_machine" CHECK ("part_count_session"."location" <> 'machine')
);

--> statement-breakpoint
CREATE TABLE "part_count_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"part_unit_id" uuid,
	"part_kind" "part_kind" NOT NULL,
	"inventory_no_entered" text,
	"serial_entered" text,
	"set_number_entered" integer,
	"hopper_position_entered" integer,
	"photo_skipped_reason" text,
	"result" "part_count_result",
	"prev_location" "part_location",
	"prev_machine_id" uuid,
	"prev_slot" integer,
	"client_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "part_count_session" ADD CONSTRAINT "part_count_session_warehouse_id_entity_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "part_count_session" ADD CONSTRAINT "part_count_session_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "part_count_line" ADD CONSTRAINT "part_count_line_session_id_part_count_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."part_count_session"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "part_count_line" ADD CONSTRAINT "part_count_line_part_unit_id_part_unit_id_fk" FOREIGN KEY ("part_unit_id") REFERENCES "public"."part_unit"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "part_count_line" ADD CONSTRAINT "part_count_line_prev_machine_id_entity_id_fk" FOREIGN KEY ("prev_machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "part_count_session_location_idx" ON "part_count_session" USING btree ("location","started_at");
--> statement-breakpoint
CREATE INDEX "part_count_line_session_idx" ON "part_count_line" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "part_count_line_client_key" ON "part_count_line" USING btree ("client_key") WHERE client_key is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "part_count_line_unit_key" ON "part_count_line" USING btree ("session_id","part_unit_id") WHERE part_unit_id is not null;
