ALTER TABLE "emails" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "locked_by" varchar(64);--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_emails_due" ON "emails" USING btree ("next_attempt_at") WHERE status = 'queued' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_emails_lease" ON "emails" USING btree ("lease_until") WHERE status = 'sending';--> statement-breakpoint
-- Rows a version without leases left in `sending` get a 15-minute lease from
-- the upgrade: an old replica still sending them during a rolling deploy
-- keeps them, and they become claimable again if nothing finishes them.
UPDATE "emails" SET "lease_until" = now() + interval '15 minutes' WHERE "status" = 'sending';
