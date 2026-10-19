/**
 * From display name, text alternative, HTML wrapper and send category
 * (#250) against a real Postgres.
 *
 * The REST send stores `fromName` and `category` (and nothing derived),
 * the queue hands them to the mailer, and the message Nodemailer renders
 * from what the mailer received carries the encoded display name, a text
 * part derived from HTML-only mail, the document wrapper around a
 * fragment, and `List-Unsubscribe` only as the category allows. SMTP
 * submission keeps the submitted display name and consumes
 * `X-BunMail-Category`.
 *
 * No SMTP delivery happens: the queue's mailer is injected and the message
 * is rendered with Nodemailer's stream transport, after the same body
 * composition `sendMail` applies (`composeMessageBody`).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Elysia, ValidationError } from "elysia";
import { eq, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { simpleParser, type ParsedMail } from "mailparser";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import {
  EmailSendRejectedError,
  InvalidFromNameError,
} from "../../src/modules/emails/errors.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import {
  buildMailOptions,
  type sendMail,
} from "../../src/modules/emails/services/mailer.service.ts";
import { composeMessageBody } from "../../src/modules/emails/services/message-body.ts";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { templates } from "../../src/modules/templates/models/template.schema.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mirrors the VALIDATION, `InvalidFromNameError` and `EmailSendRejectedError` branches of the global onError. */
const app = new Elysia()
  .onError(({ error, code, set }) => {
    if (code === "VALIDATION" && error instanceof ValidationError) {
      set.status = 422;
      return {
        success: false,
        error: "Request validation failed",
        code: "VALIDATION_ERROR",
      };
    }
    if (error instanceof InvalidFromNameError) {
      set.status = error.status;
      return {
        success: false,
        error: "Request validation failed",
        code: error.code,
        details: [{ path: `/${error.field}`, message: error.message }],
      };
    }
    if (error instanceof EmailSendRejectedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(emailsPlugin);

interface SendBody {
  success: boolean;
  data?: {
    id: string;
    fromName: string | null;
    category: string | null;
    html: string | null;
    text: string | null;
  };
  error?: string;
  code?: string;
  details?: { path: string; message: string }[];
}

/** An HTTPS `APP_BASE_URL`, so a single-recipient email can carry the one-click link. */
const BASE = "https://mail.example.com";

const savedBaseUrl = config.appBaseUrl;

/** Sets `config.appBaseUrl` for a test (the object is read-only only to TypeScript). */
function setBaseUrl(value: string): void {
  expect(Reflect.set(config, "appBaseUrl", value)).toBe(true);
}

/** POSTs a send as the calling key. */
async function send(
  key: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: SendBody; replayed: string | null }> {
  const res = await app.handle(
    new Request("http://localhost/api/v1/emails/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "s",
        ...body,
      }),
    }),
  );
  return {
    status: res.status,
    body: await readJson<SendBody>(res),
    replayed: res.headers.get("idempotent-replayed"),
  };
}

/** Number of emails rows. */
async function emailCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(emails);
  return row?.n ?? 0;
}

type MailerCall = Parameters<typeof sendMail>[0];

/** Runs one queue cycle with a mailer that records its calls and reports success. */
async function runQueue(): Promise<MailerCall[]> {
  const calls: MailerCall[] = [];
  const mailer: typeof sendMail = async (options) => {
    calls.push(options);
    return {
      messageId: options.messageId,
      deliveryState: {
        "example.org": {
          status: "sent",
          recipients: ["user@example.org"],
          attempts: 1,
          domain: "example.org",
        },
      },
    };
  };
  await runQueueCycle({ sendMail: mailer });
  return calls;
}

/**
 * Renders the message `sendMail` would send for one recorded call: the
 * body composed as `sendMail` composes it, then `buildMailOptions`.
 */
