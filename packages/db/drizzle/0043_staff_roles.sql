CREATE TABLE "staff_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_chat_id" text,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_staff_invite_code" ON "staff_invite" USING btree ("code_hash") WHERE used_at is null and revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_staff_invite_one_active" ON "staff_invite" USING btree ("person_id") WHERE used_at is null and revoked_at is null;--> statement-breakpoint
CREATE INDEX "staff_invite_person_idx" ON "staff_invite" USING btree ("person_id");