CREATE TABLE "vending_cash_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_amount" numeric(14, 2) NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_spent" numeric(14, 2) NOT NULL,
	"remainder" numeric(14, 2) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
