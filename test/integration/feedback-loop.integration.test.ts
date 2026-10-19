/**
 * Feedback-loop complaints (#191) on the real inbound SMTP receiver and a
 * real Postgres: ARF reports are delivered over SMTP, and the suppression
 * rows, enqueued webhook deliveries and `inbound_emails` are checked.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { config } from "../../src/config.ts";
import {
  addFromBounce,
  createSuppression,
} from "../../src/modules/suppressions/services/suppression.service.ts";
import { truncateAll, seed, db, emails, suppressions } from "./_helpers.ts";

/** Isolated port, distinct from the other SMTP test files. */
const INBOUND_PORT = 12596;
const RECIPIENT = "reader@example.org";

const savedSmtp = { ...config.smtp, spamProtection: { ...config.smtp.spamProtection } };
const savedNotify = config.inboundNotify.enabled;

beforeAll(() => {
  Object.assign(config.smtp, { port: INBOUND_PORT });
  Object.assign(config.smtp.spamProtection, {
    dnsblEnabled: false,
    rateLimitEnabled: false,
    recipientValidationEnabled: false,
  });
  Object.assign(config.inboundNotify, { enabled: false });
  smtpReceiver.start();
});

afterAll(() => {
  smtpReceiver.stop();
  Object.assign(config.smtp, { port: savedSmtp.port });
  Object.assign(config.smtp.spamProtection, savedSmtp.spamProtection);
  Object.assign(config.inboundNotify, { enabled: savedNotify });
});

let apiKeyId = "";
let webhookId = "";
let emailId = "";
let messageId = "";

beforeEach(async () => {
  await truncateAll();
  apiKeyId = (await seed.apiKey()).id;
  webhookId = (
    await seed.webhook({
      apiKeyId,
      url: "https://hooks.example.com/bunmail",
      events: ["email.complained", "email.unsubscribed", "email.bounced"],
    })
  ).id;
  messageId = `${crypto.randomUUID().replaceAll("-", "")}@mail.example.com`;
  emailId = (
    await seed.email({
      apiKeyId,
      fromAddress: "hello@example.com",
      toAddress: RECIPIENT,
      status: "sent",
      messageId: `<${messageId}>`,
    })
  ).id;
});

/** Builds an ARF report about `originalMessageId` with a unique subject. */
function arf(opts: {
  subject: string;
  originalMessageId: string;
  feedbackType?: string;
  rcptTo?: string;
}): string {
  const rcptLine = opts.rcptTo ? `Original-Rcpt-To: ${opts.rcptTo}\n` : "";
  return `From: "Feedback Loop" <feedback@isp.example.net>
To: fbl@example.com
Subject: ${opts.subject}
MIME-Version: 1.0
Content-Type: multipart/report; report-type=feedback-report;
\tboundary="arf_bnd"

--arf_bnd
Content-Type: text/plain

This is an abuse report.

--arf_bnd
Content-Type: message/feedback-report

Feedback-Type: ${opts.feedbackType ?? "abuse"}
User-Agent: Example-Feedback/1.0
Version: 1
Original-Mail-From: <bounce@example.com>
${rcptLine}Arrival-Date: Mon, 19 Oct 2026 10:00:00 +0000
Reported-Domain: example.com

--arf_bnd
Content-Type: text/rfc822-headers

From: hello@example.com
To: ${RECIPIENT}
Subject: Your digest
Message-ID: <${opts.originalMessageId}>

--arf_bnd--
`;
}

/** An RFC 3464 bounce for `originalMessageId`: hard (5.1.1) unless a 4.x.x status is given. */
function dsn(subject: string, originalMessageId: string, status = "5.1.1"): string {
  return `From: MAILER-DAEMON@receiver.example
To: hello@example.com
Subject: ${subject}
Content-Type: multipart/report; report-type=delivery-status; boundary="dsn_bnd"

--dsn_bnd
Content-Type: text/plain

Delivery failed.

--dsn_bnd
Content-Type: message/delivery-status

Final-Recipient: rfc822; ${RECIPIENT}
Action: ${status.startsWith("4") ? "delayed" : "failed"}
Status: ${status}
Original-Message-ID: <${originalMessageId}>

--dsn_bnd--
`;
}

/** Delivers a raw message to the receiver; resolves once it was accepted. */
async function deliver(raw: string): Promise<void> {
  const transport = createTransport({
    host: "127.0.0.1",
    port: INBOUND_PORT,
    secure: false,
    ignoreTLS: true,
  });
  try {
    await transport.sendMail({
      envelope: { from: "feedback@isp.example.net", to: "fbl@example.com" },
      raw,
    });
  } finally {
    transport.close();
  }
}

/** A fresh subject per message, so `inbound_emails` checks see only this test. */
function uniqueSubject(): string {
  return `fbl ${crypto.randomUUID()}`;
}

