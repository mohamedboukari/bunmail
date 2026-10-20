/**
 * Several `to` recipients and the batch send endpoint (#178), against a
 * real Postgres, the real emails plugin (its real auth and rate-limit
 * middleware) and, for delivery, the real queue and mailer talking SMTP to
 * an in-process receiving server.
 *
 * - `to` as an array: one email row with the normalized list; the message
 *   delivered lists every `to` address in `To:`, keeps cc visible and bcc
 *   out of every header; RCPT TO is split per recipient domain, or per
 *   recipient under signed return paths.
 * - The suppression gate, the marketing rule and the recipient caps apply
 *   to the whole list.
 * - The response's `to` is a string for a single-address send, an array
 *   when the send gave an array or the email has several addresses.
 * - Batch: items in order and independent, per-item idempotency keys, the
 *   rate limiter counting the batch as one send per email, the
 *   `Idempotency-Key` header refused.
 * - A signed return path names the right recipient of a several-`to` email
 *   (the bounce recipient check, #235/#236).
 * - The dashboard list shows the first recipient and `+N`, the detail page
 *   all of them, escaped.
 *
 * The app's error handler is the shared `serializeSendError` plus the
 * VALIDATION branch of the global `onError` in `src/index.ts`.
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
import { Elysia, ValidationError } from "elysia";
import { SMTPServer } from "smtp-server";
import { eq, sql } from "drizzle-orm";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { serializeSendError } from "../../src/modules/emails/serializations/send-error.serialization.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { setMxRouteDeps } from "../../src/modules/emails/services/mx-route.ts";
import { mintReturnPath } from "../../src/modules/bounces/services/return-path.ts";
import { resolveReturnPath } from "../../src/modules/bounces/services/bounce-handler.service.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { securityHeadersPlugin } from "../../src/middleware/security-headers.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** The emails plugin behind the error mapping production uses. */
const app = new Elysia()
  .onError(({ error, code, set }) => {
    if (code === "VALIDATION" && error instanceof ValidationError) {
      set.status = 422;
      return {
        success: false,
        error: "Request validation failed",
        code: "VALIDATION_ERROR",
        details: error.all.slice(0, 10).map((e) => ({ path: e.path })),
      };
    }
    const refusal = serializeSendError(error);
    if (refusal) {
      set.status = refusal.status;
      return refusal.body;
    }
  })
  .use(emailsPlugin);

interface EmailData {
  id: string;
  to: string | string[];
  cc: string | null;
  bcc: string | null;
}

interface SendBody {
  success: boolean;
  data?: EmailData;
  error?: string;
  code?: string;
  suppressionId?: string | null;
}

interface BatchItem {
  index: number;
  success: boolean;
  data?: EmailData;
  replayed?: boolean;
  warnings?: string[];
  error?: string;
  code?: string;
  details?: { path: string; message: string }[];
  suppressionId?: string | null;
}

interface BatchBody {
  success: boolean;
  data?: BatchItem[];
  error?: string;
  code?: string;
}

/** A valid send body; `overrides` replace or add members. */
function sendBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: "hello@unregistered.test",
    to: "user@example.org",
    subject: "Order shipped",
    text: "Your order is on its way.",
    ...overrides,
  };
}

