CREATE TYPE "public"."machine_kind" AS ENUM('coffee', 'snack', 'drink', 'combo', 'other');--> statement-breakpoint
CREATE TABLE "machine_card" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"kind" "machine_kind" NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_card" ADD CONSTRAINT "machine_card_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;