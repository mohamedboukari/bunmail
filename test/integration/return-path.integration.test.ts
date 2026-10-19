/**
 * Signed per-recipient return paths (#236) on the real inbound SMTP
 * receiver and a real Postgres: DSNs are delivered over SMTP to
 * `b+<id>.<index>.<MAC>@<sender domain>`, and the suppression rows, email
 * status, enqueued webhook deliveries and `inbound_emails` are checked.
 * The queue side (return paths only with inbound SMTP on and the sender
 * domain's MX pointing here) is checked with an injected mailer and DNS.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { mintReturnPath } from "../../src/modules/bounces/services/return-path.ts";
import {
  clearMxCache,
  signedReturnPathEnabled,
  type MxCheckDeps,
} from "../../src/modules/bounces/services/return-path-mx.ts";
import { mintUnsubscribeToken } from "../../src/modules/suppressions/services/unsubscribe-token.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, emails, suppressions } from "./_helpers.ts";

/** Isolated port, distinct from the other SMTP test files. */
const INBOUND_PORT = 12597;

/** The email's recipients, in return-path index order (to, cc, bcc). */
const ALICE = "alice@example.org";
const BOB = "bob@example.org";
const CAROL = "carol@example.org";

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
  Object.assign(config.smtp, { port: savedSmtp.port, enabled: savedSmtp.enabled });
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
      events: ["email.bounced", "email.complained", "email.unsubscribed"],
    })
  ).id;
  messageId = `${crypto.randomUUID().replaceAll("-", "")}@mail.example.com`;
  emailId = (
    await seed.email({
      apiKeyId,
      fromAddress: "hello@acme.io",
      toAddress: ALICE,
      cc: BOB,
      bcc: CAROL,
      status: "sent",
      messageId: `<${messageId}>`,
    })
  ).id;
});

/** The return path BunMail used for the recipient at `index`. */
function returnPath(index: number, recipient: string, domain = "acme.io"): string {
  const address = mintReturnPath({ emailId, index, recipient }, domain);
  if (address === null) throw new Error("expected a return path");
  return address;
}

/** An RFC 3464 DSN whose body names `recipient` and the email's Message-ID. */
function dsn(subject: string, recipient: string, status = "5.1.1"): string {
  return `From: MAILER-DAEMON@receiver.example
To: hello@acme.io
Subject: ${subject}
Content-Type: multipart/report; report-type=delivery-status; boundary="dsn_bnd"

--dsn_bnd
Content-Type: text/plain

Delivery failed.

--dsn_bnd
Content-Type: message/delivery-status

Final-Recipient: rfc822; ${recipient}
Action: ${status.startsWith("4") ? "delayed" : "failed"}
Status: ${status}
Diagnostic-Code: smtp; 550 5.1.1 no such user
Original-Message-ID: <${messageId}>

--dsn_bnd--
`;
}

/** Delivers a raw message to the receiver; rejects when the receiver refuses it. */
async function deliver(raw: string, to: string): Promise<void> {
  const transport = createTransport({
    host: "127.0.0.1",
    port: INBOUND_PORT,
    secure: false,
    ignoreTLS: true,
  });
  try {
    await transport.sendMail({ envelope: { from: "", to }, raw });
  } finally {
    transport.close();
  }
}

/** The error a promise rejects with, or `undefined` when it resolves. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A fresh subject per message, so `inbound_emails` checks see only this test. */
function uniqueSubject(): string {
  return `verp ${crypto.randomUUID()}`;
}

async function storedInbound(subject: string): Promise<number> {
  const rows = await db.execute(
    sql`SELECT count(*)::int AS n FROM inbound_emails WHERE subject = ${subject}`,
  );
  return Number(rows[0]?.["n"]);
}

/** Suppressed addresses under the test key, sorted. */
async function suppressed(): Promise<string[]> {
  const rows = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(eq(suppressions.apiKeyId, apiKeyId));
  return rows.map((r) => r.email).toSorted((a, b) => a.localeCompare(b));
}

