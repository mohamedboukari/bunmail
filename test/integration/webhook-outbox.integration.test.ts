/**
 * The webhook outbox (#184), against a real Postgres: every state change
 * that raises a webhook event writes its `webhook_deliveries` rows in the
 * same transaction, so the change and its events commit together or not
 * at all.
 *
 * One table of cases, one per event and entry point (the queue's
 * `email.sent`, `email.failed`, inline hard `email.bounced` and soft one
 * after an exhausted `4.2.2`, the DSN
 * handler's `email.bounced`, the unsubscribe path, feedback-loop
 * complaints and inbound mail). Each case runs the production entry point
 * and is checked for:
 *
 *   - the state change and its delivery row commit together, the stored
 *     body is a JSON object, another key's webhook gets nothing;
 *   - an outbox insert that fails rolls the state change back too, except
 *     after a send, where the queue saves the status without the events so
 *     the mail is never sent twice;
 *   - a transaction that fails at COMMIT (a deferred trigger, the last
 *     moment before both writes are durable) leaves neither;
 *   - a state change that fails writes no delivery rows;
 *   - with no matching webhook the state change still commits, zero rows.
 *
 * Failures are injected with triggers (`failWritesWhere`), not with seams
 * in the production code. No SMTP: the queue gets an injected mailer, and
 * the inbound paths are called at their service entry points.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import type { DeliveryGroup } from "../../src/modules/emails/models/email.schema.ts";
import {
  handleParsedBounce,
  resolveReturnPath,
} from "../../src/modules/bounces/services/bounce-handler.service.ts";
import { parseBounce } from "../../src/modules/bounces/services/bounce-parser.service.ts";
import { mintReturnPath } from "../../src/modules/bounces/services/return-path.ts";
import { unsubscribe } from "../../src/modules/suppressions/services/unsubscribe.service.ts";
import { handleInboundFeedbackReport } from "../../src/modules/inbound/services/feedback-handler.service.ts";
import { storeInboundEmail } from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { inboundEmails } from "../../src/modules/inbound/models/inbound-email.schema.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import type { WebhookEventType } from "../../src/modules/webhooks/types/webhook.types.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import {
  truncateAll,
  seed,
  db,
  emails,
  suppressions,
  failWritesWhere,
  removeInjectedFailures,
} from "./_helpers.ts";

const RECIPIENT = "reader@example.org";

/** What one test seeded. */
interface Ctx {
  apiKeyId: string;
  emailId: string;
  /** The email's Message-ID, without brackets. */
  messageId: string;
  inboundId: string;
  /** The owning key's webhook, or `null` when the case seeds none. */
  ownHook: string | null;
  /** A webhook of another key, subscribed to the same event. */
  otherHook: string;
}

/** Tables the cases' state changes write. */
type StateTable = "emails" | "suppressions" | "inbound_emails";

interface Case {
  name: string;
  event: WebhookEventType;
  /** `email.received`: delivered to admin keys' webhooks only. */
  adminOnly?: boolean;
  /** Status the email is seeded with: `queued` for the queue, else `sent`. */
  emailStatus: "queued" | "sent";
  /** Runs the production entry point. */
  run: (ctx: Ctx) => Promise<void>;
  /**
   * Whether `run` rejects when its transaction fails. The queue logs the
   * failure and leaves the row to its lease instead.
   */
  throwsOnFailure: boolean;
  /** The `error` line the entry point writes when its transaction fails. */
  failureLog: string;
  /**
   * What a failing outbox insert does. `rollback`: nothing is kept.
   * `degraded`: the queue after a send, where the status is saved without
   * the events so the mail is never sent twice.
   */
  enqueueFailure: "rollback" | "degraded";
  /** Whether the state change is stored. */
  stored: (ctx: Ctx) => Promise<boolean>;
  /** The row the state change writes, to make it fail. */
  stateRow: (ctx: Ctx) => { table: StateTable; match: Record<string, string> };
}

/** A mailer that reports one MX group in `group`'s state, for `RECIPIENT`. */
function mailer(group: Omit<DeliveryGroup, "recipients" | "attempts">): typeof sendMail {
  return async (options) => ({
    messageId: options.messageId,
    deliveryState: {
      "mx.example.org": { recipients: [RECIPIENT], attempts: 1, ...group },
    },
  });
}

/** One queue cycle with `send` as the mailer and no DNS. */
function queueCycle(send: typeof sendMail): Promise<void> {
  return runQueueCycle({ sendMail: send, signedReturnPath: async () => false });
}