async function storedInbound(s: string): Promise<number> {
  const rows = await db.execute(
    sql`SELECT count(*)::int AS n FROM inbound_emails WHERE subject = ${s}`,
  );
  return Number(rows[0]?.["n"]);
}

async function suppressionOf(key: string, email = RECIPIENT) {
  const [row] = await db
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.apiKeyId, key), eq(suppressions.email, email)));
  return row;
}

/** Event data of every enqueued delivery of `event` to `hook` (dispatch is fire-and-forget). */
async function deliveries(
  event: string,
  hook = webhookId,
): Promise<Array<Record<string, unknown>>> {
  await Bun.sleep(150);
  const rows = await db
    .select({ payload: webhookDeliveries.payload })
    .from(webhookDeliveries)
    .where(
      and(eq(webhookDeliveries.event, event), eq(webhookDeliveries.webhookId, hook)),
    );
  return rows.map((row) => {
    const parsed: unknown = JSON.parse(row.payload);
    const data: unknown =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "data") : null;
    const record: Record<string, unknown> = {};
    if (typeof data === "object" && data !== null) {
      for (const [key, value] of Object.entries(data)) record[key] = value;
    }
    return record;
  });
}

describe("abuse reports", () => {
  test("suppress the recipient with reason complaint and fire the webhook once", async () => {
    const s = uniqueSubject();
    await deliver(arf({ subject: s, originalMessageId: messageId }));

    expect(await suppressionOf(apiKeyId)).toMatchObject({
      reason: "complaint",
      expiresAt: null,
      sourceEmailId: emailId,
    });
    const events = await deliveries("email.complained");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      emailId,
      recipient: RECIPIENT,
      feedbackType: "abuse",
      reporter: "Example-Feedback/1.0",
      arrivalDate: "2026-10-19T10:00:00.000Z",
    });
    expect(await storedInbound(s)).toBe(0);
  });

  test("a report that also reads like a bounce is still a complaint", async () => {
    /** A status-code-shaped string and the recipient in the human-readable
     *  part: the bounce fallback parser would take this as a hard bounce. */
    const s = uniqueSubject();
    await deliver(
      arf({ subject: s, originalMessageId: messageId }).replace(
        "This is an abuse report.",
        `Policy 5.7.1: complaint about mail to <${RECIPIENT}>.`,
      ),
    );

    expect(await suppressionOf(apiKeyId)).toMatchObject({
      reason: "complaint",
      bounceType: null,
    });
    expect(await deliveries("email.bounced")).toHaveLength(0);
    expect(await storedInbound(s)).toBe(0);
  });

  test("a repeated report changes nothing and fires nothing", async () => {
    await deliver(arf({ subject: uniqueSubject(), originalMessageId: messageId }));
    const first = await suppressionOf(apiKeyId);
    await deliver(arf({ subject: uniqueSubject(), originalMessageId: messageId }));

    expect(await suppressionOf(apiKeyId)).toEqual(first);
    expect(await deliveries("email.complained")).toHaveLength(1);
  });

  test.each([
    ["an unsubscribe", { reason: "unsubscribe", expiresAt: null, bounceType: null }],
    ["a hard bounce", { reason: "bounce", expiresAt: null, bounceType: "hard" }],
    [
      "a soft-bounce backoff",
      {
        reason: "bounce",
        expiresAt: new Date(Date.now() + 3_600_000),
        bounceType: "soft",
      },
    ],
    [
      "a temporary manual complaint",
      {
        reason: "complaint",
        expiresAt: new Date(Date.now() + 3_600_000),
        bounceType: null,
      },
    ],
  ])("%s on file becomes a permanent complaint", async (_name, existing) => {
    await db.insert(suppressions).values({
      id: `sup_${crypto.randomUUID().slice(0, 20)}`,
      apiKeyId,
      email: RECIPIENT,
      ...existing,
    });
    await deliver(arf({ subject: uniqueSubject(), originalMessageId: messageId }));

    expect(await suppressionOf(apiKeyId)).toMatchObject({
      reason: "complaint",
      expiresAt: null,
      bounceType: null,
      sourceEmailId: emailId,
    });
    expect(await deliveries("email.complained")).toHaveLength(1);
  });

  test("a permanent complaint on file is left as it is, nothing fired", async () => {
    await db.insert(suppressions).values({
      id: "sup_existing_complaint",
      apiKeyId,
      email: RECIPIENT,
      reason: "complaint",
    });
    await deliver(arf({ subject: uniqueSubject(), originalMessageId: messageId }));

    expect(await suppressionOf(apiKeyId)).toMatchObject({
      id: "sup_existing_complaint",
      sourceEmailId: null,
    });
    expect(await deliveries("email.complained")).toHaveLength(0);
  });

  test("another key's webhooks see nothing, and its list is untouched", async () => {
    const otherKey = (await seed.apiKey({ name: "other" })).id;
    const otherHook = (
      await seed.webhook({
        apiKeyId: otherKey,
        url: "https://hooks.example.com/other",
        events: ["email.complained"],
      })
    ).id;
    await deliver(arf({ subject: uniqueSubject(), originalMessageId: messageId }));

    expect(await deliveries("email.complained")).toHaveLength(1);
    expect(await deliveries("email.complained", otherHook)).toHaveLength(0);
    expect(await suppressionOf(otherKey)).toBeUndefined();
  });

  test("multi-recipient without Original-Rcpt-To: webhook with recipient null, nothing suppressed", async () => {
    const multiId = `${crypto.randomUUID().replaceAll("-", "")}@mail.example.com`;
    const multi = await seed.email({
      apiKeyId,
      toAddress: `${RECIPIENT}, second@example.org`,
      cc: "third@example.org",
      status: "sent",
      messageId: `<${multiId}>`,
    });
    await deliver(arf({ subject: uniqueSubject(), originalMessageId: multiId }));

    expect(await db.select().from(suppressions)).toHaveLength(0);
    const events = await deliveries("email.complained");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ emailId: multi.id, recipient: null });
  });

  test("multi-recipient with Original-Rcpt-To suppresses that recipient", async () => {
    const multiId = `${crypto.randomUUID().replaceAll("-", "")}@mail.example.com`;
    await seed.email({
      apiKeyId,
      toAddress: `${RECIPIENT}, second@example.org`,
      status: "sent",
      messageId: `<${multiId}>`,
    });
    await deliver(
      arf({
        subject: uniqueSubject(),
        originalMessageId: multiId,
        rcptTo: "Second@Example.org",
      }),
    );

    const rows = await db.select().from(suppressions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "second@example.org", reason: "complaint" });
  });
});

