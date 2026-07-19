CREATE TABLE "smtp_submission_usage" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"api_key_id" varchar(36) NOT NULL,
	"day" date NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "smtp_submission_usage" ADD CONSTRAINT "smtp_submission_usage_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "smtp_submission_usage_key_day_unique" ON "smtp_submission_usage" USING btree ("api_key_id","day");