CREATE TABLE "gr_import_contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"domain" "domain" DEFAULT 'globerent' NOT NULL,
	"contract_no" text NOT NULL,
	"contract_date" date NOT NULL,
	"supplier_id" uuid,
	"currency" text DEFAULT 'USD' NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"purpose" text DEFAULT 'for_stock' NOT NULL,
	"sale_contract_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"lifecycle_status" text DEFAULT 'draft' NOT NULL,
	"prepayment_amount" numeric(18, 2),
	"prepayment_due_date" date,
	"prepayment_paid_at" timestamp with time zone,
	"balance_amount" numeric(18, 2),
	"balance_due_date" date,
	"balance_paid_at" timestamp with time zone,
	"notes" text,
	"created_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "globerent_unit" ADD COLUMN "import_contract_id" uuid;--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "import_contract_id" uuid;--> statement-breakpoint
ALTER TABLE "gr_import_contract" ADD CONSTRAINT "gr_import_contract_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gr_import_contract" ADD CONSTRAINT "gr_import_contract_supplier_id_entity_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gr_import_contract" ADD CONSTRAINT "gr_import_contract_sale_contract_id_contract_id_fk" FOREIGN KEY ("sale_contract_id") REFERENCES "public"."contract"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_import_contract_supplier_no" ON "gr_import_contract" USING btree ("supplier_id","contract_no");--> statement-breakpoint
CREATE INDEX "gr_import_contract_org_idx" ON "gr_import_contract" USING btree ("org_id","contract_date");--> statement-breakpoint
CREATE INDEX "gr_import_contract_lifecycle_idx" ON "gr_import_contract" USING btree ("lifecycle_status");--> statement-breakpoint
ALTER TABLE "globerent_unit" ADD CONSTRAINT "globerent_unit_import_contract_id_gr_import_contract_id_fk" FOREIGN KEY ("import_contract_id") REFERENCES "public"."gr_import_contract"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_flow" ADD CONSTRAINT "money_flow_import_contract_id_gr_import_contract_id_fk" FOREIGN KEY ("import_contract_id") REFERENCES "public"."gr_import_contract"("id") ON DELETE no action ON UPDATE no action;