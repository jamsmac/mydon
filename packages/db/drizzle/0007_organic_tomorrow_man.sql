CREATE TABLE "sale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dt" date NOT NULL,
	"machine_serial" text NOT NULL,
	"machine_id" uuid,
	"product" text NOT NULL,
	"qty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"source" text DEFAULT 'ourvend' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sale" ADD CONSTRAINT "sale_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_src_day_key" ON "sale" USING btree ("source","dt","machine_serial","product");--> statement-breakpoint
CREATE INDEX "sale_dt_idx" ON "sale" USING btree ("dt");--> statement-breakpoint
CREATE INDEX "sale_machine_idx" ON "sale" USING btree ("machine_id","dt");