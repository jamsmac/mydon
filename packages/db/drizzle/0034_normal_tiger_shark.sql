CREATE TABLE "fx_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency" text NOT NULL,
	"rate" numeric(18, 4) NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"set_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "is_official" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "rate" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "amount_uzs" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "counterparty_id" uuid;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "counterparty" text;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "doc_no" text;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "fx_rate_currency_idx" ON "fx_rate" USING btree ("currency","created_at");--> statement-breakpoint
ALTER TABLE "money_flow" ADD CONSTRAINT "money_flow_counterparty_id_entity_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "money_flow_due_idx" ON "money_flow" USING btree ("domain","status","due_date");--> statement-breakpoint
CREATE INDEX "money_flow_counterparty_idx" ON "money_flow" USING btree ("counterparty_id");