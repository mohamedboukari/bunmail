/**
 * A full mailbox that stays full for the whole retry window (#250),
 * against a real Postgres: the queue's last attempt files a 24-hour soft
 * suppression for the recipient through `addFromBounce` and enqueues one
 * soft `email.bounced`, in the outcome transaction (#184). Any other
 * temporary failure (here `4.7.1`) ends `failed` with neither. The
 * outbox matrix (commit together, degraded save, commit failure) for the
 * soft case is in `webhook-outbox.integration.test.ts`.
 *
 * No SMTP: the queue gets an injected mailer, and the email's age is set
 * past `MAIL_RETRY_MAX_AGE_HOURS` to end the window.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import type { DeliveryGroup } from "../../src/modules/emails/models/email.schema.ts";
import { addFromComplaint } from "../../src/modules/suppressions/services/suppression.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
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

const RECIPIENT = "full@example.org";

/** A mailer whose one entry for `RECIPIENT` keeps failing with `reply`. */
function failingMailer(reply: {
  failureCode: string;
  lastError: string;
}): typeof sendMail {
  return async (options) => {
    const group: DeliveryGroup = {
      status: "retry",
      recipients: [RECIPIENT],
      attempts: 1,
      domain: "example.org",
      failureKind: "soft",
      ...reply,
    };
    return { messageId: options.messageId, deliveryState: { "example.org": group } };
  };
}

const MAILBOX_FULL = failingMailer({
  failureCode: "4.2.2",
  lastError: "452 4.2.2 Mailbox full",
});

function queueCycle(send: typeof sendMail): Promise<void> {
  return runQueueCycle({ sendMail: send, signedReturnPath: async () => false });
}

/** Ends the retry window: the email is older than 48 h and due now. */
async function endRetryWindow(emailId: string): Promise<void> {
  await db
    .update(emails)
    .set({
      createdAt: sql`NOW() - interval '49 hours'`,
      nextAttemptAt: sql`NOW() - interval '1 second'`,
    })
    .where(eq(emails.id, emailId));
}

interface Ctx {
  apiKeyId: string;
  emailId: string;
  hookId: string;
}

async function setup(): Promise<Ctx> {
  const { id: apiKeyId } = await seed.apiKey();
  const { id: hookId } = await seed.webhook({
    apiKeyId,
    url: "https://own.example.com/hook",
    events: ["email.bounced", "email.failed"],
  });
  const { id: emailId } = await seed.email({ apiKeyId, toAddress: RECIPIENT });
  return { apiKeyId, emailId, hookId };
}

async function suppressionRow(apiKeyId: string) {
  const [row] = await db
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.apiKeyId, apiKeyId), eq(suppressions.email, RECIPIENT)));
  return row;
}

async function deliveries(): Promise<Array<{ event: string; data: unknown }>> {
  const rows = await db
    .select({ event: webhookDeliveries.event, payload: webhookDeliveries.payload })
    .from(webhookDeliveries);
  return rows.map((r) => {
    const body: unknown = JSON.parse(r.payload);
    const data: unknown =
      typeof body === "object" && body !== null ? Reflect.get(body, "data") : null;
    return { event: r.event, data };
  });
}

async function statusOf(emailId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: emails.status })
    .from(emails)
    .where(eq(emails.id, emailId));
  return row?.status;
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  await removeInjectedFailures();
});

describe("soft suppression after an exhausted 4.2.2 retry window", () => {
  test("452 4.2.2 until the window ends: a 24 h soft suppression and one soft email.bounced", async () => {
    const ctx = await setup();

    /** Inside the window: retried, nothing filed. */
    await queueCycle(MAILBOX_FULL);
    expect(await statusOf(ctx.emailId)).toBe("queued");
    expect(await suppressionRow(ctx.apiKeyId)).toBeUndefined();
    expect(await deliveries()).toEqual([]);

    /** The last attempt: the window is over. */
    await endRetryWindow(ctx.emailId);
    const before = Date.now();
    await queueCycle(MAILBOX_FULL);

    expect(await statusOf(ctx.emailId)).toBe("failed");
    const row = await suppressionRow(ctx.apiKeyId);
    expect(row).toMatchObject({
      reason: "bounce",
      bounceType: "soft",
      diagnosticCode: "4.2.2",
      sourceEmailId: ctx.emailId,
    });
    const expiresAt = row?.expiresAt?.getTime() ?? 0;
    const day = 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + day - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + day + 1000);

    const rows = await deliveries();
    const bounced = rows.filter((r) => r.event === "email.bounced");
    expect(bounced).toHaveLength(1);
    expect(bounced[0]?.data).toEqual({
      emailId: ctx.emailId,
      to: RECIPIENT,
      recipient: RECIPIENT,
      bounceType: "soft",
      status: "4.2.2",
      diagnostic: "452 4.2.2 Mailbox full",
      suppressionId: row?.id,
      source: "inline",
    });
    /** `email.failed` still fires as before: no group was delivered. */
    expect(rows.filter((r) => r.event === "email.failed")).toHaveLength(1);
  });

  test("4.7.1 until the window ends: failed, no suppression, no email.bounced", async () => {
    const ctx = await setup();
    await endRetryWindow(ctx.emailId);

    await queueCycle(
      failingMailer({ failureCode: "4.7.1", lastError: "451 4.7.1 Try again later" }),
    );

    expect(await statusOf(ctx.emailId)).toBe("failed");
    expect(await suppressionRow(ctx.apiKeyId)).toBeUndefined();
    expect((await deliveries()).map((r) => r.event)).toEqual(["email.failed"]);
  });

  test("an existing permanent complaint is not weakened", async () => {
    const ctx = await setup();
    const { id: earlierId } = await seed.email({
      apiKeyId: ctx.apiKeyId,
      toAddress: RECIPIENT,
      status: "sent",
    });
    const complaint = await addFromComplaint({
      apiKeyId: ctx.apiKeyId,
      email: RECIPIENT,
      emailId: earlierId,
    });
    await endRetryWindow(ctx.emailId);

    await queueCycle(MAILBOX_FULL);

    const row = await suppressionRow(ctx.apiKeyId);
    expect(row).toMatchObject({
      id: complaint?.id,
      reason: "complaint",
      expiresAt: null,
      bounceType: null,
    });
    /** The event names the suppression in effect: the complaint. */
    const bounced = (await deliveries()).filter((r) => r.event === "email.bounced");
    expect(bounced).toHaveLength(1);
    expect(bounced[0]?.data).toMatchObject({
      bounceType: "soft",
      suppressionId: complaint?.id,
    });
  });

  test("an outbox that keeps failing: the suppression is kept and the lost events are logged", async () => {
    const ctx = await setup();
    await failWritesWhere("webhook_deliveries", { webhook_id: ctx.hookId });
    await endRetryWindow(ctx.emailId);

    const errors: unknown[][] = [];
    const spy = spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      await queueCycle(MAILBOX_FULL);
    } finally {
      spy.mockRestore();
    }

    expect(await statusOf(ctx.emailId)).toBe("failed");
    expect(await suppressionRow(ctx.apiKeyId)).toMatchObject({ bounceType: "soft" });
    expect(await deliveries()).toEqual([]);
    expect(errors).toContainEqual([
      "Webhook events not recorded for a sent email",
      expect.objectContaining({
        emailId: ctx.emailId,
        events: ["email.bounced", "email.failed"],
      }),
    ]);
  });
});
