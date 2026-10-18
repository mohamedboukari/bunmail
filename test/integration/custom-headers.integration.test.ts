/**
 * Custom headers on the send API (#177) against a real Postgres.
 *
 * Covers the whole path: `POST /api/v1/emails/send` validates and stores
 * the headers as a real jsonb object, header-injection and reserved-name
 * attempts get `422` with nothing queued, the queue hands the stored set
 * to the mailer, the message Nodemailer renders carries them (and nothing
 * injected), and SMTP submission relays `In-Reply-To` / `X-*` while
 * dropping `X-BunMail-*` and headers it never relays.
 *
 * The REST app mirrors the VALIDATION and `EmailSendRejectedError`
 * branches of the global `onError` in `src/index.ts`. No SMTP delivery
 * happens: the queue's mailer is injected and the message is rendered
 * with Nodemailer's stream transport.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Elysia, ValidationError } from "elysia";
import { eq, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { EmailSendRejectedError } from "../../src/modules/emails/errors.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import {
  buildMailOptions,
  type sendMail,
} from "../../src/modules/emails/services/mailer.service.ts";
import { filterCustomHeaders } from "../../src/modules/emails/services/custom-headers.ts";
import { generateId } from "../../src/utils/id.ts";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mirrors the VALIDATION and `EmailSendRejectedError` branches of the global onError. */
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
    if (error instanceof EmailSendRejectedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(emailsPlugin);

interface SendBody {
  success: boolean;
  data?: { id: string; headers: Record<string, string> | null };
  error?: string;
  code?: string;
}

/** POSTs a send with `headers` as the calling key. */
async function send(
  key: string,
  headers: unknown,
): Promise<{ status: number; body: SendBody }> {
  const res = await app.handle(
    new Request("http://localhost/api/v1/emails/send", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "s",
        text: "x",
        headers,
      }),
    }),
  );
  return { status: res.status, body: await readJson<SendBody>(res) };
}

/** Number of emails rows. */
async function emailCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(emails);
  return row?.n ?? 0;
}

/** Renders the message Nodemailer would send and returns its header block. */
async function renderHeaderBlock(options: ReturnType<typeof buildMailOptions>) {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail(options);
  if (!Buffer.isBuffer(info.message)) throw new Error("expected a buffered message");
  return info.message.toString().split("\r\n\r\n")[0] ?? "";
}

beforeEach(async () => {
  await truncateAll();
});

describe("REST send with custom headers", () => {
  test("stores them as a jsonb object and returns them", async () => {
    const { rawKey } = await seed.apiKey();
    const headers = { "X-Correlation-Id": "abc", "In-Reply-To": "<p@example.com>" };

    const { status, body } = await send(rawKey, headers);
    expect(status).toBe(200);
    expect(body.data!.headers).toEqual(headers);

    const [row] = await db
      .select({ headers: emails.headers, type: sql<string>`jsonb_typeof(headers)` })
      .from(emails)
      .where(eq(emails.id, body.data!.id));
    expect(row!.type).toBe("object");
    expect(row!.headers).toEqual(headers);
  });

  test("no headers: the column is null", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, undefined);
    expect(status).toBe(200);
    expect(body.data!.headers).toBeNull();
  });

  test("a header-injection attempt gets 422 and nothing is queued", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, {
      "X-A": "v\r\nBcc: victim@example.com",
    });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).not.toContain("victim");
    expect(await emailCount()).toBe(0);
  });

  test("an invalid name (colon) gets 422 and nothing is queued", async () => {
    const { rawKey } = await seed.apiKey();
    const { status } = await send(rawKey, { "Bcc: victim@example.com\r\nX-A": "v" });
    expect(status).toBe(422);
    expect(await emailCount()).toBe(0);
  });

  test.each([
    "From",
    "dkim-signature",
    "LIST-UNSUBSCRIBE",
    "Content-Type",
    "X-BunMail-Id",
  ])("reserved %p gets 422 INVALID_CUSTOM_HEADER and nothing is queued", async (name) => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, { [name]: "evil@example.com" });
    expect(status).toBe(422);
    expect(body.code).toBe("INVALID_CUSTOM_HEADER");
    expect(body.error).toContain(name);
    expect(body.error).not.toContain("evil@example.com");
    expect(await emailCount()).toBe(0);
  });

  test("a case-insensitive duplicate gets 422 INVALID_CUSTOM_HEADER", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, { "X-Foo": "1", "x-foo": "2" });
    expect(status).toBe(422);
    expect(body.code).toBe("INVALID_CUSTOM_HEADER");
    expect(await emailCount()).toBe(0);
  });
});

