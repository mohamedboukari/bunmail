ALTER TABLE "domains" ADD COLUMN "dkim_pending_selector" varchar(63);--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_pending_private_key" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_pending_public_key" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_pending_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_previous_selector" varchar(63);--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_previous_public_key" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_rotated_at" timestamp;