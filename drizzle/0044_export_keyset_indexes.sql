CREATE INDEX "dmarc_reports_date_end_id_idx" ON "dmarc_reports" USING btree ("date_end" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_email_tombstones_purged_id" ON "email_tombstones" USING btree ("purged_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_emails_live_created_id" ON "emails" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_emails_trash_deleted_id" ON "emails" USING btree ("deleted_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "suppressions_created_id_idx" ON "suppressions" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);