async function emailStatus(): Promise<string | undefined> {
  const [row] = await db
    .select({ status: emails.status })
    .from(emails)
    .where(eq(emails.id, emailId));
  return row?.status;
}

/** Event data of every enqueued delivery of `event` (dispatch is fire-and-forget). */
async function deliveries(event: string): Promise<Array<Record<string, unknown>>> {
  await Bun.sleep(150);
  const rows = await db
    .select({ payload: webhookDeliveries.payload })
    .from(webhookDeliveries)
    .where(
      and(eq(webhookDeliveries.event, event), eq(webhookDeliveries.webhookId, webhookId)),
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

describe("DSN to a valid return path", () => {
  test("bounces exactly the bound recipient: suppression, status and webhook", async () => {
    const subject = uniqueSubject();
    await deliver(dsn(subject, BOB), returnPath(1, BOB));

    expect(await suppressed()).toEqual([BOB]);
    const [row] = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.apiKeyId, apiKeyId));
    expect(row).toMatchObject({
      reason: "bounce",
      bounceType: "hard",
      sourceEmailId: emailId,
    });
    expect(await emailStatus()).toBe("bounced");
    const events = await deliveries("email.bounced");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      emailId,
      to: BOB,
      bounceType: "hard",
      status: "5.1.1",
    });
    expect(await storedInbound(subject)).toBe(0);
  });

  test("a bcc recipient's return path works too, and the address may arrive case-folded", async () => {
    await deliver(dsn(uniqueSubject(), CAROL), returnPath(2, CAROL).toUpperCase());
    expect(await suppressed()).toEqual([CAROL]);
  });

  test("a DSN whose body names a co-recipient still affects only the bound recipient", async () => {
    await deliver(dsn(uniqueSubject(), ALICE), returnPath(1, BOB));

    expect(await suppressed()).toEqual([BOB]);
    const events = await deliveries("email.bounced");
    expect(events.map((e) => e["to"])).toEqual([BOB]);
  });

  test("a DSN without Original-Message-ID still applies (the address is the link)", async () => {
    const raw = dsn(uniqueSubject(), BOB).replace(/^Original-Message-ID:.*\n/m, "");
    await deliver(raw, returnPath(1, BOB));
    expect(await suppressed()).toEqual([BOB]);
  });

  test("a soft DSN files a temporary suppression", async () => {
    await deliver(dsn(uniqueSubject(), BOB, "4.2.2"), returnPath(1, BOB));
    const [row] = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.apiKeyId, apiKeyId));
    expect(row).toMatchObject({ email: BOB, bounceType: "soft" });
    expect(row?.expiresAt).not.toBeNull();
  });
});

describe("return paths that do not verify are refused at RCPT TO", () => {
  /** `address` with one hex digit of its MAC changed. */
  function tamperedMac(address: string): string {
    const at = address.indexOf("@");
    const replacement = address[at - 1] === "0" ? "1" : "0";
    return address.slice(0, at - 1) + replacement + address.slice(at);
  }

  test.each([
    ["an invalid MAC", () => tamperedMac(returnPath(1, BOB))],
    ["the wrong domain", () => returnPath(1, BOB, "other.io")],
    ["another recipient's index", () => returnPath(1, BOB).replace(".1.", ".0.")],
    ["an index past the recipients", () => returnPath(3, BOB)],
    ["a b+ address that is not a return path", () => "b+hello@acme.io"],
  ])("%s: refused, nothing written", async (_label, address) => {
    const subject = uniqueSubject();
    expect(await failure(deliver(dsn(subject, BOB), address()))).toBeInstanceOf(Error);

    await Bun.sleep(100);
    expect(await suppressed()).toEqual([]);
    expect(await emailStatus()).toBe("sent");
    expect(await storedInbound(subject)).toBe(0);
    expect(await deliveries("email.bounced")).toHaveLength(0);
  });

  test("a return path for an email that does not exist is refused", async () => {
    const address = mintReturnPath(
      { emailId: "msg_0123456789abcdef01234567", index: 0, recipient: ALICE },
      "acme.io",
    );
    expect(
      await failure(deliver(dsn(uniqueSubject(), ALICE), address ?? "")),
    ).toBeInstanceOf(Error);
    expect(await suppressed()).toEqual([]);
  });
});

