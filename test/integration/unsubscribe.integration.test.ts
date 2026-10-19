/**
 * One-click unsubscribe (#249) against a real Postgres: the public
 * `/u/:token` pages, the suppression and `email.unsubscribed` webhook they
 * produce, the per-recipient `List-Unsubscribe` header the queue builds,
 * and the `unsub+<token>` mailbox on the real inbound SMTP receiver.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { unsubscribePlugin } from "../../src/pages/unsubscribe.plugin.tsx";
import {
  PAGE_CSP,
  securityHeadersPlugin,
} from "../../src/middleware/security-headers.ts";
import { mintUnsubscribeToken } from "../../src/modules/suppressions/services/unsubscribe-token.ts";
import { addFromBounce } from "../../src/modules/suppressions/services/suppression.service.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import {
  buildMailOptions,
  type sendMail,
} from "../../src/modules/emails/services/mailer.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, suppressions } from "./_helpers.ts";

const BASE = "https://mail.acme.io";
const RECIPIENT = "user@example.org";

/** Anything that answers a request: an Elysia app. */
interface Handler {
  handle(request: Request): Promise<Response>;
}

/** A fresh app per test: the limiter state is per plugin instance. */
let app: Handler = new Elysia();

let apiKeyId = "";
let emailId = "";
let token = "";

beforeEach(async () => {
  await truncateAll();
  app = new Elysia()
    .use(securityHeadersPlugin({ httpsBaseUrl: true }))
    .use(unsubscribePlugin());
  apiKeyId = (await seed.apiKey()).id;
  emailId = (
    await seed.email({
      apiKeyId,
      fromAddress: "hello@acme.io",
      toAddress: RECIPIENT,
      status: "sent",
    })
  ).id;
  token = mintUnsubscribeToken({ emailId, recipient: RECIPIENT }) ?? "";
  expect(token).not.toBe("");
});

function get(t: string, target: Handler = app): Promise<Response> {
  return target.handle(new Request(`http://localhost/u/${t}`));
}

function post(t: string, body = "List-Unsubscribe=One-Click"): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/u/${t}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}

/** What `promise` rejects with, or `null` when it resolves. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

async function suppressionRows() {
  return db.select().from(suppressions);
}

/** `email.unsubscribed` deliveries enqueued so far (dispatch is fire-and-forget). */
async function unsubscribedEvents(): Promise<
  Array<{ source: unknown; emailId: unknown }>
> {
  await Bun.sleep(150);
  const rows = await db
    .select({ payload: webhookDeliveries.payload })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.event, "email.unsubscribed"));
  return rows.map((r) => {
    const parsed: unknown = JSON.parse(r.payload);
    const data: unknown =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "data") : null;
    return {
      source:
        typeof data === "object" && data !== null ? Reflect.get(data, "source") : null,
      emailId:
        typeof data === "object" && data !== null ? Reflect.get(data, "emailId") : null,
    };
  });
}

describe("GET /u/:token", () => {
  test("shows the confirmation page and does NOT suppress", async () => {
    const res = await get(token);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("u***@example.org");
    expect(html).toContain("acme.io");
    expect(html).toContain('method="POST"');
    expect(html).not.toContain(RECIPIENT);
    expect(html).not.toContain(token);
    expect(html).not.toContain("<script");
    expect(await suppressionRows()).toHaveLength(0);
  });

  test("answers with no-store, no-referrer, noindex and the page CSP", async () => {
    for (const res of [await get(token), await get("bogus")]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    }
  });
});