/** Sends a request to an emails route as `rawKey`, with a JSON body when given. */
function request(
  path: string,
  rawKey: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/v1/emails${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${rawKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** POST /send. */
async function send(
  rawKey: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: SendBody }> {
  const res = await request("/send", rawKey, body, headers);
  return { status: res.status, body: await readJson<SendBody>(res) };
}

/** POST /batch. */
async function batch(
  rawKey: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: BatchBody }> {
  const res = await request("/batch", rawKey, body, headers);
  return { status: res.status, body: await readJson<BatchBody>(res) };
}

/** GET /:id. */
async function readEmail(rawKey: string, id: string): Promise<SendBody> {
  return readJson<SendBody>(await request(`/${id}`, rawKey));
}

/** GET / (the list). */
async function listEmails(
  rawKey: string,
): Promise<{ status: number; body: { data: EmailData[] } }> {
  const res = await request("/", rawKey);
  return { status: res.status, body: await readJson<{ data: EmailData[] }>(res) };
}

/** Number of emails rows. */
async function emailCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(emails);
  return row?.n ?? 0;
}

/** `n` distinct addresses at `domain`. */
function addresses(n: number, domain = "example.org"): string[] {
  return Array.from({ length: n }, (_, i) => `user${i}@${domain}`);
}

/* ─── An in-process receiving MX ─── */

/** One SMTP transaction the receiver accepted. */
interface Received {
  mailFrom: string;
  rcptTo: string[];
  raw: string;
}

const received: Received[] = [];

/** Plaintext receiver for every MX host of the test domains. */
const receiver = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS", "AUTH"],
  logger: false,
  onData(stream, session, callback) {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const from = session.envelope.mailFrom;
      received.push({
        mailFrom: from === false ? "" : from.address,
        rcptTo: session.envelope.rcptTo.map((r) => r.address.toLowerCase()),
        raw: Buffer.concat(chunks).toString(),
      });
      callback();
    });
  },
});

let receiverPort = 0;
const savedAllowPrivate = config.mail.allowPrivateMx;

/** A DNS error with its `code`, as `dns/promises` rejects. */
function dnsError(code: string): Error {
  return Object.assign(new Error(`queryMx ${code}`), { code });
}

