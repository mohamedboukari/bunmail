/**
 * Inbound notifications on the real inbound SMTP receiver and a real
 * Postgres (#250): the neutral subject, no inbound content, no
 * notification for automatic mail, the per-address and per-domain
 * budgets, and no inbound subject in the receiver's logs. The
 * mailer, the clock and the throttle are injected into the receiver, so
 * nothing leaves the machine.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import type { InboundNotifyDeps } from "../../src/modules/inbound/services/inbound-notify.service.ts";
import {
  NOTIFY_DOMAIN_THROTTLE_MAX,
  NOTIFY_THROTTLE_WINDOW_MS,
  NotifyThrottle,
} from "../../src/modules/inbound/services/notify-throttle.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { inboundEmails } from "../../src/modules/inbound/models/inbound-email.schema.ts";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db, domains } from "./_helpers.ts";

/** Isolated port, distinct from the other SMTP test files. */
const INBOUND_PORT = 12599;

const DOMAIN = "inbox.example.com";
const NOTIFY_TO = "owner@elsewhere.example.org";
const ALICE = `alice@${DOMAIN}`;
const BOB = `bob@${DOMAIN}`;
/** A second notify-enabled domain, with budgets of its own. */
const OTHER_DOMAIN = "other.example.com";

/** Fixed clock, moved by the throttle test. */
const T0 = Date.parse("2026-10-19T12:00:00Z");
let clock = T0;

/** Every notification handed to the mailer. */
const calls: Parameters<typeof sendMail>[0][] = [];

/** Records the notification and reports one delivered MX group. */
const recordingMailer: typeof sendMail = async (options) => {
  calls.push(options);
  return {
    messageId: options.messageId,
    deliveryState: {
      "mx.elsewhere.example.org": {
        status: "sent",
        recipients: [NOTIFY_TO],
        attempts: 1,
      },
    },
  };
};

/** Read by the receiver on every message, so a test can swap the throttle. */
const deps: InboundNotifyDeps = {
  send: recordingMailer,
  now: () => clock,
  throttle: new NotifyThrottle(),
};

const savedSmtp = { ...config.smtp, spamProtection: { ...config.smtp.spamProtection } };
const savedNotify = { ...config.inboundNotify };

beforeAll(() => {
  Object.assign(config.smtp, { port: INBOUND_PORT });
  Object.assign(config.smtp.spamProtection, {
    dnsblEnabled: false,
    rateLimitEnabled: false,
    recipientValidationEnabled: false,
  });
  Object.assign(config.inboundNotify, { enabled: true, preview: false });
  smtpReceiver.start(deps);
});

afterAll(() => {
  smtpReceiver.stop();
  Object.assign(config.smtp, { port: savedSmtp.port, enabled: savedSmtp.enabled });
  Object.assign(config.smtp.spamProtection, savedSmtp.spamProtection);
  Object.assign(config.inboundNotify, savedNotify);
});

beforeEach(async () => {
  await truncateAll();
  for (const name of [DOMAIN, OTHER_DOMAIN]) {
    const { id } = await seed.domain({ name });
    await db.update(domains).set({ notifyEmail: NOTIFY_TO }).where(eq(domains.id, id));
  }
  calls.length = 0;
  clock = T0;
  deps.throttle = new NotifyThrottle();
  Object.assign(config.inboundNotify, { preview: false });
});

/** A message with links in its subject and body. */
function message(to: string, extraHeaders = ""): string {
  return `From: Mallory <mallory@sender.example.net>
To: ${to}
Subject: Verify your account https://evil.example/login
${extraHeaders}Content-Type: text/plain

Click http://phish.example/reset or www.phish.example now.
`;
}

/** Delivers a raw message to the receiver. */
async function deliver(raw: string, to: string, from = "mallory@sender.example.net") {
  const transport = createTransport({
    host: "127.0.0.1",
    port: INBOUND_PORT,
    secure: false,
    ignoreTLS: true,
  });
  try {
    await transport.sendMail({ envelope: { from, to }, raw });
  } finally {
    transport.close();
  }
}

/**
 * Waits until `count` notifications were handed to the mailer, then a
 * little longer so an extra one would show up too (they are sent
 * fire-and-forget after the SMTP ack).
 */
async function settle(count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (calls.length < count && Date.now() < deadline) await Bun.sleep(20);
  await Bun.sleep(250);
}

/** Inbound rows stored: the notification rules never drop mail. */
async function storedCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(inboundEmails);
  return row?.n ?? 0;
}

describe("inbound notification content", () => {
  test("a regular message notifies with the neutral subject and no inbound content", async () => {
    await deliver(message(ALICE), ALICE);
    await settle(1);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected a notification");
    expect(call.to).toBe(NOTIFY_TO);
    expect(call.subject).toBe(`New email for ${ALICE}`);
    expect(call.html ?? null).toBeNull();
    const text = (call.text ?? "").toLowerCase();
    expect(text).toContain("mallory@sender.example.net");
    for (const fragment of [
      "verify your account",
      "click",
      "evil.example",
      "phish.example",
    ]) {
      expect(text).not.toContain(fragment);
    }
    /** Still marked as automatic mail (#250). */
    expect(call.autoSubmitted).toBe(true);
  });

  test("with INBOUND_NOTIFY_PREVIEW the body previews the message, links removed", async () => {
    Object.assign(config.inboundNotify, { preview: true });
    await deliver(message(ALICE), ALICE);
    await settle(1);

    const call = calls[0];
    if (!call) throw new Error("expected a notification");
    expect(call.subject).toBe(`New email for ${ALICE}`);
    expect(call.text).toContain("Subject:  Verify your account [link removed]");
    expect(call.text).toContain("Click [link removed] or [link removed] now.");
    expect(call.text).not.toContain("phish.example");
  });
});

