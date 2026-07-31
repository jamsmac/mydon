CREATE TABLE "entity_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"current" text,
	"origin" text NOT NULL,
	"set_by" text DEFAULT 'system' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "created_from" text;--> statement-breakpoint
ALTER TABLE "entity_draft" ADD CONSTRAINT "entity_draft_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_entity_draft" ON "entity_draft" USING btree ("entity_id","field");--> statement-breakpoint
-- Карточки, заведённые ДО этого правила, считаются утверждёнными: владелец уже
-- с ними работал и на них опирался. Объявить их все неутверждёнными задним
-- числом значило бы соврать про то, чего он не делал.
UPDATE "entity" SET "approved_at" = now(), "approved_by" = 'заведено до правила утверждения'
WHERE "approved_at" IS NULL;
