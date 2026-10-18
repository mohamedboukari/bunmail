CREATE TABLE "session_token_history" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"superseded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "previous_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_token_history" ADD CONSTRAINT "session_token_history_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_token_history_session_id_idx" ON "session_token_history" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_previous_token_hash_idx" ON "sessions" USING btree ("previous_token_hash");