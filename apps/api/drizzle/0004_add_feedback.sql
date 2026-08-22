CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" text NOT NULL,
	"device_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
