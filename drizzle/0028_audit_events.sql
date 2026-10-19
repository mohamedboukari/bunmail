CREATE TABLE "audit_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" varchar(10) NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" varchar(64) NOT NULL,
	"outcome" varchar(10) NOT NULL,
	"target_type" varchar(32),
	"target_id" text,
	"target_label" text,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" IN ('user', 'api_key', 'system')),
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" IN ('success', 'failure'))
);
--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written (#221): the audit log is append-only. Any UPDATE of
-- audit_events raises, whatever the connection; DELETE stays allowed for
-- the retention purge. drizzle-kit does not track triggers, so later
-- generated migrations leave this alone.
CREATE FUNCTION "audit_events_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: UPDATE is not allowed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update"
BEFORE UPDATE ON "audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_reject_update"();
