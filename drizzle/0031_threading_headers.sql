ALTER TABLE "inbound_emails" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "references" text;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "in_reply_to_email_id" varchar(36);--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_in_reply_to_email_id_emails_id_fk" FOREIGN KEY ("in_reply_to_email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_emails_message_id" ON "emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_inbound_in_reply_to_email_id" ON "inbound_emails" USING btree ("in_reply_to_email_id");