async function render(
  call: MailerCall,
): Promise<{ raw: string; parsed: ParsedMail; envelopeFrom: string }> {
  const body = composeMessageBody(call.html ?? null, call.text ?? null);
  const options = buildMailOptions({
    recipients: [call.to],
    from: call.from,
    fromName: call.fromName ?? null,
    headerTo: call.to,
    headerCc: call.cc ?? null,
    replyTo: call.replyTo ?? null,
    subject: call.subject,
    html: body.html,
    text: body.text,
    messageId: call.messageId,
    headers: call.headers ?? {},
    unsubscribe: call.unsubscribe,
    feedback: call.feedback,
    autoSubmitted: call.autoSubmitted,
    category: call.category ?? null,
  });
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail(options);
  if (!Buffer.isBuffer(info.message)) throw new Error("expected a buffered message");
  const envelope: unknown = info.envelope;
  const envelopeFrom =
    typeof envelope === "object" && envelope !== null
      ? Reflect.get(envelope, "from")
      : null;
  return {
    raw: info.message.toString(),
    parsed: await simpleParser(info.message),
    envelopeFrom: typeof envelopeFrom === "string" ? envelopeFrom : "",
  };
}

/** The one recorded mailer call, or a failure. */
function only(calls: MailerCall[]): MailerCall {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error("expected one mailer call");
  return call;
}

beforeEach(async () => {
  await truncateAll();
  setBaseUrl(BASE);
});

afterAll(() => {
  setBaseUrl(savedBaseUrl);
});

describe("fromName on the REST send", () => {
  test("is stored, returned, and sent as the encoded display name", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, {
      fromName: "  Zo\u00eb M\u00fcller  ",
      text: "x",
    });
    expect(status).toBe(200);
    expect(body.data!.fromName).toBe("Zo\u00eb M\u00fcller");

    const [row] = await db.select().from(emails).where(eq(emails.id, body.data!.id));
    expect(row!.fromName).toBe("Zo\u00eb M\u00fcller");
    expect(row!.fromAddress).toBe("hello@unregistered.test");

    const call = only(await runQueue());
    expect(call.fromName).toBe("Zo\u00eb M\u00fcller");
    expect(call.from).toBe("hello@unregistered.test");
    const { raw, parsed, envelopeFrom } = await render(call);
    /** RFC 2047 encoded in the header, decoded back by a reader. */
    expect(raw).toMatch(/^From: =\?UTF-8\?[QB]\?.+\?= <hello@unregistered\.test>$/m);
    expect(parsed.from?.value[0]).toEqual({
      name: "Zo\u00eb M\u00fcller",
      address: "hello@unregistered.test",
    });
    expect(envelopeFrom).toBe("hello@unregistered.test");
  });

  test("an ASCII name is quoted as needed", async () => {
    const { rawKey } = await seed.apiKey();
    await send(rawKey, { fromName: "Acme, Support", text: "x" });
    const { raw } = await render(only(await runQueue()));
    expect(raw).toMatch(/^From: "Acme, Support" <hello@unregistered\.test>$/m);
  });

  test("without one, From is the bare address and fromName is null", async () => {
    const { rawKey } = await seed.apiKey();
    const { body } = await send(rawKey, { text: "x" });
    expect(body.data!.fromName).toBeNull();
    const { raw } = await render(only(await runQueue()));
    expect(raw).toMatch(/^From: hello@unregistered\.test$/m);
  });

  test.each([
    ["an address", "support@paypal.com"],
    ["angle brackets", "PayPal <support@paypal.com>"],
    ["a quote", 'a" <x@example.com>'],
    ["a line break", "Acme\r\nBcc: victim@example.com"],
    ["a bidi override", "\u202emoc.lapyap"],
    ["only whitespace", "   "],
    ["101 characters", "a".repeat(101)],
  ])(
    "%s: 422 VALIDATION_ERROR naming the field, nothing queued",
    async (_label, fromName) => {
      const { rawKey } = await seed.apiKey();
      const { status, body } = await send(rawKey, { fromName, text: "x" });
      expect(status).toBe(422);
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.details?.[0]?.path).toBe("/fromName");
      expect(JSON.stringify(body)).not.toContain("paypal");
      expect(JSON.stringify(body)).not.toContain("victim");
      expect(await emailCount()).toBe(0);
    },
  );

  test("the idempotency snapshot keeps fromName and category for the replay", async () => {
    const { rawKey } = await seed.apiKey();
    const payload = { fromName: "Acme", category: "transactional", text: "x" };
    const first = await send(rawKey, payload, { "idempotency-key": "k-1" });
    const replay = await send(rawKey, payload, { "idempotency-key": "k-1" });
    expect(replay.replayed).toBe("true");
    expect(replay.body.data!.id).toBe(first.body.data!.id);
    expect(replay.body.data!.fromName).toBe("Acme");
    expect(replay.body.data!.category).toBe("transactional");
    expect(await emailCount()).toBe(1);
  });
});