async function emailStatus(ctx: Ctx): Promise<string | undefined> {
  const [row] = await db
    .select({ status: emails.status })
    .from(emails)
    .where(eq(emails.id, ctx.emailId));
  return row?.status;
}

async function suppressionReason(ctx: Ctx): Promise<string | undefined> {
  const [row] = await db
    .select({ reason: suppressions.reason })
    .from(suppressions)
    .where(
      and(eq(suppressions.apiKeyId, ctx.apiKeyId), eq(suppressions.email, RECIPIENT)),
    );
  return row?.reason;
}

/** An RFC 3464 hard bounce for the seeded email. */
function dsn(ctx: Ctx): string {
  return `From: MAILER-DAEMON@receiver.example
To: hello@example.com
Subject: Delivery Status Notification (Failure)
Content-Type: multipart/report; report-type=delivery-status; boundary="dsn_bnd"

--dsn_bnd
Content-Type: text/plain

Delivery failed.

--dsn_bnd
Content-Type: message/delivery-status

Final-Recipient: rfc822; ${RECIPIENT}
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 no such user
Original-Message-ID: <${ctx.messageId}>

--dsn_bnd--
`;
}

/** An ARF abuse report about the seeded email. */
function arf(ctx: Ctx): string {
  return `From: "Feedback Loop" <feedback@isp.example.net>
To: fbl@example.com
Subject: Abuse report
MIME-Version: 1.0
Content-Type: multipart/report; report-type=feedback-report;
\tboundary="arf_bnd"

--arf_bnd
Content-Type: text/plain

This is an abuse report.

--arf_bnd
Content-Type: message/feedback-report

Feedback-Type: abuse
User-Agent: Example-Feedback/1.0
Version: 1
Original-Mail-From: <bounce@example.com>
Arrival-Date: Mon, 19 Oct 2026 10:00:00 +0000
Reported-Domain: example.com

--arf_bnd
Content-Type: text/rfc822-headers

From: hello@example.com
To: ${RECIPIENT}
Subject: Your digest
Message-ID: <${ctx.messageId}>

--arf_bnd--
`;
}