describe("POST /u/:token", () => {
  test("RFC 8058 one-click suppresses the recipient for the sending key", async () => {
    const { id: hookKeyWebhook } = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.unsubscribed"],
    });
    expect(hookKeyWebhook).toMatch(/^whk_/);

    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("unsubscribed");

    const rows = await suppressionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      apiKeyId,
      email: RECIPIENT,
      reason: "unsubscribe",
      sourceEmailId: emailId,
      expiresAt: null,
    });
    expect(await unsubscribedEvents()).toEqual([{ source: "one_click", emailId }]);
  });

  test("a repeated request succeeds and fires the webhook once", async () => {
    await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.unsubscribed"],
    });
    expect((await post(token)).status).toBe(200);
    expect((await post(token)).status).toBe(200);
    expect((await post(token.toUpperCase())).status).toBe(200);
    expect(await suppressionRows()).toHaveLength(1);
    expect(await unsubscribedEvents()).toHaveLength(1);
  });

  test("the confirmation form counts as source `link`", async () => {
    await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.unsubscribed"],
    });
    expect((await post(token, "confirm=unsubscribe")).status).toBe(200);
    expect(await unsubscribedEvents()).toEqual([{ source: "link", emailId }]);
  });

  test("another key's webhooks never see the event", async () => {
    const other = await seed.apiKey();
    await seed.webhook({
      apiKeyId: other.id,
      url: "https://93.184.216.34/hook",
      events: ["email.unsubscribed"],
    });
    expect((await post(token)).status).toBe(200);
    expect(await unsubscribedEvents()).toHaveLength(0);
  });

  test("a POST with neither body is refused and writes nothing", async () => {
    expect((await post(token, "")).status).toBe(400);
    expect((await post(token, "List-Unsubscribe=Other")).status).toBe(400);
    expect(await suppressionRows()).toHaveLength(0);
  });

  test("a permanent suppression already on file is left as it is", async () => {
    await addFromBounce(apiKeyId, { email: RECIPIENT, bounceType: "hard" });
    expect((await post(token)).status).toBe(200);
    const rows = await suppressionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("bounce");
  });

  test("a temporary suppression becomes a permanent unsubscribe", async () => {
    await addFromBounce(apiKeyId, {
      email: RECIPIENT,
      bounceType: "soft",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await post(token)).status).toBe(200);
    const [row] = await suppressionRows();
    expect(row?.reason).toBe("unsubscribe");
    expect(row?.expiresAt).toBeNull();
    expect(row?.bounceType).toBeNull();
  });

  test("the suppressed recipient is refused on the next send", async () => {
    await post(token);
    const send = createEmail(
      { from: "hello@acme.io", to: RECIPIENT, subject: "again", text: "x" },
      apiKeyId,
    );
    expect(await failure(send)).toBeInstanceOf(SuppressedRecipientError);
  });
});

describe("invalid tokens", () => {
  /** Changes one hex character at `index`. */
  function flip(t: string, index: number): string {
    return t.slice(0, index) + (t[index] === "0" ? "1" : "0") + t.slice(index + 1);
  }

  test("tampered, unknown, malformed or cc'd: 404, the same page, nothing written", async () => {
    const ccEmail = await seed.email({
      apiKeyId,
      fromAddress: "hello@acme.io",
      toAddress: RECIPIENT,
      cc: "boss@example.org",
    });
    const ccToken =
      mintUnsubscribeToken({ emailId: ccEmail.id, recipient: RECIPIENT }) ?? "";
    const unknown =
      mintUnsubscribeToken({
        emailId: "msg_ffffffffffffffffffffffff",
        recipient: RECIPIENT,
      }) ?? "";

    const invalid = [
      flip(token, 3),
      flip(token, 40),
      unknown,
      ccToken,
      "not-a-token",
      "a".repeat(5000),
    ];
    const pages = new Set<string>();
    for (const t of invalid) {
      const getRes = await get(t);
      expect(getRes.status).toBe(404);
      pages.add(await getRes.text());
      const postRes = await post(t);
      expect(postRes.status).toBe(404);
      const body = await postRes.text();
      pages.add(body);
      expect(body).not.toContain(t);
    }
    expect(pages.size).toBe(1);
    expect(await suppressionRows()).toHaveLength(0);
  });
});

