import { describe, test, expect } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import {
  InboundEventsRequireAdminError,
  ReplayLimitReachedError,
  WebhookEnqueueError,
  WebhookLimitReachedError,
  toWebhookEnqueueError,
} from "../../src/modules/webhooks/errors.ts";

/**
 * The webhook module's errors: what `src/app.ts` maps to a response
 * (status, code, `Retry-After`) and the outbox insert failure (#184),
 * which must never carry the query's parameters (event payloads with
 * recipients and subjects) into a log line.
 */

describe("toWebhookEnqueueError (#184)", () => {
  test("keeps only the SQLSTATE of a failed drizzle query, never its parameters", () => {
    const cause = Object.assign(new Error("trigger refused"), { errno: "P0001" });
    const failed = new DrizzleQueryError(
      "insert into webhook_outbox (payload) values ($1)",
      [JSON.stringify({ to: "alice@example.org", subject: "Secret plans" })],
      cause,
    );
    const error = toWebhookEnqueueError("email.sent", failed);
    expect(error).toBeInstanceOf(WebhookEnqueueError);
    expect(error.sqlState).toBe("P0001");
    expect(error.message).toBe(
      "Webhook event email.sent could not be enqueued (SQLSTATE P0001)",
    );
    expect(error.message).not.toContain("alice@example.org");
    expect(error.message).not.toContain("webhook_outbox");
  });

  test("a bare driver error is read directly; anything without a string errno has no SQLSTATE", () => {
    const direct = toWebhookEnqueueError(
      "email.bounced",
      Object.assign(new Error("x"), { errno: "23505" }),
    );
    expect(direct.sqlState).toBe("23505");

    for (const error of [
      new Error("connection closed"),
      Object.assign(new Error("numeric"), { errno: 104 }),
      "a thrown string",
      null,
    ]) {
      const wrapped = toWebhookEnqueueError("email.failed", error);
      expect(wrapped.sqlState).toBeNull();
      expect(wrapped.message).toBe("Webhook event email.failed could not be enqueued");
    }
  });
});

describe("errors mapped to a response by src/app.ts", () => {
  test("WebhookLimitReachedError: 422 WEBHOOK_LIMIT_REACHED naming the cap", () => {
    const error = new WebhookLimitReachedError(25);
    expect(error.status).toBe(422);
    expect(error.code).toBe("WEBHOOK_LIMIT_REACHED");
    expect(error.limit).toBe(25);
    expect(error.message).toContain("maximum of 25 webhooks");
  });

  test("ReplayLimitReachedError: 429 with the wait in whole minutes, at least one", () => {
    const later = new ReplayLimitReachedError(5, 1_500);
    expect(later.status).toBe(429);
    expect(later.code).toBe("REPLAY_LIMIT_REACHED");
    expect(later.retryAfterSec).toBe(1_500);
    expect(later.message).toBe(
      "This delivery was already replayed 5 times in the last hour. Try again in 25 minute(s).",
    );
    /** A few seconds left still reads as one minute, never zero. */
    expect(new ReplayLimitReachedError(5, 3).message).toEndWith(
      "Try again in 1 minute(s).",
    );
    expect(new ReplayLimitReachedError(5, 61).message).toEndWith(
      "Try again in 2 minute(s).",
    );
  });

  test("InboundEventsRequireAdminError names every admin-only event", () => {
    const error = new InboundEventsRequireAdminError();
    expect(error.name).toBe("InboundEventsRequireAdminError");
    for (const event of [
      "email.received",
      "domain.verified",
      "domain.verification_failed",
    ]) {
      expect(error.message).toContain(event);
    }
  });
});
