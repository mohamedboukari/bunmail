CREATE TABLE "email_tombstones" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"api_key_id" varchar(36) NOT NULL,
	"message_id" varchar(255),
	"from_address" varchar(255) NOT NULL,
	"to_address" varchar(255) NOT NULL,
	"subject" varchar(500),
	"status" varchar(20) NOT NULL,
	"sent_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_email_tombstones_message_id" ON "email_tombstones" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_email_tombstones_api_key_purged" ON "email_tombstones" USING btree ("api_key_id","purged_at");