ALTER TABLE "api_keys" ADD COLUMN "created_by_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "disabled_reason" varchar(20);--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "created_by_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "created_by_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "created_by_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_created_by_user_id_idx" ON "api_keys" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "domains_created_by_user_id_idx" ON "domains" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "templates_created_by_user_id_idx" ON "templates" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "webhooks_created_by_user_id_idx" ON "webhooks" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_disabled_reason_check" CHECK ("api_keys"."disabled_reason" IS NULL OR "api_keys"."disabled_reason" IN ('revoked', 'creator_deactivated', 'creator_removed'));