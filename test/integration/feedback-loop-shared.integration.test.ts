/**
 * Feedback-loop complaints and the shared send gate (`SUPPRESSIONS_SHARED_HARD`),
 * on the real inbound SMTP receiver and a real Postgres. A complaint is
 * shared with the other API keys only when its report is **verified**: a
 * DKIM signature that passes for one of `FEEDBACK_LOOP_DOMAINS`, on a
 * report from one of `FEEDBACK_LOOP_SENDERS` whose domain that signature
 * belongs to (and a listed or empty envelope sender). Any other report
 * still suppresses under the sending key and fires its webhook, but never
 * blocks another key.
 *
 * The unsigned report goes through the SMTP receiver; the signed ones go
 * through the same entry point the receiver calls
 * (`handleInboundFeedbackReport`) with a TXT lookup that knows the test
 * key, since the real lookup would ask public DNS.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { redactEmail } from "../../src/utils/redact.ts";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import { handleInboundFeedbackReport } from "../../src/modules/inbound/services/feedback-handler.service.ts";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { isSuppressed } from "../../src/modules/suppressions/services/suppression.service.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import {
  ARF_FROM,
  arfReport,
  arfResolveTxt,
  signArf,
  signArfWith,
} from "../signed-arf.ts";
import { truncateAll, seed, db, suppressions } from "./_helpers.ts";
import { boundTestPort } from "../listen-port.ts";

/** The inbound receiver's port: it binds 0 and the OS picks a free one (#443). */
let inboundPort = 0;
const TARGET = "target@example.org";

/** The feedback-loop signer the operator trusts in these tests. */
const PROVIDER = "fbl.isp.example.net";

/** Runtime handles on the flags (config is read at import time). */
const flags = config.suppressions as {
  sharedHard: boolean;
  feedbackLoopDomains: string[];
  feedbackLoopSenders: string[];
};
const savedFlags = { ...config.suppressions };
const savedSmtp = { ...config.smtp, spamProtection: { ...config.smtp.spamProtection } };
const savedNotify = config.inboundNotify.enabled;

beforeAll(async () => {
  Object.assign(config.smtp, { port: 0 });
  Object.assign(config.smtp.spamProtection, {
    dnsblEnabled: false,
    rateLimitEnabled: false,
    recipientValidationEnabled: false,
  });
  Object.assign(config.inboundNotify, { enabled: false });
  smtpReceiver.start();
  inboundPort = await boundTestPort(smtpReceiver.listeningPort(), "Inbound SMTP");
});

afterAll(() => {
  smtpReceiver.stop();
  Object.assign(config.smtp, { port: savedSmtp.port });
  Object.assign(config.smtp.spamProtection, savedSmtp.spamProtection);
  Object.assign(config.inboundNotify, { enabled: savedNotify });
});

let keyA = "";
let keyB = "";
let hookA = "";
let emailA = "";
let messageIdA = "";

beforeEach(async () => {
  await truncateAll();
  flags.sharedHard = true;
  flags.feedbackLoopDomains = [PROVIDER];
  flags.feedbackLoopSenders = [ARF_FROM];
  keyA = (await seed.apiKey({ name: "tenant-a" })).id;
  keyB = (await seed.apiKey({ name: "tenant-b" })).id;
  hookA = (
    await seed.webhook({
      apiKeyId: keyA,
      url: "https://hooks.example.com/a",
      events: ["email.complained"],
    })
  ).id;
  /** Key A sends one email to the target: it now knows that email's Message-ID. */
  messageIdA = `${crypto.randomUUID().replaceAll("-", "")}@mail.example.com`;
  emailA = (
    await seed.email({
      apiKeyId: keyA,
      fromAddress: "hello@example.com",
      toAddress: TARGET,
      status: "sent",
      messageId: `<${messageIdA}>`,
    })
  ).id;
});

afterEach(() => {
  flags.sharedHard = savedFlags.sharedHard;
  flags.feedbackLoopDomains = [...savedFlags.feedbackLoopDomains];
  flags.feedbackLoopSenders = [...savedFlags.feedbackLoopSenders];
});

/** The envelope sender `deliver` uses. */
const ENVELOPE_FROM = "feedback@isp.example.net";

/** Delivers a raw message to the receiver; resolves once it was accepted. */
async function deliver(raw: string): Promise<void> {
  const transport = createTransport({
    host: "127.0.0.1",
    port: inboundPort,
    secure: false,
    ignoreTLS: true,
  });
  try {
    await transport.sendMail({
      envelope: { from: ENVELOPE_FROM, to: "fbl@example.com" },
      raw,
    });
  } finally {
    transport.close();
  }
}

