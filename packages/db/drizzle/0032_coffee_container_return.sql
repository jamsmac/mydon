CREATE TABLE "coffee_container_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"container_number" integer NOT NULL,
	"weight" integer NOT NULL,
	"returned_date" date NOT NULL,
	"location_note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coffee_container_return_position_range" CHECK ("coffee_container_return"."position" between 1 and 8),
	CONSTRAINT "coffee_container_return_container_range" CHECK ("coffee_container_return"."container_number" between 1 and 27),
	CONSTRAINT "coffee_container_return_weight_range" CHECK ("coffee_container_return"."weight" between 0 and 10000)
);
--> statement-breakpoint
CREATE INDEX "coffee_container_return_container_idx" ON "coffee_container_return" USING btree ("container_number","returned_date");