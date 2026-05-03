ALTER TABLE "emails" DROP CONSTRAINT "emails_domain_id_domains_id_fk";
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_emails_api_key_deleted" ON "emails" USING btree ("api_key_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_inbound_deleted_at" ON "inbound_emails" USING btree ("deleted_at");