/**
 * Runs a signed report through the receiver's entry point, keys published
 * for `domains`, with `envelopeFrom` as the SMTP envelope sender (`null`:
 * the null reverse-path `<>`).
 */
async function handleSigned(
  signed: Buffer,
  domains: readonly string[],
  envelopeFrom: string | null = null,
): Promise<string> {
  const result = await handleInboundFeedbackReport(
    signed.toString("latin1"),
    signed,
    envelopeFrom,
    { resolveTxt: arfResolveTxt(domains) },
  );
  return result.outcome;
}

/** The report a tenant could write about its own email to the target, from `from`. */
function reportAboutA(from?: string): string {
  return arfReport({ originalMessageId: messageIdA, rcptTo: TARGET, from });
}

async function rowOf(key: string) {
  const [row] = await db
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.apiKeyId, key), eq(suppressions.email, TARGET)));
  return row;
}

/** A REST send from key B to the target; the error it throws, if any. */
async function sendAsB(): Promise<unknown> {
  return createEmail(
    { from: "hello@example.com", to: TARGET, subject: "hi", html: "<p>hi</p>" },
    keyB,
  ).then(
    () => null,
    (error: unknown) => error,
  );
}

/** How many `email.complained` deliveries key A's webhook got (dispatch is fire-and-forget). */
async function complainedEventsOfA(): Promise<number> {
  await Bun.sleep(150);
  const rows = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.event, "email.complained"),
        eq(webhookDeliveries.webhookId, hookA),
      ),
    );
  return rows.length;
}

describe("an unverified report stays under the sending key", () => {
  test("an unsigned report about key A's email: A's complaint is filed, key B can still send", async () => {
    await deliver(reportAboutA());

    /** Per key, unchanged: A's complaint exists and its webhook fired. */
    expect(await rowOf(keyA)).toMatchObject({
      reason: "complaint",
      expiresAt: null,
      sourceEmailId: emailA,
      complaintVerified: false,
    });
    expect(await isSuppressed(keyA, TARGET)).toMatchObject({ shared: false });
    expect(await complainedEventsOfA()).toBe(1);

    /** Not shared: B is not refused, even with SUPPRESSIONS_SHARED_HARD on. */
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
    expect(await sendAsB()).toBeNull();
  });

  test("a report signed by a domain that is not listed passes DKIM but is not shared", async () => {
    const outcome = await handleSigned(signArf(reportAboutA(), "attacker.example"), [
      "attacker.example",
    ]);

    expect(outcome).toBe("complained");
    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: false });
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
    expect(await sendAsB()).toBeNull();
  });

  test("with FEEDBACK_LOOP_DOMAINS empty, even the provider's signature is not shared", async () => {
    flags.feedbackLoopDomains = [];
    await handleSigned(signArf(reportAboutA(), PROVIDER), [PROVIDER]);

    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: false });
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
  });
});

describe("a verified report is shared", () => {
  test("a report signed by a listed domain blocks key B too", async () => {
    const outcome = await handleSigned(signArf(reportAboutA(), PROVIDER), [PROVIDER]);

    expect(outcome).toBe("complained");
    expect(await rowOf(keyA)).toMatchObject({
      reason: "complaint",
      sourceEmailId: emailA,
      complaintVerified: true,
    });
    expect(await isSuppressed(keyB, TARGET)).toEqual({ shared: true });
    expect(await sendAsB()).toBeInstanceOf(SuppressedRecipientError);
    expect(await complainedEventsOfA()).toBe(1);
  });

  test("a verified report after an unverified one upgrades the flag, fires nothing more", async () => {
    await deliver(reportAboutA());
    const first = await rowOf(keyA);
    expect(first?.complaintVerified).toBe(false);
    expect(await sendAsB()).toBeNull();

    const outcome = await handleSigned(signArf(reportAboutA(), PROVIDER), [PROVIDER]);

    expect(outcome).toBe("already-complained");
    const upgraded = await rowOf(keyA);
    expect(upgraded).toMatchObject({ id: first?.id, complaintVerified: true });
    expect(await sendAsB()).toBeInstanceOf(SuppressedRecipientError);
    /** The complaint was already reported: one event in all. */
    expect(await complainedEventsOfA()).toBe(1);
  });

  test("an unverified report after a verified one never downgrades it", async () => {
    await handleSigned(signArf(reportAboutA(), PROVIDER), [PROVIDER]);
    await deliver(reportAboutA());

    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: true });
    expect(await isSuppressed(keyB, TARGET)).toEqual({ shared: true });
  });

  test("with SUPPRESSIONS_SHARED_HARD off, a verified complaint stays per key", async () => {
    flags.sharedHard = false;
    await handleSigned(signArf(reportAboutA(), PROVIDER), [PROVIDER]);

    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: true });
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
    expect(await sendAsB()).toBeNull();
  });
});

