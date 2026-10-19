import { describe, test, expect } from "bun:test";
import { serializeDeliveryState } from "../../src/modules/emails/serializations/delivery-state.serialization.ts";
import { serializeEmail } from "../../src/modules/emails/serializations/email.serialization.ts";
import { deliveryRates } from "../../src/modules/emails/services/delivery-rates.ts";
import type { DeliveryState } from "../../src/modules/emails/models/email.schema.ts";
import type { Email } from "../../src/modules/emails/types/email.types.ts";
import type { DashboardStats } from "../../src/modules/emails/services/stats.service.ts";
import { EmailDetailPage } from "../../src/pages/routes/email-detail.tsx";
import { BOUNCE_RATE_WARNING_THRESHOLD, HomePage } from "../../src/pages/routes/home.tsx";

/**
 * Delivery visibility (#250): the per-MX delivery state in the API and on
 * the detail page, the TLS badge, and the bounce and success rates.
 */

const STATE: DeliveryState = {
  /** Split per recipient (#236): keyed `<mx>#<index>`, MX in `mxHost`. */
  "mx.example.org#1": {
    status: "sent",
    recipients: ["bob@example.org"],
    attempts: 1,
    deliveredAt: "2026-10-19T10:00:00.000Z",
    messageId: "<mid@bunmail.example.com>",
    mxHost: "mx.example.org",
    tls: "starttls",
    updatedAt: "2026-10-19T10:00:00.000Z",
  },
  "mx.example.org#0": {
    status: "failed",
    recipients: ["alice@example.org"],
    attempts: 1,
    lastError: "550 5.1.1 <alice@example.org>: user unknown",
    failureKind: "hard",
    failureCode: "5.1.1",
    mxHost: "mx.example.org",
    tls: "plaintext",
    updatedAt: "2026-10-19T10:00:01.000Z",
  },
  "<dns:nowhere.example>": {
    status: "failed",
    recipients: ["carol@nowhere.example"],
    attempts: 0,
    lastError: "No MX records found for domain: nowhere.example",
  },
  /** Written before #250: no tls, no updatedAt. */
  "aspmx.example.net": {
    status: "retry",
    recipients: ["dave@example.net"],
    attempts: 2,
    lastError: "421 4.7.0 Try again later",
    blocked: false,
  },
};

describe("serializeDeliveryState", () => {
  test("one entry per stored group, sorted by MX then recipient, unresolved last", () => {
    expect(serializeDeliveryState(STATE)).toEqual([
      {
        mx: "aspmx.example.net",
        recipients: ["dave@example.net"],
        status: "retry",
        attempts: 2,
        failureKind: null,
        failureCode: null,
        lastError: "421 4.7.0 Try again later",
        tls: null,
        updatedAt: null,
      },
      {
        mx: "mx.example.org",
        recipients: ["alice@example.org"],
        status: "failed",
        attempts: 1,
        failureKind: "hard",
        failureCode: "5.1.1",
        lastError: "550 5.1.1 <alice@example.org>: user unknown",
        tls: "plaintext",
        updatedAt: "2026-10-19T10:00:01.000Z",
      },
      {
        mx: "mx.example.org",
        recipients: ["bob@example.org"],
        status: "sent",
        attempts: 1,
        failureKind: null,
        failureCode: null,
        lastError: null,
        tls: "starttls",
        updatedAt: "2026-10-19T10:00:00.000Z",
      },
      {
        mx: null,
        recipients: ["carol@nowhere.example"],
        status: "failed",
        attempts: 0,
        failureKind: null,
        failureCode: null,
        lastError: "No MX records found for domain: nowhere.example",
        tls: null,
        updatedAt: null,
      },
    ]);
  });

  test("an entry keyed by its domain (#250) shows its MX host, or null before one was reached", () => {
    const entries = serializeDeliveryState({
      "example.com": {
        status: "sent",
        recipients: ["erin@example.com"],
        attempts: 1,
        domain: "example.com",
        mxHost: "mx2.example.com",
      },
      "flaky.example": {
        status: "retry",
        recipients: ["frank@flaky.example"],
        attempts: 1,
        domain: "flaky.example",
        lastError: "flaky.example: MX lookup failed temporarily (ESERVFAIL); will retry",
      },
    });
    expect(entries.map((e) => [e.mx, e.recipients[0], e.status])).toEqual([
      ["mx2.example.com", "erin@example.com", "sent"],
      [null, "frank@flaky.example", "retry"],
    ]);
    expect(JSON.stringify(entries)).not.toContain("domain");
  });

  test("never exposes internal keys or fields", () => {
    const json = JSON.stringify(serializeDeliveryState(STATE));
    expect(json).not.toContain("#0");
    expect(json).not.toContain("<dns:");
    expect(json).not.toContain("mxHost");
    expect(json).not.toContain("blocked");
    expect(json).not.toContain("messageId");
    expect(json).not.toContain("deliveredAt");
  });

  test("no state yet: no entries", () => {
    expect(serializeDeliveryState(null)).toEqual([]);
  });
});