describe("mail that is not a DSN to a return path", () => {
  test("a DSN to the plain sender address has no effect and is not stored", async () => {
    const subject = uniqueSubject();
    await deliver(dsn(subject, ALICE), "hello@acme.io");

    expect(await suppressed()).toEqual([]);
    expect(await emailStatus()).toBe("sent");
    expect(await deliveries("email.bounced")).toHaveLength(0);
    expect(await storedInbound(subject)).toBe(0);
  });

  test("an auto-reply to a return path is acknowledged, dropped and not stored", async () => {
    const subject = uniqueSubject();
    await deliver(
      `From: Alice <${ALICE}>\nTo: hello@acme.io\nSubject: ${subject}\nAuto-Submitted: auto-replied\n\nI am out of the office until Monday.\n`,
      returnPath(0, ALICE),
    );

    await Bun.sleep(100);
    expect(await storedInbound(subject)).toBe(0);
    expect(await suppressed()).toEqual([]);
    expect(await emailStatus()).toBe("sent");
  });

  test("a complaint report sent to a return path is dropped, not acted on", async () => {
    const subject = uniqueSubject();
    await deliver(
      `From: feedback@isp.example.net
To: hello@acme.io
Subject: ${subject}
MIME-Version: 1.0
Content-Type: multipart/report; report-type=feedback-report; boundary="arf"

--arf
Content-Type: text/plain

Abuse report.

--arf
Content-Type: message/feedback-report

Feedback-Type: abuse
Version: 1

--arf
Content-Type: text/rfc822-headers

From: hello@acme.io
To: ${ALICE}
Message-ID: <${messageId}>

--arf--
`,
      returnPath(0, ALICE),
    );

    await Bun.sleep(100);
    expect(await suppressed()).toEqual([]);
    expect(await deliveries("email.complained")).toHaveLength(0);
    expect(await storedInbound(subject)).toBe(0);
  });

  test("a message to a return path and a regular mailbox is stored for the mailbox only", async () => {
    const subject = uniqueSubject();
    const transport = createTransport({
      host: "127.0.0.1",
      port: INBOUND_PORT,
      secure: false,
      ignoreTLS: true,
    });
    try {
      await transport.sendMail({
        envelope: {
          from: "someone@example.net",
          to: [returnPath(0, ALICE), "support@acme.io"],
        },
        raw: `From: someone@example.net\nTo: support@acme.io\nSubject: ${subject}\n\nHello.\n`,
      });
    } finally {
      transport.close();
    }
    expect(await storedInbound(subject)).toBe(1);
    expect(await suppressed()).toEqual([]);
  });
});

describe("the other reserved mailboxes still work", () => {
  test("unsub+<token> still unsubscribes (#249)", async () => {
    const single = await seed.email({
      apiKeyId,
      fromAddress: "hello@acme.io",
      toAddress: ALICE,
      status: "sent",
    });
    const token = mintUnsubscribeToken({ emailId: single.id, recipient: ALICE }) ?? "";
    const transport = createTransport({
      host: "127.0.0.1",
      port: INBOUND_PORT,
      secure: false,
      ignoreTLS: true,
    });
    try {
      await transport.sendMail({
        from: ALICE,
        to: `unsub+${token}@acme.io`,
        subject: "unsubscribe",
        text: "unsubscribe me",
      });
    } finally {
      transport.close();
    }
    const [row] = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.apiKeyId, apiKeyId));
    expect(row).toMatchObject({ email: ALICE, reason: "unsubscribe" });
  });
});