const CASES: Case[] = [
  {
    name: "email.sent (queue)",
    event: "email.sent",
    emailStatus: "queued",
    run: () => queueCycle(mailer({ status: "sent" })),
    throwsOnFailure: false,
    failureLog:
      "Email outcome not saved: transaction rolled back, retried after the lease",
    enqueueFailure: "degraded",
    stored: async (ctx) => (await emailStatus(ctx)) === "sent",
    stateRow: (ctx) => ({ table: "emails", match: { id: ctx.emailId, status: "sent" } }),
  },
  {
    name: "email.failed (queue, terminal)",
    event: "email.failed",
    emailStatus: "queued",
    run: () =>
      queueCycle(
        mailer({
          status: "failed",
          failureKind: "policy",
          failureCode: "5.7.1",
          blocked: true,
          lastError: "550 5.7.1 sender blocked",
        }),
      ),
    throwsOnFailure: false,
    failureLog:
      "Email outcome not saved: transaction rolled back, retried after the lease",
    enqueueFailure: "degraded",
    stored: async (ctx) => (await emailStatus(ctx)) === "failed",
    stateRow: (ctx) => ({
      table: "emails",
      match: { id: ctx.emailId, status: "failed" },
    }),
  },
  {
    name: "email.failed (queue, input error)",
    event: "email.failed",
    emailStatus: "queued",
    run: () =>
      queueCycle(async () => {
        throw new Error("No valid recipients");
      }),
    throwsOnFailure: false,
    failureLog: "Email send attempt crashed",
    enqueueFailure: "rollback",
    stored: async (ctx) => (await emailStatus(ctx)) === "failed",
    stateRow: (ctx) => ({
      table: "emails",
      match: { id: ctx.emailId, status: "failed" },
    }),
  },
  {
    name: "email.bounced (queue, inline hard 5xx)",
    event: "email.bounced",
    emailStatus: "queued",
    run: () =>
      queueCycle(
        mailer({
          status: "failed",
          failureKind: "hard",
          failureCode: "5.1.1",
          lastError: "550 5.1.1 no such user",
        }),
      ),
    throwsOnFailure: false,
    failureLog:
      "Email outcome not saved: transaction rolled back, retried after the lease",
    enqueueFailure: "degraded",
    stored: async (ctx) =>
      (await suppressionReason(ctx)) === "bounce" &&
      (await emailStatus(ctx)) === "bounced",
    stateRow: () => ({ table: "suppressions", match: { email: RECIPIENT } }),
  },
  {
    name: "email.bounced (queue, soft 4.2.2 after the retry window)",
    event: "email.bounced",
    emailStatus: "queued",
    run: async (ctx) => {
      /** Older than `MAIL_RETRY_MAX_AGE_HOURS`: this attempt is the last (#250). */
      await db
        .update(emails)
        .set({ createdAt: sql`NOW() - interval '49 hours'` })
        .where(eq(emails.id, ctx.emailId));
      await queueCycle(
        mailer({
          status: "retry",
          failureKind: "soft",
          failureCode: "4.2.2",
          lastError: "452 4.2.2 Mailbox full",
        }),
      );
    },
    throwsOnFailure: false,
    failureLog:
      "Email outcome not saved: transaction rolled back, retried after the lease",
    enqueueFailure: "degraded",
    stored: async (ctx) =>
      (await suppressionReason(ctx)) === "bounce" &&
      (await emailStatus(ctx)) === "failed",
    stateRow: () => ({ table: "suppressions", match: { email: RECIPIENT } }),
  },
  {
    name: "email.bounced (DSN at a signed return path)",
    event: "email.bounced",
    emailStatus: "sent",
    run: async (ctx) => {
      const address = mintReturnPath(
        { emailId: ctx.emailId, index: 0, recipient: RECIPIENT },
        "example.com",
      );
      const binding = address === null ? null : await resolveReturnPath(address);
      const parsed = parseBounce(dsn(ctx));
      if (!binding || !parsed) throw new Error("expected a verified DSN");
      await handleParsedBounce(parsed, binding);
    },
    throwsOnFailure: true,
    failureLog: "Bounce not recorded: transaction rolled back",
    enqueueFailure: "rollback",
    stored: async (ctx) =>
      (await suppressionReason(ctx)) === "bounce" &&
      (await emailStatus(ctx)) === "bounced",
    stateRow: () => ({ table: "suppressions", match: { email: RECIPIENT } }),
  },
  {
    name: "email.unsubscribed (one-click)",
    event: "email.unsubscribed",
    emailStatus: "sent",
    run: async (ctx) => {
      await unsubscribe(
        {
          emailId: ctx.emailId,
          apiKeyId: ctx.apiKeyId,
          recipient: RECIPIENT,
          senderDomain: "example.com",
          tags: null,
        },
        "one_click",
      );
    },
    throwsOnFailure: true,
    failureLog: "Unsubscribe not recorded: transaction rolled back",
    enqueueFailure: "rollback",
    stored: async (ctx) => (await suppressionReason(ctx)) === "unsubscribe",
    stateRow: () => ({ table: "suppressions", match: { email: RECIPIENT } }),
  },
  {
    name: "email.complained (feedback loop)",
    event: "email.complained",
    emailStatus: "sent",
    run: async (ctx) => {
      const raw = arf(ctx);
      const result = await handleInboundFeedbackReport(raw, Buffer.from(raw));
      expect(result.outcome).toBe("complained");
    },
    throwsOnFailure: true,
    failureLog: "Complaint not recorded: transaction rolled back",
    enqueueFailure: "rollback",
    stored: async (ctx) => (await suppressionReason(ctx)) === "complaint",
    stateRow: () => ({ table: "suppressions", match: { email: RECIPIENT } }),
  },
  {
    name: "email.received (inbound mail)",
    event: "email.received",
    adminOnly: true,
    emailStatus: "sent",
    run: (ctx) =>
      storeInboundEmail({
        id: ctx.inboundId,
        fromAddress: "someone@example.net",
        toAddress: "inbox@example.com",
        subject: "Hello",
        textContent: "Hello",
        rawMessage: "Subject: Hello\r\n\r\nHello",
      }),
    throwsOnFailure: true,
    failureLog: "Inbound email not stored: transaction rolled back",
    enqueueFailure: "rollback",
    stored: async (ctx) =>
      (
        await db
          .select({ id: inboundEmails.id })
          .from(inboundEmails)
          .where(eq(inboundEmails.id, ctx.inboundId))
      ).length === 1,
    stateRow: (ctx) => ({ table: "inbound_emails", match: { id: ctx.inboundId } }),
  },
];

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  await removeInjectedFailures();
});

