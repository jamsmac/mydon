CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text DEFAULT 'photo' NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text,
	"bytes" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attachment_owner_idx" ON "attachment" USING btree ("owner_type","owner_id");