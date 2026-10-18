CREATE INDEX "templates_api_key_id_idx" ON "templates" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "webhooks_api_key_id_idx" ON "webhooks" USING btree ("api_key_id");