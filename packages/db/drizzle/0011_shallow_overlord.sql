CREATE TABLE "raw_report_def" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_code" text NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"ru" text DEFAULT '' NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"roles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_source_def" (
	"code" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_raw_report_def" ON "raw_report_def" USING btree ("source_code","code");