/**
 * A verified complaint must also come from a configured feedback-loop
 * sender, signed by that sender's domain.
 */
describe("the feedback-loop sender", () => {
  test("signed by a listed domain but from an unlisted sender: not shared", async () => {
    const outcome = await handleSigned(
      signArf(reportAboutA("someone@fbl.isp.example.net"), PROVIDER),
      [PROVIDER],
    );

    expect(outcome).toBe("complained");
    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: false });
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
    expect(await sendAsB()).toBeNull();
  });

  test("the same report from the listed sender, with a listed envelope sender: shared", async () => {
    await handleSigned(signArf(reportAboutA(), PROVIDER), [PROVIDER], ARF_FROM);

    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: true });
    expect(await sendAsB()).toBeInstanceOf(SuppressedRecipientError);
  });

  test("a listed sender on a domain the listed signature does not cover: not shared", async () => {
    flags.feedbackLoopSenders = [ARF_FROM, "feedback@other.example.org"];
    await handleSigned(signArf(reportAboutA("feedback@other.example.org"), PROVIDER), [
      PROVIDER,
    ]);

    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: false });
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
  });

  test("an envelope sender that is not listed: not shared", async () => {
    await handleSigned(
      signArf(reportAboutA(), PROVIDER),
      [PROVIDER],
      "bounces@elsewhere.example",
    );

    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: false });
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
  });

  test("with FEEDBACK_LOOP_SENDERS empty, nothing is verified, even the provider's own report", async () => {
    flags.feedbackLoopSenders = [];
    const outcome = await handleSigned(signArf(reportAboutA(), PROVIDER), [PROVIDER]);

    expect(outcome).toBe("complained");
    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: false });
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
    expect(await sendAsB()).toBeNull();
  });

  test("the SMTP receiver hands the envelope sender to the handler", async () => {
    const info = spyOn(logger, "info");
    try {
      await deliver(reportAboutA());
      const line = info.mock.calls.find((call) =>
        call[0].startsWith("Complaint not verified"),
      );
      expect(line?.[1]).toMatchObject({
        emailId: emailA,
        envelopeFrom: redactEmail(ENVELOPE_FROM),
      });
    } finally {
      info.mockRestore();
    }
  });
});

/**
 * The `From` and `Content-Type` a verified complaint relies on must be the
 * ones a signature covers: a report from another address at the trusted
 * signer, with header fields added after signing, is never shared.
 */
