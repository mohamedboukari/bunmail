CREATE TABLE "api_keys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(12) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"dkim_private_key" text,
	"dkim_public_key" text,
	"dkim_selector" varchar(63) DEFAULT 'bunmail' NOT NULL,
	"spf_verified" boolean DEFAULT false NOT NULL,
	"dkim_verified" boolean DEFAULT false NOT NULL,
	"dmarc_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "domains_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"api_key_id" varchar(36) NOT NULL,
	"domain_id" varchar(36),
	"from_address" varchar(255) NOT NULL,
	"to_address" varchar(255) NOT NULL,
	"cc" text,
	"bcc" text,
	"subject" varchar(500) NOT NULL,
	"html" text,
	"text_content" text,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"message_id" varchar(255),
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_emails" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"from_address" varchar(255) NOT NULL,
	"to_address" varchar(255) NOT NULL,
	"subject" varchar(500),
	"html" text,
	"text_content" text,
	"raw_message" text,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"api_key_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"html" text,
	"text_content" text,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"api_key_id" varchar(36) NOT NULL,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret" varchar(64) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_emails_status_created" ON "emails" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_emails_api_key_id" ON "emails" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_inbound_received_at" ON "inbound_emails" USING btree ("received_at");