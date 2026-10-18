ALTER TABLE "sessions" ADD COLUMN "credential_id" varchar(36);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_credential_id_user_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_credential_id_idx" ON "sessions" USING btree ("credential_id");