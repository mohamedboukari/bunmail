ALTER TABLE "emails" ADD COLUMN "tags" jsonb;--> statement-breakpoint
CREATE INDEX "idx_emails_tags" ON "emails" USING gin ("tags" jsonb_path_ops);