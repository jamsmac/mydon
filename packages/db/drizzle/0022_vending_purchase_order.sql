CREATE TYPE "public"."vending_order_status" AS ENUM('approved', 'ordered', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE "vending_purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"status" "vending_order_status" DEFAULT 'approved' NOT NULL,
	"positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_buy" integer DEFAULT 0 NOT NULL,
	"total_order" integer DEFAULT 0 NOT NULL,
	"cost_exact" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cost_rounded" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vending_purchase_order_approval_id_unique" UNIQUE("approval_id")
);
--> statement-breakpoint
ALTER TABLE "vending_purchase_order" ADD CONSTRAINT "vending_purchase_order_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE no action ON UPDATE no action;