CREATE TABLE "gr_preorder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"domain" "domain" DEFAULT 'globerent' NOT NULL,
	"code" text NOT NULL,
	"model_id" uuid,
	"name" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"client_id" uuid,
	"supplier_id" uuid,
	"contract_ref" text,
	"factory_price_usd" numeric(18, 2),
	"promised_delivery_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"cancelled_reason" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "gr_preorder" ADD CONSTRAINT "gr_preorder_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gr_preorder" ADD CONSTRAINT "gr_preorder_model_id_entity_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gr_preorder" ADD CONSTRAINT "gr_preorder_client_id_entity_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gr_preorder" ADD CONSTRAINT "gr_preorder_supplier_id_entity_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_gr_preorder_code" ON "gr_preorder" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "gr_preorder_status_idx" ON "gr_preorder" USING btree ("org_id","status");--> statement-breakpoint
ALTER TABLE "money_flow" ADD CONSTRAINT "money_flow_unit_id_globerent_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."globerent_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "money_flow_unit_idx" ON "money_flow" USING btree ("unit_id");