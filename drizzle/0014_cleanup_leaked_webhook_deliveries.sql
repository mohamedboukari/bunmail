-- Removes webhook deliveries that went to the wrong API key before event
-- dispatch was scoped to the key that owns the email (#226). Those rows
-- hold another tenant's event (sender, recipient, subject) and stayed
-- readable and replayable by the webhook's owner; pending ones were still
-- being delivered. Data only, no schema change.
--
-- The email id is read from the stored payload text with a regex rather
-- than a ::jsonb cast, so one malformed row cannot fail the migration
-- and stop the app from booting.
--
-- 1. Outbound events: the email's owner (live row, or its tombstone after
--    a purge) differs from the webhook's owner. An owner that can no
--    longer be resolved counts as different: the row is removed.
DELETE FROM "webhook_deliveries" d
USING "webhooks" w
WHERE d."webhook_id" = w."id"
  AND d."event" IN ('email.queued', 'email.sent', 'email.failed', 'email.bounced')
  AND COALESCE(
    (SELECT e."api_key_id" FROM "emails" e
      WHERE e."id" = substring(d."payload" from '"emailId":"([^"]+)"')),
    (SELECT t."api_key_id" FROM "email_tombstones" t
      WHERE t."id" = substring(d."payload" from '"emailId":"([^"]+)"'))
  ) IS DISTINCT FROM w."api_key_id";
--> statement-breakpoint
-- 2. Inbound mail has no owning key and is admin-only (#130): remove
--    `email.received` deliveries held by webhooks of non-admin keys.
DELETE FROM "webhook_deliveries" d
USING "webhooks" w, "api_keys" k
WHERE d."webhook_id" = w."id"
  AND k."id" = w."api_key_id"
  AND d."event" = 'email.received'
  AND k."is_admin" = false;
