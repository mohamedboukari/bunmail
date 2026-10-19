CREATE INDEX "idx_emails_due_per_key" ON "emails" USING btree ("api_key_id","next_attempt_at","created_at") WHERE status = 'queued' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_per_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id","next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
DROP INDEX "idx_emails_due";--> statement-breakpoint
DROP INDEX "webhook_deliveries_due_pending_idx";