describe("the queue signs return paths only with inbound SMTP on and the MX pointing here", () => {
  /** DNS stub: acme.io's MX is `mx` (or the lookup fails with `error`). */
  function dns(mx: string | { error: string }): MxCheckDeps {
    return {
      resolveMx: async () => {
        if (typeof mx === "object")
          throw Object.assign(new Error("dns"), { code: mx.error });
        return [{ exchange: mx }];
      },
      now: () => Date.now(),
      timeoutMs: 1000,
    };
  }

  /** Runs one queue cycle on a fresh two-recipient email and returns the mailer's options. */
  async function mailerOptions(
    smtpEnabled: boolean,
    mx: string | { error: string },
  ): Promise<{ call: Parameters<typeof sendMail>[0]; queuedId: string }> {
    Object.assign(config.smtp, { enabled: smtpEnabled });
    clearMxCache();
    const queued = await seed.email({
      apiKeyId,
      fromAddress: "hello@acme.io",
      toAddress: ALICE,
      cc: BOB,
    });
    const calls: Parameters<typeof sendMail>[0][] = [];
    const mailer: typeof sendMail = async (options) => {
      calls.push(options);
      return {
        messageId: options.messageId,
        deliveryState: {
          "mx.example.org": { status: "sent", recipients: [ALICE, BOB], attempts: 1 },
        },
      };
    };
    await runQueueCycle({
      sendMail: mailer,
      signedReturnPath: (from) => signedReturnPathEnabled(from, dns(mx)),
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected the queue to call the mailer");
    expect(call.cc).toBe(BOB);
    return { call, queuedId: queued.id };
  }

  test("SMTP on and the sender domain's MX is this host: the mailer signs return paths", async () => {
    const { call, queuedId } = await mailerOptions(
      true,
      `${config.mail.hostname.toUpperCase()}.`,
    );
    expect(call.returnPath).toEqual({ emailId: queuedId });
  });

  test("SMTP on but the sender domain's MX is elsewhere: plain envelope, one transaction per MX group", async () => {
    const { call } = await mailerOptions(true, "aspmx.l.google.com");
    /** No return path: the mailer keeps the From address as envelope sender
     *  and sends each MX group as one transaction (mailer.service.test.ts). */
    expect(call.returnPath).toBeUndefined();
  });

  test("SMTP on and the MX lookup fails: plain envelope (fail safe)", async () => {
    const { call } = await mailerOptions(true, { error: "ESERVFAIL" });
    expect(call.returnPath).toBeUndefined();
  });

  test("SMTP off: no return path even when the MX points here", async () => {
    const { call } = await mailerOptions(false, config.mail.hostname);
    expect(call.returnPath).toBeUndefined();
  });

  test("a per-recipient hard failure suppresses only that recipient", async () => {
    Object.assign(config.smtp, { enabled: true });
    const queued = await seed.email({
      apiKeyId,
      fromAddress: "hello@acme.io",
      toAddress: ALICE,
      cc: BOB,
    });
    const mailer: typeof sendMail = async (options) => ({
      messageId: options.messageId,
      deliveryState: {
        "mx.example.org#0": {
          status: "sent",
          recipients: [ALICE],
          attempts: 1,
          mxHost: "mx.example.org",
        },
        "mx.example.org#1": {
          status: "failed",
          recipients: [BOB],
          attempts: 1,
          mxHost: "mx.example.org",
          failureKind: "hard",
          failureCode: "5.1.1",
          lastError: "550 5.1.1 no such user",
        },
      },
    });
    await runQueueCycle({ sendMail: mailer, signedReturnPath: async () => true });

    expect(await suppressed()).toEqual([BOB]);
    const [row] = await db
      .select({ status: emails.status })
      .from(emails)
      .where(eq(emails.id, queued.id));
    expect(row?.status).toBe("sent");
  });
});
