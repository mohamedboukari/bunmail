/**
 * Thrown by `webhook.service.createWebhook` when a non-admin API key tries
 * to subscribe to `email.received`. Inbound mail has no owning API key, and
 * reading it is admin-only (#130), so delivering it to a restricted key's
 * webhook would bypass that boundary. The global `.onError` handler in
 * `src/index.ts` maps this to HTTP 403 with
 * `code: "INBOUND_EVENTS_REQUIRE_ADMIN"`.
 */
export class InboundEventsRequireAdminError extends Error {
  override readonly name = "InboundEventsRequireAdminError";

  constructor() {
    super(
      "Only admin API keys can subscribe to email.received (inbound mail is admin-only).",
    );
  }
}
