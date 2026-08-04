CREATE TABLE "brv_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value_uzs" numeric(12, 2) NOT NULL,
	"valid_from" date NOT NULL,
	"note" text,
	"set_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tnved_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_ru" text NOT NULL,
	"vehicle_category" text DEFAULT 'spec_tech' NOT NULL,
	"import_duty_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"customs_fee_rate" numeric(7, 4) DEFAULT '0.002' NOT NULL,
	"excise_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"vat_rate" numeric(7, 4) DEFAULT '0.12' NOT NULL,
	"utilization_brv_count" integer DEFAULT 0 NOT NULL,
	"extra_duty_per_cc_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"registration_type" text DEFAULT 'gostechnadzor' NOT NULL,
	"cert_cash_default_uzs" numeric(12, 2),
	"cert_bank_default_uzs" numeric(12, 2),
	"gross_mass_min_kg" integer,
	"gross_mass_max_kg" integer,
	"engine_type_constraint" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"valid_from" date,
	"set_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "brv_value_from_idx" ON "brv_value" USING btree ("valid_from");--> statement-breakpoint
CREATE INDEX "tnved_rate_code_idx" ON "tnved_rate" USING btree ("code");--> statement-breakpoint
CREATE INDEX "tnved_rate_active_idx" ON "tnved_rate" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_entity_contractor_inn" ON "entity" USING btree ("type","external_ref") WHERE type = 'contractor' and external_ref is not null and external_ref <> '';