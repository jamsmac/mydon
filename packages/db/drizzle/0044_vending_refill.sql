CREATE TABLE "vending_refill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid,
	"machine_serial" text NOT NULL,
	"coil_id" text,
	"product_id" uuid,
	"product_name" text NOT NULL,
	"qty" integer NOT NULL,
	"person_id" uuid,
	"task_id" uuid,
	"performed_at" timestamp with time zone NOT NULL,
	"client_key" text NOT NULL,
	"source" text DEFAULT 'bot' NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vending_refill_qty_positive" CHECK ("vending_refill"."qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "vending_refill" ADD CONSTRAINT "vending_refill_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vending_refill" ADD CONSTRAINT "vending_refill_product_id_vending_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."vending_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vending_refill" ADD CONSTRAINT "vending_refill_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vending_refill" ADD CONSTRAINT "vending_refill_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vending_refill_machine_idx" ON "vending_refill" USING btree ("machine_serial","performed_at" desc);--> statement-breakpoint
CREATE INDEX "vending_refill_person_idx" ON "vending_refill" USING btree ("person_id","performed_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "vending_refill_client_key" ON "vending_refill" USING btree ("client_key");