describe("text alternative and HTML wrapper", () => {
  test("HTML only: multipart/alternative with a derived text part, nothing stored", async () => {
    const { rawKey } = await seed.apiKey();
    const html =
      '<p>Your code is <b>123</b>.</p><p><a href="https://example.com/x">Open</a></p>';
    const { body } = await send(rawKey, { html });
    expect(body.data!.text).toBeNull();

    const call = only(await runQueue());
    const { raw, parsed } = await render(call);
    expect(raw).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(parsed.text?.trim()).toBe("Your code is 123.\n\nOpen (https://example.com/x)");

    /** Derived per send: the row and the API still hold only what the caller sent. */
    const [row] = await db.select().from(emails).where(eq(emails.id, body.data!.id));
    expect(row!.textContent).toBeNull();
    expect(row!.html).toBe(html);
    expect(call.text ?? null).toBeNull();
  });

  test("the caller's text is kept as is", async () => {
    const { rawKey } = await seed.apiKey();
    await send(rawKey, { html: "<p>Hello</p>", text: "My own words" });
    const { parsed } = await render(only(await runQueue()));
    expect(parsed.text?.trim()).toBe("My own words");
  });

  test("a template without a text body keeps the caller's inline text", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const tpl = await seed.template({ apiKeyId, html: "<p>Hi {{name}}</p>" });
    await db.update(templates).set({ textContent: null }).where(eq(templates.id, tpl.id));
    const { status, body } = await send(rawKey, {
      templateId: tpl.id,
      variables: { name: "Ann" },
      text: "Inline text",
    });
    expect(status).toBe(200);
    expect(body.data!.text).toBe("Inline text");
  });

  test("a fragment is wrapped in a document; a full document is left alone", async () => {
    const { rawKey } = await seed.apiKey();
    await send(rawKey, { html: "<p>Fragment</p>" });
    const fragment = await render(only(await runQueue()));
    expect(fragment.parsed.html).toBe(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><p>Fragment</p></body></html>',
    );

    await truncateAll();
    const { rawKey: key2 } = await seed.apiKey();
    const doc = '<html lang="en"><body><p>Doc</p></body></html>';
    await send(key2, { html: doc });
    const full = await render(only(await runQueue()));
    expect(full.parsed.html).toBe(doc);
  });
});

describe("category", () => {
  test("transactional is stored and sent without List-Unsubscribe", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, { category: "transactional", text: "x" });
    expect(status).toBe(200);
    expect(body.data!.category).toBe("transactional");
    const [row] = await db.select().from(emails).where(eq(emails.id, body.data!.id));
    expect(row!.category).toBe("transactional");

    const call = only(await runQueue());
    expect(call.category).toBe("transactional");
    const { raw } = await render(call);
    expect(raw).not.toMatch(/^List-Unsubscribe/im);
  });

  test("no category: List-Unsubscribe as before, category null", async () => {
    const { rawKey } = await seed.apiKey();
    const { body } = await send(rawKey, { text: "x" });
    expect(body.data!.category).toBeNull();
    const { raw } = await render(only(await runQueue()));
    expect(raw).toMatch(/^List-Unsubscribe:/m);
  });

  test.each([
    ["a cc", { cc: "c@example.org" }],
    ["a bcc", { bcc: "c@example.org" }],
  ])(
    "marketing with %s: 422 MARKETING_REQUIRES_ONE_CLICK, nothing queued",
    async (_l, extra) => {
      const { rawKey } = await seed.apiKey();
      const { status, body } = await send(rawKey, {
        category: "marketing",
        text: "x",
        ...extra,
      });
      expect(status).toBe(422);
      expect(body.code).toBe("MARKETING_REQUIRES_ONE_CLICK");
      expect(await emailCount()).toBe(0);
    },
  );

  test("marketing without an https APP_BASE_URL: 422, nothing queued", async () => {
    setBaseUrl("http://mail.example.com");
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, { category: "marketing", text: "x" });
    expect(status).toBe(422);
    expect(body.code).toBe("MARKETING_REQUIRES_ONE_CLICK");
    expect(await emailCount()).toBe(0);
  });

  test("marketing with one recipient carries the per-recipient one-click link", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, { category: "marketing", text: "x" });
    expect(status).toBe(200);
    expect(body.data!.category).toBe("marketing");

    const { raw } = await render(only(await runQueue()));
    /** Nodemailer may fold the header onto a continuation line. */
    expect(raw).toMatch(
      /^List-Unsubscribe:\s*<https:\/\/mail\.example\.com\/u\/[0-9a-f]{24}\.[0-9a-f]{32}>/m,
    );
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r?$/m);
  });

  test("an unknown category is a validation error", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, { category: "newsletter", text: "x" });
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(await emailCount()).toBe(0);
  });
});

