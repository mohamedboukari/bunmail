import { DrizzleQueryError } from "drizzle-orm";

/**
 * Thrown by `webhook.service.createWebhook` when a non-admin API key tries
 * to subscribe to an admin-only event: `email.received`, `domain.verified`
 * or `domain.verification_failed`. Inbound mail and domains have no owning
 * API key, and managing them is admin-only (#130), so delivering them to a
 * restricted key's webhook would bypass that boundary. The global
 * `.onError` handler in `src/index.ts` maps this to HTTP 403 with
 * `code: "INBOUND_EVENTS_REQUIRE_ADMIN"` (named after the first such event,
 * kept for compatibility).
 */
export class InboundEventsRequireAdminError extends Error {
  override readonly name = "InboundEventsRequireAdminError";

  constructor() {
    super(
      "Only admin API keys can subscribe to email.received, domain.verified and domain.verification_failed (inbound mail and domains are admin-only).",
    );
  }
}

/**
 * Thrown by `webhook.service.createWebhook` when the API key already has
 * `WEBHOOKS_MAX_PER_API_KEY` webhooks (#258). Every event fans out to each
 * subscribed webhook of its key, so the cap bounds that fan-out. The
 * global `.onError` handler in `src/index.ts` maps this to HTTP 422 with
 * `code: "WEBHOOK_LIMIT_REACHED"`; the dashboard shows the message.
 */
export class WebhookLimitReachedError extends Error {
  override readonly name = "WebhookLimitReachedError";
  readonly status = 422;
  readonly code = "WEBHOOK_LIMIT_REACHED";
  /** The cap that was hit. */
  readonly limit: number;

  constructor(limit: number) {
    super(
      `This API key already has the maximum of ${limit} webhooks. Delete one before adding another.`,
    );
    this.limit = limit;
  }
}

/**
 * Thrown by `webhook-delivery.service.replayDelivery` when the delivery
 * was already replayed `REPLAYS_PER_DELIVERY_PER_HOUR` times in the
 * current hour (#258). Mapped to HTTP 429 with a `Retry-After` header and
 * `code: "REPLAY_LIMIT_REACHED"` (REST, in `src/index.ts`); the dashboard
 * answers 429 on the delivery page.
 */
export class ReplayLimitReachedError extends Error {
  override readonly name = "ReplayLimitReachedError";
  readonly status = 429;
  readonly code = "REPLAY_LIMIT_REACHED";
  /** Seconds until the delivery may be replayed again. */
  readonly retryAfterSec: number;

  constructor(limit: number, retryAfterSec: number) {
    super(
      `This delivery was already replayed ${limit} times in the last hour. Try again in ${Math.max(1, Math.ceil(retryAfterSec / 60))} minute(s).`,
    );
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * The webhook outbox insert failed (#184), stripped of what the query
 * carried. Drizzle's message embeds the query parameters, and here they
 * include the event payload (recipients, subjects): only the Postgres
 * SQLSTATE is kept. Thrown inside the caller's transaction, so the state
 * change the event describes rolls back with it.
 */
export class WebhookEnqueueError extends Error {
  override readonly name = "WebhookEnqueueError";

  /** Postgres SQLSTATE (e.g. `P0001` from a trigger), or `null`. */
  readonly sqlState: string | null;

  constructor(event: string, sqlState: string | null) {
    super(
      `Webhook event ${event} could not be enqueued${sqlState ? ` (SQLSTATE ${sqlState})` : ""}`,
    );
    this.sqlState = sqlState;
  }
}

/**
 * Wraps any error of the outbox insert in a `WebhookEnqueueError` (Bun's
 * `PostgresError` exposes the SQLSTATE as `errno`).
 */
export function toWebhookEnqueueError(
  event: string,
  error: unknown,
): WebhookEnqueueError {
  const cause: unknown = error instanceof DrizzleQueryError ? error.cause : error;
  const sqlState =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "errno") : undefined;
  return new WebhookEnqueueError(event, typeof sqlState === "string" ? sqlState : null);
}
