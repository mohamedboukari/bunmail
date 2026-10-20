ALTER TABLE "email_tombstones" ALTER COLUMN "to_address" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "emails" ALTER COLUMN "to_address" SET DATA TYPE text;