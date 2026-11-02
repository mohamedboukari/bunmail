import { optionalBoundedInt, optionalEnv, optionalStrictBoolean } from "./env.ts";

/** Default and bounds of `AUDIT_LOG_RETENTION_DAYS` (#221), in days. */
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365;
export const MIN_AUDIT_LOG_RETENTION_DAYS = 30;
export const MAX_AUDIT_LOG_RETENTION_DAYS = 3650;

/**
 * Reads `AUDIT_LOG_RETENTION_DAYS`, how long audit events are kept
 * (#221). Unset or blank: 365. Anything other than a whole number of days
 * from 30 to 3650 refuses to boot, in every environment: a typo must never
 * shorten the security history silently.
 */
export function readAuditLogRetentionDays(
  raw: string | undefined = process.env["AUDIT_LOG_RETENTION_DAYS"],
): number {
  return optionalBoundedInt(
    "AUDIT_LOG_RETENTION_DAYS",
    DEFAULT_AUDIT_LOG_RETENTION_DAYS,
    MIN_AUDIT_LOG_RETENTION_DAYS,
    MAX_AUDIT_LOG_RETENTION_DAYS,
    raw,
  );
}

/** Default and bounds of `DOMAIN_REVERIFY_INTERVAL_HOURS` (#250), in hours. */
export const DEFAULT_DOMAIN_REVERIFY_INTERVAL_HOURS = 24;
export const MIN_DOMAIN_REVERIFY_INTERVAL_HOURS = 6;
export const MAX_DOMAIN_REVERIFY_INTERVAL_HOURS = 168;

/**
 * Reads `DOMAIN_REVERIFY_INTERVAL_HOURS`, how long after a passing DNS
 * check a domain is checked again by the re-verification loop (#250).
 * Unset or blank: 24. Anything other than a whole number of hours from 6
 * to 168 refuses to boot.
 */
export function readDomainReverifyIntervalHours(
  raw: string | undefined = process.env["DOMAIN_REVERIFY_INTERVAL_HOURS"],
): number {
  return optionalBoundedInt(
    "DOMAIN_REVERIFY_INTERVAL_HOURS",
    DEFAULT_DOMAIN_REVERIFY_INTERVAL_HOURS,
    MIN_DOMAIN_REVERIFY_INTERVAL_HOURS,
    MAX_DOMAIN_REVERIFY_INTERVAL_HOURS,
    raw,
  );
}

/** Default and bounds of `WEBHOOKS_MAX_PER_API_KEY` (#258). */
export const DEFAULT_WEBHOOKS_MAX_PER_API_KEY = 10;
export const MIN_WEBHOOKS_MAX_PER_API_KEY = 1;
export const MAX_WEBHOOKS_MAX_PER_API_KEY = 100;

/**
 * Reads `WEBHOOKS_MAX_PER_API_KEY`, how many webhooks one API key may have
 * (#258). Every event fans out to each of a key's subscribed webhooks, so
 * the cap bounds that fan-out. Unset or blank: 10. Anything other than a
 * whole number from 1 to 100 refuses to boot.
 */
export function readWebhooksMaxPerApiKey(
  raw: string | undefined = process.env["WEBHOOKS_MAX_PER_API_KEY"],
): number {
  return optionalBoundedInt(
    "WEBHOOKS_MAX_PER_API_KEY",
    DEFAULT_WEBHOOKS_MAX_PER_API_KEY,
    MIN_WEBHOOKS_MAX_PER_API_KEY,
    MAX_WEBHOOKS_MAX_PER_API_KEY,
    raw,
  );
}

/** Default and bounds of `WEBHOOK_DELIVERY_RETENTION_DAYS` (#258), in days. */
export const DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
export const MIN_WEBHOOK_DELIVERY_RETENTION_DAYS = 1;
export const MAX_WEBHOOK_DELIVERY_RETENTION_DAYS = 365;

/**
 * Reads `WEBHOOK_DELIVERY_RETENTION_DAYS`, how long finished webhook
 * deliveries (`delivered` and `failed`) are kept (#258). Unset or blank:
 * 30. Anything other than a whole number of days from 1 to 365 refuses to
 * boot: a bare `parseInt` turned a typo into `NaN`, and a `NaN` cutoff
 * silently purged nothing.
 */
export function readWebhookDeliveryRetentionDays(
  raw: string | undefined = process.env["WEBHOOK_DELIVERY_RETENTION_DAYS"],
): number {
  return optionalBoundedInt(
    "WEBHOOK_DELIVERY_RETENTION_DAYS",
    DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS,
    MIN_WEBHOOK_DELIVERY_RETENTION_DAYS,
    MAX_WEBHOOK_DELIVERY_RETENTION_DAYS,
    raw,
  );
}

/** Default and bounds of `IDEMPOTENCY_KEY_TTL_HOURS` (#188), in hours. */
export const DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS = 24;
export const MIN_IDEMPOTENCY_KEY_TTL_HOURS = 1;
export const MAX_IDEMPOTENCY_KEY_TTL_HOURS = 168;

