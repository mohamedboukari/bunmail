-- #261: jsonb columns written through drizzle-orm/bun-sql were stored as a
-- jsonb string holding the JSON text (jsonb_typeof = 'string'), so SQL
-- containment, path operators and jsonb indexes matched nothing. Rewrite
-- every such value as the array or object it encodes. Idempotent: only
-- string-typed values are touched, and a re-run finds none.
UPDATE "webhooks" SET "events" = ("events" #>> '{}')::jsonb WHERE jsonb_typeof("events") = 'string';--> statement-breakpoint
UPDATE "api_keys" SET "allowed_senders" = ("allowed_senders" #>> '{}')::jsonb WHERE jsonb_typeof("allowed_senders") = 'string';--> statement-breakpoint
UPDATE "templates" SET "variables" = ("variables" #>> '{}')::jsonb WHERE jsonb_typeof("variables") = 'string';--> statement-breakpoint
UPDATE "emails" SET "delivery_state" = ("delivery_state" #>> '{}')::jsonb WHERE jsonb_typeof("delivery_state") = 'string';--> statement-breakpoint
UPDATE "webhook_deliveries" SET "last_response_body" = ("last_response_body" #>> '{}')::jsonb WHERE jsonb_typeof("last_response_body") = 'string';
