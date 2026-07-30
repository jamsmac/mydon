ALTER TABLE "collection" ADD COLUMN "domain" "domain" DEFAULT 'vendhub' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "currency" text DEFAULT 'UZS' NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_stock" ADD COLUMN "domain" "domain" DEFAULT 'vendhub' NOT NULL;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "domain" "domain";--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "ext_id" text;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "collection_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase" ADD COLUMN "domain" "domain" DEFAULT 'vendhub' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase" ADD COLUMN "currency" text DEFAULT 'UZS' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale" ADD COLUMN "domain" "domain" DEFAULT 'vendhub' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale" ADD COLUMN "currency" text DEFAULT 'UZS' NOT NULL;--> statement-breakpoint
ALTER TABLE "money_flow" ADD CONSTRAINT "money_flow_collection_id_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "money_flow_source_ext_key" ON "money_flow" USING btree ("source","ext_id") WHERE "money_flow"."ext_id" is not null;--> statement-breakpoint
CREATE INDEX "money_flow_collection_idx" ON "money_flow" USING btree ("collection_id");