CREATE TABLE "suppressions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"api_key_id" varchar(36) NOT NULL,
	"email" varchar(255) NOT NULL,
	"reason" text NOT NULL,
	"bounce_type" varchar(20),
	"diagnostic_code" text,
	"source_email_id" varchar(36),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_source_email_id_emails_id_fk" FOREIGN KEY ("source_email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_api_key_email_unique" ON "suppressions" USING btree ("api_key_id","email");--> statement-breakpoint
CREATE INDEX "suppressions_api_key_email_idx" ON "suppressions" USING btree ("api_key_id","email");