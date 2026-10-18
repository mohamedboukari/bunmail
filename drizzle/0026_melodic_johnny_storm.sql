CREATE TABLE "user_devices" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"device_hash" varchar(64) NOT NULL,
	"user_agent" varchar(64),
	"ip" varchar(45),
	"location" varchar(128),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_user_id_device_hash_idx" ON "user_devices" USING btree ("user_id","device_hash");--> statement-breakpoint
CREATE INDEX "user_devices_user_id_idx" ON "user_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_devices_last_seen_at_idx" ON "user_devices" USING btree ("last_seen_at");