/**
 * Reads `IDEMPOTENCY_KEY_TTL_HOURS`, how long an `Idempotency-Key` on the
 * send API is remembered (#188): a retry with the same key inside this
 * window replays the first response, after it the key is reusable. Unset
 * or blank: 24. Anything other than a whole number of hours from 1 to 168
 * refuses to boot.
 */
export function readIdempotencyKeyTtlHours(
  raw: string | undefined = process.env["IDEMPOTENCY_KEY_TTL_HOURS"],
): number {
  return optionalBoundedInt(
    "IDEMPOTENCY_KEY_TTL_HOURS",
    DEFAULT_IDEMPOTENCY_KEY_TTL_HOURS,
    MIN_IDEMPOTENCY_KEY_TTL_HOURS,
    MAX_IDEMPOTENCY_KEY_TTL_HOURS,
    raw,
  );
}

/** Trash / soft-delete retention */
export function buildTrashConfig() {
  return {
    /**
     * How many days a soft-deleted email stays in trash before the purge
     * service permanently removes it. Applies to both outbound and inbound
     * emails. Default 7 days.
     */
    retentionDays: parseInt(optionalEnv("TRASH_RETENTION_DAYS", "7"), 10),

    /**
     * How many days an email tombstone (the post-purge audit-trail row,
     * #34) is kept after the original email was hard-deleted. The
     * tombstone preserves identifiers (id, message_id, to, subject,
     * status) so operators can trace late complaints / bounces back to
     * a sent message even after the body has been purged. Default 90
     * days: long enough to cover most receiver feedback windows.
     */
    tombstoneRetentionDays: parseInt(optionalEnv("TOMBSTONE_RETENTION_DAYS", "90"), 10),
  } as const;
}

/** Scheduled DNS re-verification of registered domains (#250). */
export function buildDomainReverifyConfig() {
  return {
    /**
     * Whether the re-verification loop runs (`DOMAIN_REVERIFY_ENABLED`,
     * default true, strictly `true` or `false`). Off, domains are only
     * checked by Verify and the inline check of `REQUIRE_VERIFIED_DOMAIN`.
     */
    enabled: optionalStrictBoolean("DOMAIN_REVERIFY_ENABLED", true),

    /**
     * Hours between two checks of a passing domain
     * (`DOMAIN_REVERIFY_INTERVAL_HOURS`, default 24, a whole number from 6
     * to 168), plus or minus one hour of jitter. A failing or inconclusive
     * check is retried after one hour whatever this is.
     */
    intervalHours: readDomainReverifyIntervalHours(),
  } as const;
}

/** Audit log of security-relevant actions (#221). */
export function buildAuditLogConfig() {
  return {
    /**
     * Days an audit event is kept before the purge worker deletes it
     * (`AUDIT_LOG_RETENTION_DAYS`, default 365). A whole number from 30 to
     * 3650; anything else refuses to boot, so a typo can never shorten the
     * history silently.
     */
    retentionDays: readAuditLogRetentionDays(),
  } as const;
}

/** Idempotency keys on `POST /api/v1/emails/send` (#188). */
export function buildIdempotencyConfig() {
  return {
    /**
     * Hours a key is remembered (`IDEMPOTENCY_KEY_TTL_HOURS`, default 24, a
     * whole number from 1 to 168). Within it a retry with the same key and
     * body replays the first response; after it the key is reusable, and
     * the purge worker deletes the expired row.
     */
    keyTtlHours: readIdempotencyKeyTtlHours(),
  } as const;
}

/**
 * Webhook delivery queue (#30). Persisted retry loop config:
 * tuned for the realistic consumer-outage profile rather than burst
 * latency. The retry schedule itself (waits of 1m / 5m / 15m / 1h, so
 * 5 attempts over about 80 minutes) lives in `webhook-delivery-schedule.service.ts`
 * because it's a behavioural contract, not an operator knob.
 */
export function buildWebhookDeliveryConfig() {
  return {
    /**
     * How many days finished deliveries (`delivered` and `failed`) are
     * kept, counted from their last change, before the hourly cleanup
     * deletes them (`WEBHOOK_DELIVERY_RETENTION_DAYS`, default 30, a whole
     * number from 1 to 365, #258). `failed` rows used to be kept forever.
     */
    retentionDays: readWebhookDeliveryRetentionDays(),

    /**
     * Most webhooks one API key may have (`WEBHOOKS_MAX_PER_API_KEY`,
     * default 10, a whole number from 1 to 100, #258). Creating one more
     * is refused with 422 `WEBHOOK_LIMIT_REACHED`; webhooks that already
     * exceed a lowered cap are kept.
     */
    maxPerApiKey: readWebhooksMaxPerApiKey(),

    /**
     * SSRF guard (#128). Webhook URLs must be `https` and must not resolve
     * to a private/loopback/link-local/metadata address. Set
     * `WEBHOOK_ALLOW_INSECURE_HTTP=true` to also permit `http:` targets
     * (e.g. an internal-but-public receiver without TLS): the
     * private-range block still applies either way.
     */
    allowInsecureHttp: optionalEnv("WEBHOOK_ALLOW_INSECURE_HTTP", "false") === "true",
  } as const;
}