describe("rate limit", () => {
  test("a client over the per-minute limit gets 429 with Retry-After", async () => {
    const limited = new Elysia().use(unsubscribePlugin({ max: 3, windowMs: 60_000 }));
    for (let i = 0; i < 3; i += 1) expect((await get(token, limited)).status).toBe(200);
    const res = await get(token, limited);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("List-Unsubscribe on a queued email", () => {
  const saved = { appBaseUrl: config.appBaseUrl, smtpEnabled: config.smtp.enabled };

  afterAll(() => {
    expect(Reflect.set(config, "appBaseUrl", saved.appBaseUrl)).toBe(true);
    Object.assign(config.smtp, { enabled: saved.smtpEnabled });
  });

  test("the queue sends the per-recipient link, and the link unsubscribes", async () => {
    expect(Reflect.set(config, "appBaseUrl", BASE)).toBe(true);
    Object.assign(config.smtp, { enabled: true });
    const domain = await seed.domain({
      name: "acme.io",
      unsubscribeUrl: "https://acme.io/static",
    });
    const queued = await seed.email({
      apiKeyId,
      domainId: domain.id,
      fromAddress: "hello@acme.io",
      toAddress: RECIPIENT,
    });

    const calls: Parameters<typeof sendMail>[0][] = [];
    const mailer: typeof sendMail = async (options) => {
      calls.push(options);
      return {
        messageId: options.messageId,
        deliveryState: {
          "mx.example.org": { status: "sent", recipients: [RECIPIENT], attempts: 1 },
        },
      };
    };
    await runQueueCycle({ sendMail: mailer });
    expect(calls).toHaveLength(1);

    const options = buildMailOptions({
      recipients: [RECIPIENT],
      from: "hello@acme.io",
      headerTo: RECIPIENT,
      headerCc: null,
      replyTo: null,
      subject: "s",
      html: null,
      text: "x",
      messageId: "<m@acme.io>",
      headers: {},
      unsubscribe: calls[0]!.unsubscribe,
    });
    const transport = createTransport({ streamTransport: true, buffer: true });
    const info = await transport.sendMail(options);
    if (!Buffer.isBuffer(info.message)) throw new Error("expected a buffered message");
    const block = info.message.toString().split("\r\n\r\n")[0] ?? "";

    const queuedToken =
      mintUnsubscribeToken({ emailId: queued.id, recipient: RECIPIENT }) ?? "";
    expect(block).toContain(`<${BASE}/u/${queuedToken}>`);
    expect(block).toContain(`unsub+${queuedToken}@acme.io`);
    expect(block).not.toContain("https://acme.io/static");
    expect(block).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);

    expect((await post(queuedToken)).status).toBe(200);
    const [row] = await suppressionRows();
    expect(row?.sourceEmailId).toBe(queued.id);
  });
});

describe("unsub+<token> mailbox on the inbound receiver", () => {
  /** Isolated port, distinct from the other SMTP test files. */
  const INBOUND_PORT = 12592;
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

  async function deliver(to: string, subject: string): Promise<void> {
    const transport = createTransport({
      host: "127.0.0.1",
      port: INBOUND_PORT,
      secure: false,
      ignoreTLS: true,
    });
    try {
      await transport.sendMail({ from: RECIPIENT, to, subject, text: "unsubscribe me" });
    } finally {
      transport.close();
    }
  }

  async function storedInbound(subject: string): Promise<number> {
    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM inbound_emails WHERE subject = ${subject}`,
    );
    return Number(rows[0]?.["n"]);
  }

  test("a valid token suppresses and the message is not stored", async () => {
    const subject = `unsub ${crypto.randomUUID()}`;
    await deliver(`UNSUB+${token.toUpperCase()}@acme.io`, subject);

    const deadline = Date.now() + 3000;
    let rows = await suppressionRows();
    while (rows.length === 0 && Date.now() < deadline) {
      await Bun.sleep(20);
      rows = await suppressionRows();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ apiKeyId, email: RECIPIENT, reason: "unsubscribe" });
    expect(await storedInbound(subject)).toBe(0);
  });

  test("an invalid token or the wrong domain is refused at RCPT TO, nothing stored", async () => {
    const subject = `bad unsub ${crypto.randomUUID()}`;
    const wrong = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(await failure(deliver(`unsub+${wrong}@acme.io`, subject))).toBeInstanceOf(
      Error,
    );
    expect(await failure(deliver(`unsub+${token}@other.io`, subject))).toBeInstanceOf(
      Error,
    );
    await Bun.sleep(100);
    expect(await storedInbound(subject)).toBe(0);
    expect(
      await db
        .select()
        .from(suppressions)
        .where(
          and(eq(suppressions.apiKeyId, apiKeyId), eq(suppressions.email, RECIPIENT)),
        ),
    ).toHaveLength(0);
  });
});
