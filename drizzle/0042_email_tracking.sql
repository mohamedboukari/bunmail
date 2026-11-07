CREATE TABLE "email_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email_id" varchar(36) NOT NULL,
	"api_key_id" varchar(36) NOT NULL,
	"type" varchar(10) NOT NULL,
	"link_position" integer,
	"url" text,
	"client_kind" varchar(16) NOT NULL,
	"machine" boolean NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_events_type_check" CHECK ("email_events"."type" IN ('open', 'click')),
	CONSTRAINT "email_events_client_kind_check" CHECK ("email_events"."client_kind" IN ('image_proxy', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "track_opens" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "track_clicks" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "track_opens" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "track_clicks" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "first_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "first_clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_events_email_id_occurred_at_idx" ON "email_events" USING btree ("email_id","occurred_at");--> statement-breakpoint
CREATE INDEX "email_events_api_key_id_occurred_at_idx" ON "email_events" USING btree ("api_key_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_events_occurred_at_idx" ON "email_events" USING btree ("occurred_at");