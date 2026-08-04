CREATE TABLE "contract_act" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"act_no" text NOT NULL,
	"act_date" date NOT NULL,
	"item_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signed_by_seller" text,
	"signed_by_buyer" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"domain" "domain" DEFAULT 'globerent' NOT NULL,
	"contract_no" text NOT NULL,
	"contract_date" date NOT NULL,
	"client_id" uuid,
	"buyer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seller_company_id" uuid,
	"total_with_vat" numeric(18, 2) NOT NULL,
	"total_vat" numeric(18, 2) NOT NULL,
	"pay_type" text,
	"warranty" text,
	"delivery_days" integer,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"doc_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"agent_id" uuid,
	"agent_commission_amount" numeric(18, 2),
	"agent_commission_currency" text,
	"created_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "money_flow" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "contract_act" ADD CONSTRAINT "contract_act_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_client_id_entity_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_seller_company_id_entity_id_fk" FOREIGN KEY ("seller_company_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_agent_id_entity_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_act_contract_idx" ON "contract_act" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_contract_org_no" ON "contract" USING btree ("org_id","contract_no");--> statement-breakpoint
CREATE INDEX "contract_org_date_idx" ON "contract" USING btree ("org_id","contract_date");--> statement-breakpoint
CREATE INDEX "contract_status_idx" ON "contract" USING btree ("status");--> statement-breakpoint
CREATE INDEX "contract_client_idx" ON "contract" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "money_flow" ADD CONSTRAINT "money_flow_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "money_flow_contract_idx" ON "money_flow" USING btree ("contract_id");