describe("header fields the signature does not cover are not trusted", () => {
  /** Another address at the trusted signer: not a listed sender. */
  const OTHER = "user@fbl.isp.example.net";
  const OTHER_FROM_LINE = `\r\nFrom: "Feedback Loop" <${OTHER}>`;
  const PLAIN_HEADERS = [
    "from",
    "to",
    "subject",
    "date",
    "message-id",
    "mime-version",
    "content-type",
  ];

  /** `signed` with its `From` line replaced by `lines`. */
  function withFromLines(signed: Buffer, lines: string): Buffer {
    const text = signed.toString("latin1");
    expect(text).toContain(OTHER_FROM_LINE);
    return Buffer.from(text.replace(OTHER_FROM_LINE, lines), "latin1");
  }

  /** Runs `bytes` with an empty envelope sender and checks nothing reached key B. */
  async function expectNotShared(bytes: Buffer): Promise<void> {
    const outcome = await handleSigned(bytes, [PROVIDER], null);
    expect(outcome).toBe("complained");
    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: false });
    expect(await isSuppressed(keyB, TARGET)).toBeUndefined();
    expect(await sendAsB()).toBeNull();
  }

  test("only the signed From instance counts", async () => {
    const signed = signArfWith(reportAboutA(OTHER), PROVIDER, { headers: PLAIN_HEADERS });
    await expectNotShared(
      withFromLines(
        signed,
        `\r\nFrom: ${ARF_FROM}\r\nFrom${" ".repeat(80)}: "Feedback Loop" <${OTHER}>`,
      ),
    );
  });

  test("an unsigned From and Content-Type ahead of many other fields are refused", async () => {
    const signed = signArfWith(reportAboutA(OTHER), PROVIDER, { headers: PLAIN_HEADERS });
    const filler = Array.from({ length: 200 }, (_, i) => `X-Filler-${i}: a`).join("\r\n");
    await expectNotShared(
      Buffer.concat([
        Buffer.from(
          'Content-Type: multipart/report; report-type=feedback-report; boundary="arf_bnd"\r\n' +
            `From: ${ARF_FROM}\r\n${filler}\r\n`,
          "latin1",
        ),
        signed,
      ]),
    );
  });

  test("a From hidden from one reader is refused", async () => {
    const signed = signArfWith(reportAboutA(OTHER), PROVIDER, { headers: PLAIN_HEADERS });
    await expectNotShared(
      withFromLines(signed, `\r\nFrom\x0b: ${ARF_FROM}${OTHER_FROM_LINE}`),
    );
  });

  test("an unsigned From is refused with an over-signing signer too", async () => {
    const signed = signArf(reportAboutA(OTHER), PROVIDER);
    await expectNotShared(
      withFromLines(
        signed,
        `\r\nFrom\x0b: ${ARF_FROM}\r\nFrom${" ".repeat(80)}: "Feedback Loop" <${OTHER}>`,
      ),
    );
  });

  test("the listed sender's own report, unmodified, is still shared", async () => {
    await handleSigned(
      signArfWith(reportAboutA(), PROVIDER, { headers: PLAIN_HEADERS }),
      [PROVIDER],
    );
    expect(await rowOf(keyA)).toMatchObject({ complaintVerified: true });
    expect(await sendAsB()).toBeInstanceOf(SuppressedRecipientError);
  });
});

/**
 * A relaxed DKIM signature still verifies after whitespace changes in the
 * body, so the email a report links to must not depend on them.
 */
describe("a body a relaxed signature cannot tell apart links to the same email", () => {
  const OTHER_RECIPIENT = "other-reader@example.org";

  /** A listed sender's report with no Original-Message-ID about key A's email, whose body names `bodyMessageId`. */
  function reportWithBody(bodyMessageId: string): string {
    return [
      `From: ${ARF_FROM}`,
      "To: fbl@example.com",
      "Subject: complaint",
      "Date: Mon, 19 Oct 2026 10:05:00 +0000",
      `Message-ID: <${crypto.randomUUID()}@fbl.isp.example.net>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/report; report-type=feedback-report; boundary="arf_bnd"',
      "",
      "--arf_bnd",
      "Content-Type: text/plain",
      "",
      "abuse report",
      "",
      "--arf_bnd",
      "Content-Type: message/feedback-report",
      "",
      "Feedback-Type: abuse",
      "Version: 1",
      "",
      "--arf_bnd",
      "Content-Type: message/rfc822",
      "",
      "From: hello@example.com",
      `To: ${TARGET}`,
      "Subject: hi",
      `Message-ID: <${messageIdA}>`,
      "Content-Type: text/plain",
      "",
      `Message-ID: <${bodyMessageId}>`,
      "",
      "hello",
      "",
      "--arf_bnd--",
      "",
    ].join("\r\n");
  }

  test("a whitespace-only line still ends a header section: the complaint stays on the reported email", async () => {
    /** Another email of key A, to another address. */
    const otherId = `${crypto.randomUUID().replaceAll("-", "")}@mail.example.com`;
    await seed.email({
      apiKeyId: keyA,
      fromAddress: "hello@example.com",
      toAddress: OTHER_RECIPIENT,
      status: "sent",
      messageId: `<${otherId}>`,
    });
    const signed = signArfWith(reportWithBody(otherId), PROVIDER, {
      headers: [
        "from",
        "to",
        "subject",
        "date",
        "message-id",
        "mime-version",
        "content-type",
      ],
    }).toString("latin1");
    const edited = signed.replace(
      "Content-Type: message/rfc822\r\n\r\n",
      "Content-Type: message/rfc822\r\n \r\n",
    );
    expect(edited).not.toBe(signed);

    const outcome = await handleSigned(Buffer.from(edited, "latin1"), [PROVIDER]);

    expect(outcome).toBe("complained");
    expect(await rowOf(keyA)).toMatchObject({
      sourceEmailId: emailA,
      complaintVerified: true,
    });
    const otherRows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, OTHER_RECIPIENT));
    expect(otherRows).toEqual([]);
    expect(await isSuppressed(keyB, OTHER_RECIPIENT)).toBeUndefined();
  });
});
