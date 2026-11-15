import { describe, test, expect } from "bun:test";
import {
  decideRowOutcome,
  failureOf,
  retryMaxAgeMs,
  type SentAttempt,
} from "../../src/modules/emails/services/queue-decision.service.ts";
import type { ClaimedEmail } from "../../src/modules/emails/services/queue-claim.service.ts";
import type {
  DeliveryGroup,
  DeliveryState,
} from "../../src/modules/emails/models/email.schema.ts";

/**
 * `decideRowOutcome` (#180, #184, #250): the row status, update and
 * webhook events one queue attempt leads to, from the per-MX delivery
 * state. Pure apart from a deferral's jitter, so it is tested directly
 * here; the integration tier covers the write that applies it.
 */

const MID = "<mid@bunmail.example.com>";

/** A claimed row, `attempts` and `ageMs` overridable. */
function claimed(overrides: Partial<ClaimedEmail> = {}): ClaimedEmail {
  return {
    id: "msg_decide1",
    apiKeyId: "key_decide1",
    domainId: null,
    fromAddress: "hello@example.com",
    toAddress: "alice@example.org",
    cc: null,
    bcc: null,
    replyTo: null,
    headers: null,
    subject: "Subject",
    html: null,
    textContent: "Hello",
    status: "sending",
    source: "api",
    fromName: null,
    category: null,
    tags: { campaign: "spring" },
    trackOpens: false,
    trackClicks: false,
    firstOpenedAt: null,
    firstClickedAt: null,
    attempts: 1,
    nextAttemptAt: new Date("2026-11-15T10:00:00Z"),
    lockedBy: "worker-1",
    leaseUntil: null,
    lastError: null,
    messageId: null,
    sentAt: null,
    createdAt: new Date("2026-11-15T10:00:00Z"),
    updatedAt: new Date("2026-11-15T10:00:00Z"),
    deletedAt: null,
    deliveryState: null,
    ageMs: 1_000,
    ...overrides,
  };
}

/** One delivery group. */
function group(
  status: DeliveryGroup["status"],
  extra: Partial<DeliveryGroup> = {},
): DeliveryGroup {
  return { status, recipients: ["alice@example.org"], attempts: 1, ...extra };
}

/** An attempt over `state`, with each group's status before it. */
function attempt(
  state: DeliveryState,
  prior: Record<string, DeliveryGroup["status"]> = {},
  deferred?: SentAttempt["deferred"],
): SentAttempt {
  return {
    deliveryState: state,
    messageId: MID,
    priorStatuses: new Map(Object.entries(prior)),
    ...(deferred ? { deferred } : {}),
  };
}

describe("decideRowOutcome: terminal outcomes", () => {
  test("every group delivered on this attempt: sent, email.sent once, no last error", () => {
    const outcome = decideRowOutcome(
      claimed(),
      attempt(
        {
          "mx.example.org": group("sent", { deliveredAt: "2026-11-15T10:00:05.000Z" }),
          "mx.example.net": group("sent", { deliveredAt: "2026-11-15T10:00:02.000Z" }),
        },
        { "mx.example.org": "retry", "mx.example.net": "retry" },
      ),
    );
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") return;
    expect(outcome.finalStatus).toBe("sent");
    expect(outcome.values.lastError).toBeNull();
    /** The first delivered group dates the row. */
    expect(outcome.values.sentAt).toEqual(new Date("2026-11-15T10:00:02.000Z"));
    expect(outcome.events).toEqual([
      {
        event: "email.sent",
        data: {
          emailId: "msg_decide1",
          from: "hello@example.com",
          to: "alice@example.org",
          subject: "Subject",
          messageId: MID,
          tags: { campaign: "spring" },
        },
      },
    ]);
  });

  test("a group already sent before this attempt: no second email.sent", () => {
    const outcome = decideRowOutcome(
      claimed({ attempts: 2 }),
      attempt(
        {
          "mx.example.org": group("sent", { deliveredAt: "2026-11-15T10:00:05.000Z" }),
          "mx.example.net": group("sent", { deliveredAt: "2026-11-15T10:20:00.000Z" }),
        },
        { "mx.example.org": "sent", "mx.example.net": "retry" },
      ),
    );
    expect(outcome.kind).toBe("terminal");
    expect(outcome.events).toEqual([]);
  });

  test("a hard 5xx and nothing delivered: bounced, no email.failed (the bounce path reports it)", () => {
    const outcome = decideRowOutcome(
      claimed(),
      attempt(
        {
          "mx.example.org": group("failed", {
            lastError: "550 5.1.1 <alice@example.org>: user unknown",
          }),
        },
        { "mx.example.org": "retry" },
      ),
    );
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") return;
    expect(outcome.finalStatus).toBe("bounced");
    expect(outcome.events).toEqual([]);
    expect(outcome.values.sentAt).toBeNull();
    expect(outcome.values.lastError).toBe(
      "Failed 1 group(s): mx.example.org (1 rcpt): 550 5.1.1 <alice@example.org>: user unknown",
    );
  });

  test("delivered to one MX, hard-failed on another: sent, with the failure kept in last_error", () => {
    const outcome = decideRowOutcome(
      claimed(),
      attempt({
        "mx.example.org": group("sent", { deliveredAt: "2026-11-15T10:00:05.000Z" }),
        "mx.example.net": group("failed", { failureKind: "hard", failureCode: "5.1.1" }),
      }),
    );
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") return;
    expect(outcome.finalStatus).toBe("sent");
    expect(outcome.values.lastError).toBe(
      "Failed 1 group(s): mx.example.net (1 rcpt): ?",
    );
    expect(outcome.events.map((e) => e.event)).toEqual(["email.sent"]);
  });

  test("too old to retry: the straggling retry group fails, email.failed carries the summary and blocked", () => {
    const outcome = decideRowOutcome(
      claimed({ attempts: 6, ageMs: retryMaxAgeMs() - 60_000 }),
      attempt(
        {
          "mx.example.org": group("retry", { lastError: "421 4.7.0 try again later" }),
          "mx.example.net": group("failed", {
            blocked: true,
            failureKind: "policy",
            failureCode: "5.7.1",
            lastError: "550 5.7.1 sender blocked",
          }),
        },
        { "mx.example.org": "retry", "mx.example.net": "retry" },
      ),
    );
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") return;
    /** A policy refusal is not a bounce: the row fails. */
    expect(outcome.finalStatus).toBe("failed");
    expect(outcome.finalState["mx.example.org"]?.status).toBe("failed");
    expect(outcome.events).toHaveLength(1);
    const [failed] = outcome.events;
    expect(failed?.event).toBe("email.failed");
    expect(failed?.data["blocked"]).toBe(true);
    expect(failed?.data["error"]).toBe(
      "Failed 2 group(s): mx.example.org (1 rcpt): 421 4.7.0 try again later | " +
        "mx.example.net (1 rcpt): 550 5.7.1 sender blocked",
    );
  });
});