beforeAll(async () => {
  Object.assign(config.mail, { allowPrivateMx: true });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  const address = receiver.server.address();
  receiverPort = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
  Object.assign(config.mail, { allowPrivateMx: savedAllowPrivate });
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

beforeEach(async () => {
  await truncateAll();
  received.length = 0;
  /** `example.org` and `example.net` each have one MX, both this receiver. */
  setMxRouteDeps({
    resolveMx: async (domain) => {
      if (domain !== "example.org" && domain !== "example.net") {
        throw dnsError("ENOTFOUND");
      }
      return [{ exchange: `mx.${domain}`, priority: 10 }];
    },
    resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
    lookup: async () => [{ address: "127.0.0.1" }],
    smtpPort: () => receiverPort,
  });
});

afterEach(() => {
  setMxRouteDeps(null);
});

/** The header section of a raw message (everything before the first blank line). */
function headerSection(raw: string): string {
  const end = raw.search(/\r?\n\r?\n/);
  return end < 0 ? raw : raw.slice(0, end);
}

/** The unfolded value of the first `name:` header of a raw message. */
function headerValue(raw: string, name: string): string | undefined {
  const unfolded = headerSection(raw).replace(/\r?\n[ \t]+/g, " ");
  const line = unfolded
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(name.length + 1).trim();
}

const ALICE = "alice@example.org";
const BOB = "Bob@example.org";
const CAROL = "carol@example.net";
const DAVE = "dave@example.net";
const ERIN = "erin@example.org";

describe("to as an array: one message, every to address in To:", () => {
  test("3 to addresses over 2 domains, with cc and bcc: one row, per-domain RCPT, bcc in no header", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(
      rawKey,
      sendBody({ to: [ALICE, BOB, CAROL], cc: ERIN, bcc: DAVE }),
    );
    expect(status).toBe(200);
    expect(body.data!.to).toEqual([ALICE, BOB, CAROL]);
    expect(await emailCount()).toBe(1);

    const [row] = await db.select().from(emails).where(eq(emails.id, body.data!.id));
    expect(row!.toAddress).toBe(`${ALICE}, ${BOB}, ${CAROL}`);

    await runQueueCycle({ sendMail, signedReturnPath: async () => false });

    /** One transaction per recipient domain, each with that domain's recipients only. */
    const byDomain = new Map(
      received.map((r) => [r.rcptTo[0]?.split("@")[1] ?? "", r] as const),
    );
    expect(received).toHaveLength(2);
    expect(byDomain.get("example.org")!.rcptTo.toSorted()).toEqual(
      [ALICE, BOB.toLowerCase(), ERIN].toSorted(),
    );
    expect(byDomain.get("example.net")!.rcptTo.toSorted()).toEqual(
      [CAROL, DAVE].toSorted(),
    );

    for (const message of received) {
      const to = headerValue(message.raw, "To")!;
      for (const address of [ALICE, BOB, CAROL]) expect(to).toContain(address);
      expect(headerValue(message.raw, "Cc")).toContain(ERIN);
      expect(headerValue(message.raw, "Bcc")).toBeUndefined();
      /** The blind recipient appears in no header at all. */
      expect(headerSection(message.raw).toLowerCase()).not.toContain(DAVE);
    }

    const [sent] = await db.select().from(emails).where(eq(emails.id, body.data!.id));
    expect(sent!.status).toBe("sent");
    expect(Object.keys(sent!.deliveryState ?? {}).toSorted()).toEqual([
      "example.net",
      "example.org",
    ]);
  });

  test("signed return paths: one transaction per recipient, each with its own envelope sender", async () => {
    const { rawKey } = await seed.apiKey();
    const { body } = await send(rawKey, sendBody({ to: [ALICE, BOB, CAROL], bcc: DAVE }));
    await runQueueCycle({ sendMail, signedReturnPath: async () => true });

    expect(received.map((r) => r.rcptTo)).toHaveLength(4);
    for (const message of received) expect(message.rcptTo).toHaveLength(1);
    expect(received.flatMap((r) => r.rcptTo).toSorted()).toEqual(
      [ALICE, BOB.toLowerCase(), CAROL, DAVE].toSorted(),
    );
    expect(new Set(received.map((r) => r.mailFrom)).size).toBe(4);
    for (const message of received) {
      expect(message.mailFrom).toStartWith("b+");
      expect(headerSection(message.raw).toLowerCase()).not.toContain(DAVE);
    }

    const [sent] = await db.select().from(emails).where(eq(emails.id, body.data!.id));
    expect(Object.keys(sent!.deliveryState ?? {})).toHaveLength(4);
  });

  test("duplicates are removed ignoring case, the first spelling kept", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(
      rawKey,
      sendBody({ to: [BOB, "bob@EXAMPLE.org", ALICE, BOB] }),
    );
    expect(status).toBe(200);
    expect(body.data!.to).toEqual([BOB, ALICE]);
  });

  test("a suppressed address anywhere in the array refuses the send, nothing queued", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const { id: suppressionId } = await seed.suppression({ apiKeyId, email: CAROL });
    const { status, body } = await send(rawKey, sendBody({ to: [ALICE, CAROL, BOB] }));
    expect(status).toBe(422);
    expect(body.code).toBe("RECIPIENT_SUPPRESSED");
    expect(body.suppressionId).toBe(suppressionId);
    expect(await emailCount()).toBe(0);
  });

  test("marketing with 2 to addresses is refused", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(
      rawKey,
      sendBody({ to: [ALICE, CAROL], category: "marketing" }),
    );
    expect(status).toBe(422);
    expect(body.code).toBe("MARKETING_REQUIRES_ONE_CLICK");
    expect(await emailCount()).toBe(0);
  });

  test("51 to addresses: 422 TOO_MANY_RECIPIENTS, nothing queued", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, sendBody({ to: addresses(51) }));
    expect(status).toBe(422);
    expect(body.code).toBe("TOO_MANY_RECIPIENTS");
    expect(await emailCount()).toBe(0);
  });

  test("50 to addresses plus a duplicate: accepted, the cap counts unique addresses", async () => {
    const { rawKey } = await seed.apiKey();
    const list = addresses(50);
    const { status, body } = await send(
      rawKey,
      sendBody({ to: [...list, list[0]!.toUpperCase()] }),
    );
    expect(status).toBe(200);
    expect(body.data!.to).toHaveLength(50);
  });

  test("more than 100 unique recipients across to, cc and bcc: 422 TOO_MANY_RECIPIENTS", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(
      rawKey,
      sendBody({
        to: addresses(50),
        cc: addresses(26, "example.net").join(","),
        bcc: addresses(25, "example.com").join(","),
      }),
    );
    expect(status).toBe(422);
    expect(body.code).toBe("TOO_MANY_RECIPIENTS");
    expect(body.error).toContain("100");
    expect(await emailCount()).toBe(0);
  });

  test("an invalid address in the array is a 422 VALIDATION_ERROR", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(
      rawKey,
      sendBody({ to: [ALICE, "not an address"] }),
    );
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

describe("the response's to", () => {
  test("a single-string send still returns a string, here and on GET", async () => {
    const { rawKey } = await seed.apiKey();
    const { body } = await send(rawKey, sendBody({ to: ALICE }));
    expect(body.data!.to).toBe(ALICE);
    const read = await readEmail(rawKey, body.data!.id);
    expect(read.data!.to).toBe(ALICE);
  });

  test("a one-address array returns an array", async () => {
    const { rawKey } = await seed.apiKey();
    const { body } = await send(rawKey, sendBody({ to: [ALICE] }));
    expect(body.data!.to).toEqual([ALICE]);
  });

  test("an email with several to addresses reads back as an array", async () => {
    const { rawKey } = await seed.apiKey();
    const { body } = await send(rawKey, sendBody({ to: [ALICE, CAROL] }));
    const read = await readEmail(rawKey, body.data!.id);
    expect(read.data!.to).toEqual([ALICE, CAROL]);
    const list = await listEmails(rawKey);
    expect(list.body.data[0]!.to).toEqual([ALICE, CAROL]);
  });

  test("an idempotent replay returns the same shape", async () => {
    const { rawKey } = await seed.apiKey();
    const first = await send(rawKey, sendBody({ to: [ALICE] }), {
      "idempotency-key": "array-shape",
    });
    const again = await send(rawKey, sendBody({ to: [ALICE] }), {
      "idempotency-key": "array-shape",
    });
    expect(first.body.data!.to).toEqual([ALICE]);
    expect(again.body.data!.to).toEqual([ALICE]);
    expect(again.body.data!.id).toBe(first.body.data!.id);
  });
});

describe("POST /api/v1/emails/batch", () => {
  test("3 items, the 2nd invalid: items 1 and 3 created, item 2 has the error, order kept", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await batch(rawKey, {
      emails: [
        sendBody({ to: ALICE, subject: "first" }),
        sendBody({ to: "not an address" }),
        sendBody({ to: [CAROL, DAVE], subject: "third" }),
      ],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const items = body.data!;
    expect(items.map((i) => [i.index, i.success])).toEqual([
      [0, true],
      [1, false],
      [2, true],
    ]);
    expect(items[0]!.data!.to).toBe(ALICE);
    expect(items[0]!.replayed).toBe(false);
    expect(items[0]!.warnings).toBeArray();
    expect(items[1]!.code).toBe("VALIDATION_ERROR");
    expect(items[1]!.details!.map((d) => d.path)).toContain("/to");
    expect(items[2]!.data!.to).toEqual([CAROL, DAVE]);

    const rows = await db.select().from(emails);
    expect(rows.map((r) => r.subject).toSorted()).toEqual(["first", "third"]);
    expect(new Set(rows.map((r) => r.id))).toEqual(
      new Set([items[0]!.data!.id, items[2]!.data!.id]),
    );
  });

  test("a refused item carries the code /send would answer; the others are created", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const { id: suppressionId } = await seed.suppression({ apiKeyId, email: BOB });
    const { body } = await batch(rawKey, {
      emails: [
        sendBody({ to: [ALICE, BOB] }),
        sendBody({ to: addresses(51) }),
        sendBody({ to: CAROL, category: "marketing" }),
        sendBody({ to: DAVE }),
      ],
    });
    const items = body.data!;
    expect(items[0]).toMatchObject({
      index: 0,
      success: false,
      code: "RECIPIENT_SUPPRESSED",
      suppressionId,
    });
    expect(items[1]).toMatchObject({ index: 1, code: "TOO_MANY_RECIPIENTS" });
    expect(items[2]).toMatchObject({ index: 2, success: false });
    expect(items[3]).toMatchObject({ index: 3, success: true });
    const rows = await db.select().from(emails);
    expect(rows.map((r) => r.toAddress)).toEqual([DAVE]);
  });

  test("per-item idempotency keys: a repeat replays each keyed item and creates nothing", async () => {
    const { rawKey } = await seed.apiKey();
    const items = {
      emails: [
        sendBody({ to: ALICE, idempotencyKey: "order-1" }),
        sendBody({ to: [CAROL, DAVE], idempotencyKey: "order-2" }),
      ],
    };
    const first = await batch(rawKey, items);
    expect(first.body.data!.map((i) => i.replayed)).toEqual([false, false]);
    expect(await emailCount()).toBe(2);

    const again = await batch(rawKey, items);
    expect(again.status).toBe(200);
    expect(again.body.data!.map((i) => i.replayed)).toEqual([true, true]);
    expect(again.body.data!.map((i) => i.data!.id)).toEqual(
      first.body.data!.map((i) => i.data!.id),
    );
    expect(again.body.data![1]!.data!.to).toEqual([CAROL, DAVE]);
    expect(await emailCount()).toBe(2);

    /** The same key with another body fails that item only. */
    const reused = await batch(rawKey, {
      emails: [
        sendBody({ to: ALICE, subject: "changed", idempotencyKey: "order-1" }),
        sendBody({ to: ERIN }),
      ],
    });
    expect(reused.body.data![0]).toMatchObject({
      success: false,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(reused.body.data![1]).toMatchObject({ success: true, replayed: false });
    expect(await emailCount()).toBe(3);
  });

  test("a key used on /send replays in a batch item with the same body", async () => {
    const { rawKey } = await seed.apiKey();
    const single = await send(rawKey, sendBody({ to: ALICE }), {
      "idempotency-key": "shared",
    });
    const { body } = await batch(rawKey, {
      emails: [sendBody({ to: ALICE, idempotencyKey: "shared" })],
    });
    expect(body.data![0]).toMatchObject({ success: true, replayed: true });
    expect(body.data![0]!.data!.id).toBe(single.body.data!.id);
    expect(await emailCount()).toBe(1);
  });

  test("over the remaining rate budget: 429 and nothing created", async () => {
    const { rawKey } = await seed.apiKey();
    const { max } = config.apiRateLimit;
    /** Spend all but `max - 50` of the window on cheap reads. */
    const spent = max - 50;
    for (let i = 0; i < spent; i++) {
      expect((await listEmails(rawKey)).status).toBe(200);
    }

    const over = await batch(rawKey, {
      emails: Array.from({ length: 51 }, (_, i) => sendBody({ subject: `n${i}` })),
    });
    expect(over.status).toBe(429);
    expect(await emailCount()).toBe(0);

    /**
     * The refused batch counted once, so 49 sends remain: a batch of 49
     * fits exactly, and any request after it is limited.
     */
    const fits = await batch(rawKey, {
      emails: Array.from({ length: 49 }, (_, i) => sendBody({ subject: `m${i}` })),
    });
    expect(fits.status).toBe(200);
    expect(await emailCount()).toBe(49);
    expect((await listEmails(rawKey)).status).toBe(429);
  });

  test("the Idempotency-Key header is refused with 422, nothing created", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await batch(
      rawKey,
      { emails: [sendBody()] },
      { "idempotency-key": "whole-batch" },
    );
    expect(status).toBe(422);
    expect(body.code).toBe("IDEMPOTENCY_KEY_NOT_SUPPORTED");
    expect(body.error).toContain("idempotencyKey");
    expect(await emailCount()).toBe(0);
  });

  test("an empty batch, or more than 100 items, is a 422 for the whole request", async () => {
    const { rawKey } = await seed.apiKey();
    expect((await batch(rawKey, { emails: [] })).status).toBe(422);
    const tooMany = await batch(rawKey, {
      emails: Array.from({ length: 101 }, () => sendBody()),
    });
    expect(tooMany.status).toBe(422);
    expect(await emailCount()).toBe(0);
  });

  test("unknown item properties are dropped, not stored or hashed", async () => {
    const { rawKey } = await seed.apiKey();
    const { body } = await batch(rawKey, {
      emails: [sendBody({ idempotencyKey: "extra", bogus: "x" })],
    });
    expect(body.data![0]!.success).toBe(true);
    const again = await batch(rawKey, {
      emails: [sendBody({ idempotencyKey: "extra" })],
    });
    expect(again.body.data![0]).toMatchObject({ success: true, replayed: true });
  });
});

describe("bounce recipient matching with several to addresses (#235, #236)", () => {
  test("each signed return path names its own recipient of the list", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: emailId } = await seed.email({
      apiKeyId,
      fromAddress: "hello@acme.io",
      toAddress: `${ALICE}, ${CAROL}`,
      cc: ERIN,
      bcc: DAVE,
      status: "sent",
    });
    const order = [ALICE, CAROL, ERIN, DAVE];
    for (const [index, recipient] of order.entries()) {
      const address = mintReturnPath({ emailId, index, recipient }, "acme.io");
      expect(address).not.toBeNull();
      const binding = await resolveReturnPath(address!);
      expect(binding?.recipient).toBe(recipient);
    }
    /** An index past the list resolves to nothing. */
    const past = mintReturnPath({ emailId, index: 4, recipient: ALICE }, "acme.io");
    expect(past === null || (await resolveReturnPath(past)) === null).toBe(true);
  });
});

