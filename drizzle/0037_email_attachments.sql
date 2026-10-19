CREATE TABLE "email_attachments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email_id" varchar(36) NOT NULL,
	"position" integer NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_id" varchar(128),
	"sha256" varchar(64) NOT NULL,
	"content" "bytea",
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_tombstones" ADD COLUMN "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_email_attachments_email_position" ON "email_attachments" USING btree ("email_id","position");