describe("automatic inbound mail", () => {
  test.each([
    ["Auto-Submitted: auto-replied\n", "mallory@sender.example.net"],
    ["Precedence: bulk\n", "mallory@sender.example.net"],
    ["X-Autoreply: yes\n", "mallory@sender.example.net"],
    ["", ""],
  ])("%p (return path %p) is stored but not notified", async (headers, returnPath) => {
    await deliver(message(ALICE, headers), ALICE, returnPath);
    /** A regular message after it is notified: only that one. */
    await deliver(message(BOB), BOB);
    await settle(1);

    expect(calls.map((c) => c.subject)).toEqual([`New email for ${BOB}`]);
    expect(await storedCount()).toBe(2);
  });
});

describe("per-recipient throttle", () => {
  test("7 messages notify 5 times; the next window reports the 2 skipped", async () => {
    for (let i = 0; i < 7; i++) await deliver(message(ALICE), ALICE);
    await settle(5);
    expect(calls).toHaveLength(5);
    expect(await storedCount()).toBe(7);

    /** Another address on the same domain has its own budget. */
    await deliver(message(BOB), BOB);
    await settle(6);
    expect(calls).toHaveLength(6);
    expect(calls[5]?.subject).toBe(`New email for ${BOB}`);
    expect(calls[5]?.text).not.toContain("more email");

    clock = T0 + NOTIFY_THROTTLE_WINDOW_MS + 1000;
    await deliver(message(ALICE), ALICE);
    await settle(7);
    expect(calls).toHaveLength(7);
    expect(calls[6]?.subject).toBe(`New email for ${ALICE}`);
    expect(calls[6]?.text).toContain(
      `And 2 more emails since ${new Date(T0).toUTCString()}, not notified separately`,
    );
  });
});

describe("per-domain budget", () => {
  test("31 addresses on one domain notify 30 times; another domain is unaffected", async () => {
    const address = (i: number): string => `user${i}@${DOMAIN}`;
    for (let i = 0; i <= NOTIFY_DOMAIN_THROTTLE_MAX; i++) {
      await deliver(message(address(i)), address(i));
    }
    await settle(NOTIFY_DOMAIN_THROTTLE_MAX);
    expect(calls).toHaveLength(NOTIFY_DOMAIN_THROTTLE_MAX);
    expect(await storedCount()).toBe(NOTIFY_DOMAIN_THROTTLE_MAX + 1);

    const other = `someone@${OTHER_DOMAIN}`;
    await deliver(message(other), other);
    await settle(NOTIFY_DOMAIN_THROTTLE_MAX + 1);
    expect(calls).toHaveLength(NOTIFY_DOMAIN_THROTTLE_MAX + 1);
    expect(calls.at(-1)?.subject).toBe(`New email for ${other}`);

    /** The skipped address hears about it on its next notification. */
    clock = T0 + NOTIFY_THROTTLE_WINDOW_MS + 1000;
    const skipped = address(NOTIFY_DOMAIN_THROTTLE_MAX);
    await deliver(message(skipped), skipped);
    await settle(NOTIFY_DOMAIN_THROTTLE_MAX + 2);
    expect(calls.at(-1)?.subject).toBe(`New email for ${skipped}`);
    expect(calls.at(-1)?.text).toContain(
      `And 1 more email since ${new Date(T0).toUTCString()}, not notified separately`,
    );
  }, 60_000);
});

describe("receiver logs", () => {
  test("no inbound subject or body text in any log line", async () => {
    const levels = ["debug", "info", "warn", "error"] as const;
    const lines: { message: string; context: unknown }[] = [];
    const spies = levels.map((level) =>
      spyOn(logger, level).mockImplementation((text: string, context?: unknown) => {
        lines.push({ message: text, context });
      }),
    );
    try {
      await deliver(message(ALICE), ALICE);
      await settle(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const stored = lines.find((l) => l.message === "Inbound email received and stored");
    if (!stored) throw new Error("expected the stored line");
    expect(stored.context).not.toHaveProperty("subject");
    expect(stored.context).toHaveProperty("id");
    expect(stored.context).toHaveProperty("bytes");
    const subjectLine = lines.find((l) => l.message === "Inbound email subject");
    expect(subjectLine?.context).toMatchObject({
      subjectLength: "Verify your account https://evil.example/login".length,
    });
    const all = JSON.stringify(lines).toLowerCase();
    for (const fragment of [
      "verify your account",
      "evil.example",
      "phish.example",
      "click",
    ]) {
      expect(all).not.toContain(fragment);
    }
  });
});
