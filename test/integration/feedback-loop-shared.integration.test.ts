/**
 * Feedback-loop complaints and the shared send gate (`SUPPRESSIONS_SHARED_HARD`),
 * on the real inbound SMTP receiver and a real Postgres. A complaint is
 * shared with the other API keys only when its report is **verified**: a
 * DKIM signature that passes for one of `FEEDBACK_LOOP_DOMAINS`. Any other
 * report still suppresses under the sending key and fires its webhook,
 * but never blocks another key.
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
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { config } from "../../src/config.ts";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import { handleInboundFeedbackReport } from "../../src/modules/inbound/services/feedback-handler.service.ts";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { isSuppressed } from "../../src/modules/suppressions/services/suppression.service.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { arfReport, arfResolveTxt, signArf } from "../signed-arf.ts";
import { truncateAll, seed, db, suppressions } from "./_helpers.ts";

/** Isolated port, distinct from the other SMTP test files. */
const INBOUND_PORT = 12641;
const TARGET = "target@example.org";

/** The feedback-loop signer the operator trusts in these tests. */
const PROVIDER = "fbl.isp.example.net";

/** Runtime handles on the flags (config is read at import time). */
const flags = config.suppressions as {
  sharedHard: boolean;
  feedbackLoopDomains: string[];
};
const savedFlags = { ...config.suppressions };
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

let keyA = "";
let keyB = "";
let hookA = "";
let emailA = "";
let messageIdA = "";

beforeEach(async () => {
  await truncateAll();
  flags.sharedHard = true;
  flags.feedbackLoopDomains = [PROVIDER];
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
});

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

/** Runs a signed report through the receiver's entry point, keys published for `domains`. */
async function handleSigned(signed: Buffer, domains: readonly string[]): Promise<string> {
  const result = await handleInboundFeedbackReport(signed.toString("latin1"), signed, {
    resolveTxt: arfResolveTxt(domains),
  });
  return result.outcome;
}

/** The report a tenant could write about its own email to the target. */
function reportAboutA(): string {
  return arfReport({ originalMessageId: messageIdA, rcptTo: TARGET });
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
