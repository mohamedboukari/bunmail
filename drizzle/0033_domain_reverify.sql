ALTER TABLE "domains" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "last_check_result" jsonb;--> statement-breakpoint
CREATE INDEX "domains_next_check_at_idx" ON "domains" USING btree ("next_check_at");--> statement-breakpoint
-- #250: verified_at now means "every required check (SPF, DKIM, DMARC)
-- passed". Verify used to set it on every run whatever the result, so clear
-- it where a check is not verified. Idempotent: a re-run finds no such row.
UPDATE "domains" SET "verified_at" = NULL WHERE "verified_at" IS NOT NULL AND NOT ("spf_verified" AND "dkim_verified" AND "dmarc_verified");
