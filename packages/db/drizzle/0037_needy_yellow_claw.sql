CREATE TABLE "globerent_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"domain" "domain" DEFAULT 'globerent' NOT NULL,
	"code" text NOT NULL,
	"model_id" uuid,
	"name" text NOT NULL,
	"year" integer,
	"vin" text,
	"status" text DEFAULT 'NEW_REQUEST' NOT NULL,
	"sales_stage" text,
	"lost_reason" text,
	"sales_price" numeric(18, 2),
	"client_id" uuid,
	"contract_id" uuid,
	"arrival_date" date,
	"declaration_type" text,
	"declaration_number" text,
	"declaration_date" date,
	"transport_company" text,
	"notes" text,
	"created_from" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_reserve" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"client_id" uuid,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "globerent_unit" ADD CONSTRAINT "globerent_unit_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "globerent_unit" ADD CONSTRAINT "globerent_unit_model_id_entity_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "globerent_unit" ADD CONSTRAINT "globerent_unit_client_id_entity_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "globerent_unit" ADD CONSTRAINT "globerent_unit_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_reserve" ADD CONSTRAINT "unit_reserve_unit_id_globerent_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."globerent_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_reserve" ADD CONSTRAINT "unit_reserve_client_id_entity_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_globerent_unit_code" ON "globerent_unit" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "globerent_unit_status_idx" ON "globerent_unit" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "globerent_unit_contract_idx" ON "globerent_unit" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_globerent_unit_vin" ON "globerent_unit" USING btree ("vin") WHERE vin is not null and vin <> '';--> statement-breakpoint
CREATE INDEX "unit_reserve_unit_idx" ON "unit_reserve" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_unit_reserve_active" ON "unit_reserve" USING btree ("unit_id") WHERE status = 'active';