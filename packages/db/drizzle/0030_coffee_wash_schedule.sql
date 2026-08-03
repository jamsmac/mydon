CREATE TABLE "coffee_wash_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"position" integer,
	"frequency_days" integer,
	"frequency_cups" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_wash_schedule_position_range" CHECK ("coffee_wash_schedule"."position" is null or "coffee_wash_schedule"."position" between 1 and 8),
	CONSTRAINT "coffee_wash_schedule_frequency_set" CHECK ("coffee_wash_schedule"."frequency_days" is not null or "coffee_wash_schedule"."frequency_cups" is not null)
);
--> statement-breakpoint
ALTER TABLE "coffee_wash_schedule" ADD CONSTRAINT "coffee_wash_schedule_location_id_coffee_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."coffee_location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_wash_schedule_location_position_key" ON "coffee_wash_schedule" USING btree ("location_id","position") WHERE "coffee_wash_schedule"."position" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "coffee_wash_schedule_location_whole_key" ON "coffee_wash_schedule" USING btree ("location_id") WHERE "coffee_wash_schedule"."position" is null;