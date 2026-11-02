/**
 * Trace spans of background work (#363), against real Postgres and real
 * SMTP connections: a queued send attempt is the root of its own trace,
 * and each SMTP connection (submission and inbound) is one session span
 * with a child per message. No span carries an address or message
 * content. Spans are read back from an in-memory exporter installed
 * through the real setup.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { createTransport } from "nodemailer";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { config } from "../../src/config.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { logger } from "../../src/utils/logger.ts";
import { startTracing, stopTracing } from "../../src/utils/tracing.ts";
import { truncateAll, seed } from "./_helpers.ts";

/** Isolated ports, distinct from the other SMTP test files. */
const SUBMISSION_PORT = 12630;
const INBOUND_PORT = 12631;

/** Inbound settings this file overrides, restored after the run. */
const savedSmtp = { ...config.smtp, spamProtection: { ...config.smtp.spamProtection } };

const exporter = new InMemorySpanExporter();
const spies: Array<{ mockRestore: () => void }> = [];

beforeAll(async () => {
  for (const level of ["debug", "info", "warn", "error"] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => {}));
  }
  await startTracing(
    {
      enabled: true,
      endpoint: "http://collector.invalid:4318/v1/traces",
      serviceName: "bunmail-test",
      sampler: "parentbased_always_on",
      samplerRatio: 1,
    },
    "0.0.0",
    exporter,
  );
  smtpSubmission.start(SUBMISSION_PORT);
  /** `config` is typed read-only; the runtime object is plain, so tests override it in place. */
  Object.assign(config.smtp, { port: INBOUND_PORT });
  Object.assign(config.smtp.spamProtection, {
    dnsblEnabled: false,
    rateLimitEnabled: false,
    recipientValidationEnabled: false,
  });
  smtpReceiver.start();
});

afterAll(async () => {
  smtpSubmission.stop();
  smtpReceiver.stop();
  Object.assign(config.smtp, { port: savedSmtp.port });
  Object.assign(config.smtp.spamProtection, savedSmtp.spamProtection);
  await stopTracing();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

beforeEach(async () => {
  await truncateAll();
  exporter.reset();
});

/** Waits up to 3 s for an exported span named `name` matching `where`. */
async function waitForSpan(
  name: string,
  where: (span: ReadableSpan) => boolean = () => true,
): Promise<ReadableSpan | undefined> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = exporter.getFinishedSpans().find((s) => s.name === name && where(s));
    if (found) return found;
    await Bun.sleep(20);
  }
  return undefined;
}

/** Every span's attributes, events and status, as one string. */
function shipped(): string {
  return JSON.stringify(
    exporter
      .getFinishedSpans()
      .map((s) => ({ attributes: s.attributes, events: s.events, status: s.status })),
  );
}

/** A mailer that delivers instantly, so no SMTP is involved in the queue test. */
const deliveredMailer: typeof sendMail = async (options) => ({
  messageId: options.messageId,
  deliveryState: {
    "mx.example.org": { status: "sent", recipients: ["user@example.org"], attempts: 1 },
  },
});

describe("queue", () => {
  test("a send attempt is a root span with the email id and attempt, no address", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });

    await runQueueCycle({ sendMail: deliveredMailer });

    const attempt = await waitForSpan("email.send_attempt");
    expect(attempt?.parentSpanContext).toBeUndefined();
    expect(attempt?.attributes).toEqual({
      "bunmail.email.id": id,
      "bunmail.email.attempt": 1,
      "bunmail.email.source": "api",
    });
    expect(shipped()).not.toContain("user@example.org");
  });
});

describe("SMTP submission", () => {
  test("one session span with a message child; no key, address or content", async () => {
    const { rawKey } = await seed.apiKey();
    const transport = createTransport({
      host: "127.0.0.1",
      port: SUBMISSION_PORT,
      secure: false,
      ignoreTLS: true,
      auth: { user: "apikey", pass: rawKey },
      tls: { rejectUnauthorized: false },
    });
    await transport
      .sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "traced submission",
        text: "submission body",
      })
      .catch(() => {
        /** An unregistered sender is refused (550); the spans are what matter here. */
      });
    transport.close();

    const session = await waitForSpan(
      "smtp.session",
      (s) => s.attributes["bunmail.smtp.listener"] === "submission",
    );
    expect(session?.kind).toBe(SpanKind.SERVER);
    expect(session?.parentSpanContext).toBeUndefined();
    const message = exporter
      .getFinishedSpans()
      .find(
        (s) =>
          s.name === "smtp.message" &&
          s.parentSpanContext?.spanId === session?.spanContext().spanId,
      );
    expect(message?.attributes["bunmail.smtp.recipient_count"]).toBe(1);
    expect(typeof message?.attributes["bunmail.smtp.reply_code"]).toBe("number");
    const text = shipped();
    for (const secret of [
      rawKey,
      "user@example.org",
      "hello@unregistered.test",
      "submission body",
      "127.0.0.1",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("inbound SMTP", () => {
  test("one session span with a message child that got 250; no address or content", async () => {
    const subject = `traced inbound ${crypto.randomUUID()}`;
    const transport = createTransport({
      host: "127.0.0.1",
      port: INBOUND_PORT,
      secure: false,
      ignoreTLS: true,
    });
    await transport.sendMail({
      from: "sender@example.net",
      to: "inbox@example.org",
      subject,
      text: "inbound body",
    });
    transport.close();

    const session = await waitForSpan(
      "smtp.session",
      (s) => s.attributes["bunmail.smtp.listener"] === "inbound",
    );
    expect(session?.attributes["bunmail.smtp.messages"]).toBe(1);
    const message = exporter
      .getFinishedSpans()
      .find(
        (s) =>
          s.name === "smtp.message" &&
          s.parentSpanContext?.spanId === session?.spanContext().spanId,
      );
    expect(message?.attributes["bunmail.smtp.reply_code"]).toBe(250);
    const text = shipped();
    for (const secret of [
      "sender@example.net",
      "inbox@example.org",
      subject,
      "inbound body",
      "127.0.0.1",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