describe("queue and mailer", () => {
  test("the queue hands the stored headers to the mailer", async () => {
    const { rawKey } = await seed.apiKey();
    const headers = { "X-Correlation-Id": "abc" };
    await send(rawKey, headers);

    const calls: Parameters<typeof sendMail>[0][] = [];
    const mailer: typeof sendMail = async (options) => {
      calls.push(options);
      return {
        messageId: options.messageId,
        deliveryState: {
          "mx.example.org": {
            status: "sent",
            recipients: ["user@example.org"],
            attempts: 1,
          },
        },
      };
    };
    await runQueueCycle({ sendMail: mailer });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers).toEqual(headers);
  });

  test("the rendered message carries the custom header and BunMail's own", async () => {
    const block = await renderHeaderBlock(
      buildMailOptions({
        recipients: ["user@example.org"],
        from: "hello@example.com",
        headerTo: "user@example.org",
        headerCc: null,
        replyTo: null,
        subject: "s",
        html: null,
        text: "x",
        messageId: "<mid@example.com>",
        headers: { "X-Correlation-Id": "abc", "In-Reply-To": "<p@example.com>" },
      }),
    );
    expect(block).toMatch(/^X-Correlation-Id: abc$/im);
    expect(block).toMatch(/^In-Reply-To: <p@example\.com>$/im);
    expect(block).toMatch(/^Message-ID: <mid@example\.com>$/im);
    expect(block.match(/^List-Unsubscribe:/gim)).toHaveLength(1);
  });

  test("a stored injection or reserved header never reaches the rendered message", async () => {
    /** What `sendMail` does to a stored set before building the message. */
    const { headers } = filterCustomHeaders(
      Object.entries({
        "X-Ok": "1",
        "X-A": "v\r\nBcc: victim@example.com",
        "list-unsubscribe": "<mailto:evil@example.com>",
        "message-id": "<evil@example.com>",
      }),
    );
    const block = await renderHeaderBlock(
      buildMailOptions({
        recipients: ["user@example.org"],
        from: "hello@example.com",
        headerTo: "user@example.org",
        headerCc: null,
        replyTo: null,
        subject: "s",
        html: null,
        text: "x",
        messageId: "<mid@example.com>",
        headers,
      }),
    );
    expect(block).toMatch(/^X-Ok: 1$/im);
    expect(block).not.toMatch(/^Bcc:/im);
    expect(block).not.toContain("victim");
    expect(block).not.toContain("evil");
    expect(block.match(/^List-Unsubscribe:/gim)).toHaveLength(1);
    expect(block.match(/^Message-ID:/gim)).toHaveLength(1);
  });

  test("a row written without createEmail still goes through the mailer's filter", async () => {
    /** Inserted directly: proves the stored value round-trips as an object. */
    const { id: apiKeyId } = await seed.apiKey();
    const id = generateId("msg");
    await db.insert(emails).values({
      id,
      apiKeyId,
      fromAddress: "hello@unregistered.test",
      toAddress: "user@example.org",
      subject: "s",
      textContent: "x",
      headers: { "X-Ok": "1", "dkim-signature": "forged" },
    });
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row!.headers).toEqual({ "X-Ok": "1", "dkim-signature": "forged" });
    expect(filterCustomHeaders(Object.entries(row!.headers ?? {})).headers).toEqual({
      "X-Ok": "1",
    });
  });
});

describe("SMTP submission relays custom headers", () => {
  /** Isolated port, distinct from the other SMTP submission test file's. */
  const TEST_PORT = 12591;

  beforeAll(() => {
    smtpSubmission.start(TEST_PORT);
  });

  afterAll(() => {
    smtpSubmission.stop();
  });

  test("relays In-Reply-To and X-Foo, drops X-BunMail-Foo and non-relayed headers", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const transport = createTransport({
      host: "127.0.0.1",
      port: TEST_PORT,
      secure: false,
      ignoreTLS: true,
      auth: { user: "apikey", pass: rawKey },
      tls: { rejectUnauthorized: false },
    });

    await transport.sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "via smtp",
      text: "hi",
      headers: {
        "In-Reply-To": "<parent@example.com>",
        "X-Foo": "bar",
        "X-BunMail-Foo": "spoofed",
        "List-Unsubscribe": "<mailto:evil@example.com>",
        "Feedback-ID": "forged",
      },
    });

    const [row] = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(row).toBeDefined();
    expect(row!.source).toBe("smtp");
    const stored = row!.headers ?? {};
    expect(stored["In-Reply-To"]).toBe("<parent@example.com>");
    expect(stored["X-Foo"]).toBe("bar");
    const lowerNames = Object.keys(stored).map((n) => n.toLowerCase());
    expect(lowerNames).not.toContain("x-bunmail-foo");
    expect(lowerNames).not.toContain("list-unsubscribe");
    expect(lowerNames).not.toContain("feedback-id");
    expect(lowerNames).not.toContain("from");
  });
});