/** Seeds the keys, webhooks and email a case runs against. */
async function setup(
  c: Case,
  opts: { ownHook: boolean } = { ownHook: true },
): Promise<Ctx> {
  const { id: apiKeyId } = await seed.apiKey({ isAdmin: c.adminOnly === true });
  /** For inbound mail, the other key is a restricted one (seeded directly). */
  const { id: otherKeyId } = await seed.apiKey({ isAdmin: false });
  const ownHook = opts.ownHook
    ? (
        await seed.webhook({
          apiKeyId,
          url: "https://own.example.com/hook",
          events: [c.event],
        })
      ).id
    : null;
  const { id: otherHook } = await seed.webhook({
    apiKeyId: otherKeyId,
    url: "https://other.example.com/hook",
    events: [c.event],
  });
  const messageId = `${crypto.randomUUID().replaceAll("-", "")}@mail.example.com`;
  const { id: emailId } = await seed.email({
    apiKeyId,
    toAddress: RECIPIENT,
    status: c.emailStatus,
    messageId: c.emailStatus === "sent" ? `<${messageId}>` : undefined,
  });
  return {
    apiKeyId,
    emailId,
    messageId,
    inboundId: generateId("inb"),
    ownHook,
    otherHook,
  };
}

/**
 * Runs the case, expecting its transaction to fail and the failure to
 * surface: thrown by the entry points that throw, and logged at `error` by
 * all of them (`errorLog`, the case's own line by default). A swallowed
 * enqueue error would fail this.
 */
async function runFailing(c: Case, ctx: Ctx, errorLog = c.failureLog): Promise<void> {
  const errors: string[] = [];
  const spy = spyOn(logger, "error").mockImplementation((message: string) => {
    errors.push(message);
  });
  try {
    const error = await c.run(ctx).then(
      () => null,
      (e: unknown) => e,
    );
    if (c.throwsOnFailure) expect(error).toBeInstanceOf(Error);
    else expect(error).toBeNull();
  } finally {
    spy.mockRestore();
  }
  expect(errors).toContain(errorLog);
}

/** All delivery rows, with their stored body's JSON type. */
async function deliveries(): Promise<
  Array<{ webhookId: string; event: string; payload: string; payloadType: string }>
> {
  return db
    .select({
      webhookId: webhookDeliveries.webhookId,
      event: webhookDeliveries.event,
      payload: webhookDeliveries.payload,
      payloadType: sql<string>`jsonb_typeof(${webhookDeliveries.payload}::jsonb)`,
    })
    .from(webhookDeliveries);
}

describe.each(CASES)("outbox: $name", (c) => {
  test("the state change and its delivery row commit together", async () => {
    const ctx = await setup(c);

    await c.run(ctx);

    expect(await c.stored(ctx)).toBe(true);
    const rows = await deliveries();
    /** Exactly one row, for the owning key's webhook: none for the other key. */
    expect(rows.map((r) => ({ webhookId: r.webhookId, event: r.event }))).toEqual([
      { webhookId: ctx.ownHook ?? "(none)", event: c.event },
    ]);
    /** Stored as a JSON object, not a double-encoded JSON string. */
    expect(rows[0]?.payloadType).toBe("object");
    const body: unknown = JSON.parse(rows[0]?.payload ?? "null");
    expect(body).toMatchObject({
      event: c.event,
      data: c.adminOnly ? { inboundEmailId: ctx.inboundId } : { emailId: ctx.emailId },
    });
  });

  test(
    c.enqueueFailure === "rollback"
      ? "an outbox insert that fails rolls the state change back"
      : "an outbox insert that keeps failing: the status is saved without events",
    async () => {
      const ctx = await setup(c);
      await failWritesWhere("webhook_deliveries", { webhook_id: ctx.ownHook ?? "" });

      if (c.enqueueFailure === "rollback") {
        await runFailing(c, ctx);
        expect(await c.stored(ctx)).toBe(false);
      } else {
        await runFailing(c, ctx, "Webhook events not recorded for a sent email");
        expect(await c.stored(ctx)).toBe(true);
      }
      expect(await deliveries()).toEqual([]);
    },
  );

  test("a transaction that fails at commit leaves neither", async () => {
    const ctx = await setup(c);
    const { table, match } = c.stateRow(ctx);
    await failWritesWhere(table, match, { deferred: true });

    await runFailing(c, ctx);

    expect(await c.stored(ctx)).toBe(false);
    expect(await deliveries()).toEqual([]);
  });

  test("a state change that fails writes no delivery rows", async () => {
    const ctx = await setup(c);
    const { table, match } = c.stateRow(ctx);
    await failWritesWhere(table, match);

    await runFailing(c, ctx);

    expect(await c.stored(ctx)).toBe(false);
    expect(await deliveries()).toEqual([]);
  });

  test("no matching webhook: the state change commits and no row is written", async () => {
    const ctx = await setup(c, { ownHook: false });

    await c.run(ctx);

    expect(await c.stored(ctx)).toBe(true);
    expect(await deliveries()).toEqual([]);
  });
});

