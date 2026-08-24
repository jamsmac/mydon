CREATE TABLE "ourvend_sale_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dt" date NOT NULL,
	"machine_serial" text NOT NULL,
	"product" text NOT NULL,
	"qty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ourvend_stock_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dt" date NOT NULL,
	"machine_serial" text NOT NULL,
	"product" text NOT NULL,
	"qty" numeric(12, 2) DEFAULT '0' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ourvend_sale_snap_key" ON "ourvend_sale_snapshot" USING btree ("dt","machine_serial","product");--> statement-breakpoint
CREATE INDEX "ourvend_sale_snap_dt_idx" ON "ourvend_sale_snapshot" USING btree ("dt");--> statement-breakpoint
CREATE UNIQUE INDEX "ourvend_stock_snap_key" ON "ourvend_stock_snapshot" USING btree ("dt","machine_serial","product");--> statement-breakpoint
CREATE INDEX "ourvend_stock_snap_dt_idx" ON "ourvend_stock_snapshot" USING btree ("dt");