describe("SMTP submission", () => {
  /** Isolated port, distinct from the other SMTP test files'. */
  const TEST_PORT = 12604;

  beforeAll(() => {
    smtpSubmission.start(TEST_PORT);
  });

  afterAll(() => {
    smtpSubmission.stop();
  });

  function client(rawKey: string): ReturnType<typeof createTransport> {
    return createTransport({
      host: "127.0.0.1",
      port: TEST_PORT,
      secure: false,
      ignoreTLS: true,
      auth: { user: "apikey", pass: rawKey },
      tls: { rejectUnauthorized: false },
    });
  }

  test("keeps the display name and consumes X-BunMail-Category", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    await client(rawKey).sendMail({
      from: { name: "Acme Support", address: "hello@unregistered.test" },
      to: "user@example.org",
      subject: "via smtp",
      text: "hi",
      headers: { "X-BunMail-Category": "transactional", "X-Trace": "1" },
    });

    const [row] = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(row!.fromName).toBe("Acme Support");
    expect(row!.fromAddress).toBe("hello@unregistered.test");
    expect(row!.category).toBe("transactional");
    const names = Object.keys(row!.headers ?? {}).map((n) => n.toLowerCase());
    expect(names).toContain("x-trace");
    expect(names).not.toContain("x-bunmail-category");

    const call = only(await runQueue());
    const { raw, parsed } = await render(call);
    expect(raw).not.toMatch(/^X-BunMail-Category/im);
    expect(raw).not.toMatch(/^List-Unsubscribe/im);
    expect(parsed.from?.value[0]?.name).toBe("Acme Support");
  });

  test("an invalid display name is dropped, the mail still accepted", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    await client(rawKey).sendMail({
      from: { name: "support@paypal.com", address: "hello@unregistered.test" },
      to: "user@example.org",
      subject: "via smtp",
      text: "hi",
    });
    const [row] = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(row).toBeDefined();
    expect(row!.fromName).toBeNull();
  });

  test.each([["newsletter"], ["transactional, marketing"]])(
    "X-BunMail-Category: %p is refused with 550, nothing queued",
    async (value) => {
      const { rawKey } = await seed.apiKey();
      const refused = await client(rawKey)
        .sendMail({
          from: "hello@unregistered.test",
          to: "user@example.org",
          subject: "via smtp",
          text: "hi",
          headers: { "X-BunMail-Category": value },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(Error);
      expect(Reflect.get(Object(refused), "responseCode")).toBe(550);
      expect(String(Reflect.get(Object(refused), "response"))).toContain(
        "X-BunMail-Category",
      );
      expect(await emailCount()).toBe(0);
    },
  );

  test("marketing to two recipients is refused with 550", async () => {
    const { rawKey } = await seed.apiKey();
    const refused = await client(rawKey)
      .sendMail({
        from: "hello@unregistered.test",
        to: "a@example.org, b@example.org",
        subject: "via smtp",
        text: "hi",
        headers: { "X-BunMail-Category": "marketing" },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(Reflect.get(Object(refused), "responseCode")).toBe(550);
    expect(String(Reflect.get(Object(refused), "response"))).toContain("one-click");
    expect(await emailCount()).toBe(0);
  });
});