describe("outbox: the queue never sends a delivered email twice", () => {
  /** A mailer that delivers to `RECIPIENT` and counts its calls. */
  function countingMailer(): { send: typeof sendMail; calls: () => number } {
    let calls = 0;
    const deliver = mailer({ status: "sent" });
    return {
      send: async (options) => {
        calls += 1;
        return deliver(options);
      },
      calls: () => calls,
    };
  }

  /** Expires any lease on the email, then runs one more queue cycle. */
  async function cycleAfterLease(ctx: Ctx, send: typeof sendMail): Promise<void> {
    await db
      .update(emails)
      .set({
        leaseUntil: sql`NOW() - interval '1 second'`,
        updatedAt: new Date(Date.now() - 60 * 60_000),
      })
      .where(eq(emails.id, ctx.emailId));
    await queueCycle(send);
  }

  /** Runs `work` with `logger.error` captured; returns each call's arguments. */
  async function errorsDuring(work: () => Promise<void>): Promise<unknown[][]> {
    const calls: unknown[][] = [];
    const spy = spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    try {
      await work();
    } finally {
      spy.mockRestore();
    }
    return calls;
  }

  test("an enqueue that always fails: status saved as sent, event lost and logged, no second send", async () => {
    const [sentCase] = CASES;
    if (!sentCase) throw new Error("expected the email.sent case");
    const ctx = await setup(sentCase);
    await failWritesWhere("webhook_deliveries", { webhook_id: ctx.ownHook ?? "" });
    const mail = countingMailer();

    const errors = await errorsDuring(() => queueCycle(mail.send));

    expect(await emailStatus(ctx)).toBe("sent");
    expect(await deliveries()).toEqual([]);
    expect(errors).toContainEqual([
      "Webhook events not recorded for a sent email",
      expect.objectContaining({
        emailId: ctx.emailId,
        attempt: 1,
        events: ["email.sent"],
        sqlState: "P0001",
      }),
    ]);

    /** Past the lease, nothing is claimable: the recipient got it once. */
    await cycleAfterLease(ctx, mail.send);
    expect(mail.calls()).toBe(1);
    expect(await emailStatus(ctx)).toBe("sent");
  });

  test("an enqueue that fails once: the retry commits the status and its event", async () => {
    const [sentCase] = CASES;
    if (!sentCase) throw new Error("expected the email.sent case");
    const ctx = await setup(sentCase);
    await failWritesWhere(
      "webhook_deliveries",
      { webhook_id: ctx.ownHook ?? "" },
      { times: 1 },
    );
    const mail = countingMailer();

    const errors = await errorsDuring(() => queueCycle(mail.send));

    expect(await emailStatus(ctx)).toBe("sent");
    expect((await deliveries()).map((r) => r.event)).toEqual(["email.sent"]);
    expect(errors).toEqual([]);
    expect(mail.calls()).toBe(1);
  });

  test("the status cannot be saved either: the lease sends it again (at-least-once)", async () => {
    const [sentCase] = CASES;
    if (!sentCase) throw new Error("expected the email.sent case");
    const ctx = await setup(sentCase);
    await failWritesWhere(
      "emails",
      { id: ctx.emailId, status: "sent" },
      { deferred: true },
    );
    const mail = countingMailer();

    const errors = await errorsDuring(() => queueCycle(mail.send));

    /** Nothing of the outcome was kept: still `sending` under the lease. */
    const [held] = await db.select().from(emails).where(eq(emails.id, ctx.emailId));
    expect(held?.status).toBe("sending");
    expect(held?.lockedBy).not.toBeNull();
    expect(await deliveries()).toEqual([]);
    expect(errors.map((args) => args[0])).toContain(
      "Email outcome not saved: transaction rolled back, retried after the lease",
    );

    /** The database recovers and the lease expires: sent again, recorded once. */
    await removeInjectedFailures();
    await cycleAfterLease(ctx, mail.send);
    expect(mail.calls()).toBe(2);
    expect(await emailStatus(ctx)).toBe("sent");
    expect((await deliveries()).map((r) => r.event)).toEqual(["email.sent"]);
  });

  test("an outcome whose lease was lost enqueues no row event", async () => {
    const [sentCase] = CASES;
    if (!sentCase) throw new Error("expected the email.sent case");
    const ctx = await setup(sentCase);

    /** Another claim takes the row over while this one is sending. */
    await queueCycle(async (options) => {
      await db
        .update(emails)
        .set({ attempts: sql`${emails.attempts} + 1` })
        .where(eq(emails.id, ctx.emailId));
      return mailer({ status: "sent" })(options);
    });

    expect(await emailStatus(ctx)).toBe("sending");
    expect(await deliveries()).toEqual([]);
  });
});