describe("decideRowOutcome: retries", () => {
  test("a transient failure on a young email: queued again after the first backoff step", () => {
    const outcome = decideRowOutcome(
      claimed(),
      attempt(
        {
          "mx.example.org": group("retry", { lastError: "421 4.4.2 busy" }),
          "mx.example.net": group("sent", { deliveredAt: "2026-11-15T10:00:03.000Z" }),
        },
        { "mx.example.org": "retry", "mx.example.net": "retry" },
      ),
    );
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") return;
    /** First step of the schedule: 5 minutes. */
    expect(outcome.retrySeconds).toBe(300);
    expect(outcome.deferredGroups).toBe(0);
    expect(outcome.values.status).toBe("queued");
    expect(outcome.values.sentAt).toEqual(new Date("2026-11-15T10:00:03.000Z"));
    expect(outcome.values.lastError).toBe(
      "Retrying 1 group(s): mx.example.org (1 rcpt): 421 4.4.2 busy",
    );
    /** The other group landed on this attempt: email.sent fires now, not at the end. */
    expect(outcome.events.map((e) => e.event)).toEqual(["email.sent"]);
  });

  test("every pending entry held back by the rate budget: deferred, the attempt not counted", () => {
    const outcome = decideRowOutcome(
      claimed({ attempts: 3 }),
      attempt(
        { "example.org#0": group("retry"), "example.org#1": group("retry") },
        { "example.org#0": "retry", "example.org#1": "retry" },
        { keys: ["example.org#0", "example.org#1"], waitMs: 20_000 },
      ),
    );
    expect(outcome.kind).toBe("deferred");
    if (outcome.kind !== "deferred") return;
    expect(outcome.values.attempts).toBe(2);
    expect(outcome.values.status).toBe("queued");
    expect(outcome.deferredGroups).toBe(2);
    /** The token wait plus a jitter of at most 10% (at least 250 ms). */
    expect(outcome.delayMs).toBeGreaterThanOrEqual(20_000);
    expect(outcome.delayMs).toBeLessThanOrEqual(22_000);
    expect(outcome.events).toEqual([]);
    expect(outcome.values).not.toHaveProperty("lastError");
  });

  test("a deferred entry beside a failed one waits for the later of backoff and token", () => {
    const outcome = decideRowOutcome(
      claimed(),
      attempt(
        {
          "example.org#0": group("retry", { lastError: "451 4.3.0 later" }),
          "example.org#1": group("retry"),
        },
        { "example.org#0": "retry", "example.org#1": "retry" },
        { keys: ["example.org#1"], waitMs: 1_000 },
      ),
    );
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") return;
    /** The 5 minute backoff wins over the 1 s token wait. */
    expect(outcome.retrySeconds).toBe(300);
    expect(outcome.deferredGroups).toBe(1);
    expect(outcome.values.lastError).toBe(
      "Retrying 2 group(s): example.org#0 (1 rcpt): 451 4.3.0 later | " +
        "example.org#1 (1 rcpt): deferred by the provider rate budget",
    );
  });

  test("a deferral past the retry window ends the email, the entry marked as out of budget", () => {
    const outcome = decideRowOutcome(
      claimed({ ageMs: retryMaxAgeMs() - 1_000 }),
      attempt(
        { "example.org#0": group("retry") },
        { "example.org#0": "retry" },
        { keys: ["example.org#0"], waitMs: 60_000 },
      ),
    );
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") return;
    expect(outcome.finalStatus).toBe("failed");
    expect(outcome.finalState["example.org#0"]?.lastError).toBe(
      "Not sent within the retry window: provider rate budget (MAIL_MX_RATE_PER_MIN)",
    );
    expect(outcome.events.map((e) => e.event)).toEqual(["email.failed"]);
  });
});

describe("failureOf", () => {
  test("the stored classification wins over the error text", () => {
    expect(
      failureOf(group("failed", { failureKind: "soft", lastError: "550 5.1.1 unknown" })),
    ).toEqual({ kind: "soft", code: "" });
    expect(
      failureOf(group("failed", { failureKind: "policy", failureCode: "5.7.26" })),
    ).toEqual({ kind: "policy", code: "5.7.26" });
  });

  test("rows written before #250: the last error is parsed; no error, no classification", () => {
    expect(failureOf(group("failed", { lastError: "550 5.1.1 user unknown" }))).toEqual({
      kind: "hard",
      code: "5.1.1",
    });
    expect(failureOf(group("failed", { lastError: "connection reset" }))).toBeUndefined();
    expect(failureOf(group("failed"))).toBeUndefined();
  });
});