const EMAIL: Email = {
  id: "msg_abc123",
  apiKeyId: "key_secret123",
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
  status: "sent",
  source: "api",
  attempts: 1,
  nextAttemptAt: new Date("2026-10-19T10:00:00Z"),
  lockedBy: null,
  leaseUntil: null,
  lastError: null,
  messageId: "<mid@bunmail.example.com>",
  sentAt: new Date("2026-10-19T10:00:00Z"),
  createdAt: new Date("2026-10-19T09:59:00Z"),
  updatedAt: new Date("2026-10-19T10:00:00Z"),
  deletedAt: null,
  deliveryState: STATE,
};

describe("serializeEmail: deliveryState (#250)", () => {
  test("carries the serialized delivery state", () => {
    expect(serializeEmail(EMAIL).deliveryState).toEqual(serializeDeliveryState(STATE));
  });

  test("an email not attempted yet has an empty delivery state", () => {
    expect(serializeEmail({ ...EMAIL, deliveryState: null }).deliveryState).toEqual([]);
  });
});

describe("EmailDetailPage: delivery by MX (#250)", () => {
  const HOSTILE: DeliveryState = {
    "<img src=x onerror=alert(1)>.example#0": {
      status: "failed",
      recipients: ["alice@example.org"],
      attempts: 1,
      lastError: "550 <script>alert(1)</script>",
      failureKind: "hard",
      failureCode: "5.1.1",
      mxHost: "<img src=x onerror=alert(1)>.example",
      tls: "plaintext",
      updatedAt: "2026-10-19T10:00:00.000Z",
    },
    "mx.example.org": {
      status: "sent",
      recipients: ["bob@example.org"],
      attempts: 1,
      tls: "starttls",
      updatedAt: "2026-10-19T10:00:00.000Z",
    },
  };

  test("one row per entry, every value escaped, plaintext badged", async () => {
    const html = await EmailDetailPage({
      email: { ...EMAIL, deliveryState: HOSTILE },
      isTrashed: false,
    });
    expect(html).toContain("Delivery by MX");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.example");
    expect(html).toContain("STARTTLS");
    /** The failed plaintext entry is badged; "Sent without TLS" only for a sent one. */
    expect(html).toContain("No TLS");
    expect(html).not.toContain("Sent without TLS");
  });

  test("a sent plaintext entry says it was sent without TLS", async () => {
    const html = await EmailDetailPage({
      email: {
        ...EMAIL,
        deliveryState: {
          "mx.example.org": {
            status: "sent",
            recipients: ["bob@example.org"],
            attempts: 1,
            tls: "plaintext",
          },
        },
      },
      isTrashed: false,
    });
    expect(html).toContain("Sent without TLS");
  });

  test("no table before the first attempt", async () => {
    const html = await EmailDetailPage({
      email: { ...EMAIL, deliveryState: null },
      isTrashed: false,
    });
    expect(html).not.toContain("Delivery by MX");
  });
});

describe("deliveryRates (#250)", () => {
  test("successRate counts bounced rows; bounceRate is bounced / (sent + bounced)", () => {
    expect(deliveryRates({ sent: 90, failed: 5, bounced: 5 })).toEqual({
      successRate: 0.9,
      bounceRate: 5 / 95,
    });
  });

  test("zero denominators: successRate null, bounceRate 0", () => {
    expect(deliveryRates({ sent: 0, failed: 0, bounced: 0 })).toEqual({
      successRate: null,
      bounceRate: 0,
    });
  });

  test("only failures: success 0, bounce rate 0 (nothing sent or bounced)", () => {
    expect(deliveryRates({ sent: 0, failed: 3, bounced: 0 })).toEqual({
      successRate: 0,
      bounceRate: 0,
    });
  });

  test("only bounces: success 0, bounce rate 1", () => {
    expect(deliveryRates({ sent: 0, failed: 0, bounced: 4 })).toEqual({
      successRate: 0,
      bounceRate: 1,
    });
  });
});

describe("HomePage: bounce rate card (#250)", () => {
  const BASE: DashboardStats = {
    totalEmails: 0,
    sentCount: 0,
    failedCount: 0,
    queuedCount: 0,
    bouncedCount: 0,
    sentLast24h: 0,
    failedLast24h: 0,
    bouncedLast24h: 0,
    successRate: null,
    bounceRate: 0,
    inboundTotal: 0,
    inboundLast24h: 0,
    emailsInTrash: 0,
    inboundInTrash: 0,
    totalApiKeys: 0,
    activeApiKeys: 0,
    totalDomains: 0,
    totalTemplates: 0,
    totalWebhooks: 0,
  };

  test("the threshold is 2%", () => {
    expect(BOUNCE_RATE_WARNING_THRESHOLD).toBe(0.02);
  });

  test("at or under the threshold: the rate, no warning", async () => {
    const html = await HomePage({
      stats: { ...BASE, bouncedCount: 2, bounceRate: 0.02 },
    });
    expect(html).toContain("Bounce Rate");
    expect(html).toContain("2.0%");
    expect(html).toContain("sent ÷ (sent + failed + bounced)");
    expect(html).not.toContain("stale addresses");
    expect(html).not.toContain("border-red-600");
  });

  test("above the threshold: warning style and a list hygiene hint", async () => {
    const html = await HomePage({
      stats: { ...BASE, bouncedCount: 3, bounceRate: 0.03 },
    });
    expect(html).toContain("3.0%");
    expect(html).toContain("border-red-600");
    expect(html).toContain("remove bounced and stale addresses from your lists");
  });
});
