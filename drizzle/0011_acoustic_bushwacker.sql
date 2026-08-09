ALTER TABLE "api_keys" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill (#130): existing keys predate the admin/restricted split, so grant
-- them admin to preserve pre-#130 behaviour. New API-created keys default to
-- restricted (false). Demote keys you hand out from the dashboard.
UPDATE "api_keys" SET "is_admin" = true;