describe("other reports", () => {
  test("opt-out becomes an unsubscribe suppression with source fbl", async () => {
    const s = uniqueSubject();
    await deliver(
      arf({ subject: s, originalMessageId: messageId, feedbackType: "opt-out" }),
    );

    expect(await suppressionOf(apiKeyId)).toMatchObject({
      reason: "unsubscribe",
      expiresAt: null,
    });
    const events = await deliveries("email.unsubscribed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ emailId, recipient: RECIPIENT, source: "fbl" });
    expect(await deliveries("email.complained")).toHaveLength(0);
    expect(await storedInbound(s)).toBe(0);
  });

  test("not-spam is dropped: nothing suppressed, fired or stored", async () => {
    const s = uniqueSubject();
    await deliver(
      arf({ subject: s, originalMessageId: messageId, feedbackType: "not-spam" }),
    );

    expect(await db.select().from(suppressions)).toHaveLength(0);
    expect(await deliveries("email.complained")).toHaveLength(0);
    expect(await storedInbound(s)).toBe(0);
  });

  test("an unknown Message-ID is dropped and not stored", async () => {
    const s = uniqueSubject();
    await deliver(arf({ subject: s, originalMessageId: "never-sent@mail.example.com" }));

    expect(await db.select().from(suppressions)).toHaveLength(0);
    expect(await deliveries("email.complained")).toHaveLength(0);
    expect(await storedInbound(s)).toBe(0);
  });

  test("a feedback report without a feedback part is dropped and not stored", async () => {
    const s = uniqueSubject();
    await deliver(
      arf({ subject: s, originalMessageId: messageId }).replace(
        "message/feedback-report",
        "text/plain",
      ),
    );

    expect(await db.select().from(suppressions)).toHaveLength(0);
    expect(await storedInbound(s)).toBe(0);
  });

  test("a DSN still takes the bounce path", async () => {
    await deliver(dsn(uniqueSubject(), messageId));

    expect(await suppressionOf(apiKeyId)).toMatchObject({
      reason: "bounce",
      bounceType: "hard",
    });
    const [row] = await db
      .select({ status: emails.status })
      .from(emails)
      .where(eq(emails.id, emailId));
    expect(row?.status).toBe("bounced");
    expect(await deliveries("email.bounced")).toHaveLength(1);
    expect(await deliveries("email.complained")).toHaveLength(0);
  });

  test("plain mail is still stored as inbound", async () => {
    const s = uniqueSubject();
    await deliver(
      `From: someone@example.net\nTo: fbl@example.com\nSubject: ${s}\n\nHi.\n`,
    );
    expect(await storedInbound(s)).toBe(1);
  });
});

/**
 * A bounce never weakens a suppression (#191): a late DSN for an email
 * sent before a complaint, unsubscribe or manual entry leaves that
 * permanent row exactly as it is. Only temporary rows are rewritten.
 */
describe("late bounces never weaken a permanent suppression", () => {
  const HOUR_MS = 3_600_000;

  async function insertRow(
    values: Partial<typeof suppressions.$inferInsert>,
  ): Promise<string> {
    const id = `sup_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await db.insert(suppressions).values({
      id,
      apiKeyId,
      email: RECIPIENT,
      reason: "manual",
      ...values,
    });
    return id;
  }

  async function bouncedStatus(): Promise<string | undefined> {
    const [row] = await db
      .select({ status: emails.status })
      .from(emails)
      .where(eq(emails.id, emailId));
    return row?.status;
  }

  test.each([
    ["complaint", "4.2.2"],
    ["complaint", "5.1.1"],
    ["unsubscribe", "4.2.2"],
    ["unsubscribe", "5.1.1"],
    ["manual", "4.2.2"],
    ["manual", "5.1.1"],
  ])(
    "a permanent %s row is unchanged by a %s DSN, which still fires and marks the email",
    async (reason, status) => {
      const id = await insertRow({ reason, expiresAt: null });
      const [before] = await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.id, id));

      await deliver(dsn(uniqueSubject(), messageId, status));

      expect(await suppressionOf(apiKeyId)).toEqual(before);
      const events = await deliveries("email.bounced");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ emailId, suppressionId: id });
      expect(await bouncedStatus()).toBe("bounced");
    },
  );

  test("a permanent hard bounce is unchanged by a later soft DSN", async () => {
    const id = await insertRow({
      reason: "bounce",
      bounceType: "hard",
      diagnosticCode: "5.1.1",
      expiresAt: null,
    });
    await deliver(dsn(uniqueSubject(), messageId, "4.2.2"));

    expect(await suppressionOf(apiKeyId)).toMatchObject({
      id,
      reason: "bounce",
      bounceType: "hard",
      expiresAt: null,
    });
    expect(await deliveries("email.bounced")).toHaveLength(1);
  });

  test("a hard DSN upgrades a temporary soft-bounce row to a permanent bounce", async () => {
    const id = await insertRow({
      reason: "bounce",
      bounceType: "soft",
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
    await deliver(dsn(uniqueSubject(), messageId, "5.1.1"));

    expect(await suppressionOf(apiKeyId)).toMatchObject({
      id,
      reason: "bounce",
      bounceType: "hard",
      expiresAt: null,
      sourceEmailId: emailId,
    });
    expect(await deliveries("email.bounced")).toHaveLength(1);
  });

  test("a soft DSN refreshes an expired temporary row with a new window", async () => {
    const id = await insertRow({
      reason: "bounce",
      bounceType: "soft",
      expiresAt: new Date(Date.now() - HOUR_MS),
    });
    await deliver(dsn(uniqueSubject(), messageId, "4.2.2"));

    const row = await suppressionOf(apiKeyId);
    expect(row).toMatchObject({ id, reason: "bounce", bounceType: "soft" });
    expect(row?.expiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now() + 23 * HOUR_MS);
    expect(await deliveries("email.bounced")).toHaveLength(1);
  });

  test("a soft bounce refreshes an active temporary row (service level)", async () => {
    const id = await insertRow({
      reason: "bounce",
      bounceType: "soft",
      diagnosticCode: "4.2.2",
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
    const later = new Date(Date.now() + 24 * HOUR_MS);
    const result = await addFromBounce(apiKeyId, {
      email: RECIPIENT,
      bounceType: "soft",
      diagnosticCode: "4.7.0",
      expiresAt: later,
    });

    expect(result.applied).toBe(true);
    expect(result.suppression).toMatchObject({
      id,
      diagnosticCode: "4.7.0",
      expiresAt: later,
    });
  });

  test("the service reports a kept permanent row as not applied, and returns it", async () => {
    const id = await insertRow({ reason: "complaint", expiresAt: null });
    const result = await addFromBounce(apiKeyId, {
      email: RECIPIENT,
      bounceType: "hard",
      expiresAt: null,
    });
    expect(result.applied).toBe(false);
    expect(result.suppression).toMatchObject({ id, reason: "complaint" });
  });

  test("a manual create leaves a permanent complaint as it is and returns it", async () => {
    const id = await insertRow({ reason: "complaint", expiresAt: null });
    const row = await createSuppression(apiKeyId, {
      email: RECIPIENT,
      reason: "manual",
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
    expect(row).toMatchObject({ id, reason: "complaint", expiresAt: null });
    expect(await suppressionOf(apiKeyId)).toMatchObject({ reason: "complaint" });
  });

  test("a manual create still replaces a permanent unsubscribe or bounce", async () => {
    await insertRow({ reason: "unsubscribe", expiresAt: null });
    const row = await createSuppression(apiKeyId, {
      email: RECIPIENT,
      reason: "manual",
      expiresAt: null,
    });
    expect(row).toMatchObject({ reason: "manual" });
  });
});