describe("dashboard with several to addresses", () => {
  const dashboard = new Elysia()
    .use(securityHeadersPlugin({ httpsBaseUrl: false }))
    .use(pagesPlugin);

  /** Addresses that would be markup if they were not escaped (a stored row, not REST input). */
  const MARKUP_FIRST = "<b>first</b>@example.org";
  const MARKUP_LAST = "<img src=x onerror=alert(1)>@example.net";

  async function page(path: string): Promise<string> {
    const { id } = await seed.user({
      email: `member-${Date.now()}@example.com`,
      role: "member",
    });
    const { token } = await seed.session({ userId: id });
    const res = await dashboard.handle(
      new Request(`http://localhost${path}`, {
        headers: { cookie: `bm_session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    return res.text();
  }

  test("the list shows the first recipient and +N, escaped", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.email({
      apiKeyId,
      toAddress: `${MARKUP_FIRST}, ${CAROL}, ${MARKUP_LAST}`,
      subject: "several",
    });
    const html = await page("/dashboard/emails");
    expect(html).toContain("&lt;b&gt;first&lt;/b&gt;@example.org");
    expect(html).toContain("+2");
    expect(html).not.toContain("<b>first</b>");
    expect(html).not.toContain("<img src=x");
  });

  test("the detail page shows every recipient, escaped", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({
      apiKeyId,
      toAddress: `${MARKUP_FIRST}, ${CAROL}, ${MARKUP_LAST}`,
      subject: "several",
    });
    const html = await page(`/dashboard/emails/${id}`);
    expect(html).toContain("&lt;b&gt;first&lt;/b&gt;@example.org");
    expect(html).toContain(CAROL);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;@example.net");
    expect(html).not.toContain("<img src=x");
  });
});
