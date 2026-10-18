CREATE TABLE "user_recovery_codes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"credential_id" varchar(36) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "totp_pending_secret" text;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_credential_id_user_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_recovery_codes_user_id_code_hash_idx" ON "user_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE INDEX "user_recovery_codes_credential_id_idx" ON "user_recovery_codes" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_one_totp_per_user" ON "user_credentials" USING btree ("user_id") WHERE type = 'totp';