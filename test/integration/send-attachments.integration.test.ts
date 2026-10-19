/**
 * Attachments on the send API and SMTP submission (#181) against a real
 * Postgres.
 *
 * - A REST send stores its files in `email_attachments`, in the email's
 *   transaction; the queue hands them to the mailer (the test seam), and
 *   the message Nodemailer renders from that call carries them with their
 *   derived types, the inline `cid`, and a DKIM signature that verifies.
 * - Every refusal (count, size, base64, blocked extension, a PE file
 *   posing as a PDF) is a 422 with nothing stored.
 * - The bytes are dropped when the email reaches a final state (sent,
 *   failed, bounced), not before; the metadata stays and the API answers
 *   `available: false`. The trash purge removes the rows and the
 *   tombstone keeps the metadata only. An idempotent replay returns the
 *   stored metadata, and the snapshot never holds the bytes.
 * - SMTP submission relays attachments under the same rules (550/552).
 * - The metadata query never reads `content` (EXPLAIN VERBOSE).
 *
 * The REST app mirrors the VALIDATION, attachment and
 * `EmailSendRejectedError` branches of the global `onError` in
 * `src/index.ts`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { Elysia, ValidationError } from "elysia";
import { eq, sql, type SQL } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { simpleParser } from "mailparser";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import {
  AttachmentTypeNotAllowedError,
  EmailSendRejectedError,
  InvalidAttachmentError,
} from "../../src/modules/emails/errors.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import {
  buildMailOptions,
  type sendMail,
} from "../../src/modules/emails/services/mailer.service.ts";
import { composeMessageBody } from "../../src/modules/emails/services/message-body.ts";
import { attachmentMetaQuery } from "../../src/modules/emails/services/attachment-storage.ts";
import { emailAttachments } from "../../src/modules/emails/models/email-attachment.schema.ts";
import { emailTombstones } from "../../src/modules/emails/models/email-tombstone.schema.ts";
import { idempotencyKeys } from "../../src/modules/emails/models/idempotency-key.schema.ts";
import { apiKeys } from "../../src/modules/api-keys/models/api-key.schema.ts";
import { runTrashPurge } from "../../src/modules/trash/services/purge.service.ts";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import type { DeliveryGroup } from "../../src/modules/emails/models/email.schema.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mirrors the VALIDATION, attachment and `EmailSendRejectedError` branches of the global onError. */
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
    if (error instanceof InvalidAttachmentError) {
      set.status = error.status;
      return {
        success: false,
        error: "Request validation failed",
        code: error.code,
        details: [{ path: error.path, message: error.message }],
      };
    }
    if (error instanceof AttachmentTypeNotAllowedError) {
      set.status = error.status;
      return {
        success: false,
        error: error.message,
        code: error.code,
        index: error.index,
      };
    }
    if (error instanceof EmailSendRejectedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(emailsPlugin);

interface SerializedAttachmentBody {
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  available: boolean;
}

interface SendBody {
  success: boolean;
  data?: { id: string; attachments: SerializedAttachmentBody[] };
  error?: string;
  code?: string;
  index?: number;
  details?: { path: string; message: string }[];
}

/** The sending domain, registered with a real DKIM key. */
const DOMAIN = "attach.example.com";
const FROM = `hello@${DOMAIN}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
/** The start of a PDF. */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
/** A Windows PE header. */
const PE = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(60)]);

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A PDF and an inline PNG, as a REST body carries them (declared types wrong on purpose). */
const PDF_AND_PNG = [
  { filename: "invoice.pdf", content: b64(PDF), contentType: "text/plain" },
  {
    filename: "logo.png",
    content: b64(PNG),
    contentType: "application/octet-stream",
    contentId: "logo@attach.example.com",
  },
];

/** POSTs a send as the calling key. */
async function send(
  key: string,
  extra: Record<string, unknown>,
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
        from: FROM,
        to: "user@example.org",
        subject: "with files",
        html: '<p>Hi</p><img src="cid:logo@attach.example.com">',
        ...extra,
      }),
    }),
  );
  return {
    status: res.status,
    body: await readJson<SendBody>(res),
    replayed: res.headers.get("idempotent-replayed"),
  };
}

/** GETs one email as the calling key. */
async function getEmail(key: string, id: string): Promise<SendBody> {
  const res = await app.handle(
    new Request(`http://localhost/api/v1/emails/${id}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
  );
  return readJson<SendBody>(res);
}

async function count(table: typeof emails | typeof emailAttachments): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row?.n ?? 0;
}

/** Each attachment row's position and whether its bytes are still stored. */
async function storedBytes(
  emailId: string,
): Promise<{ position: number; stored: boolean }[]> {
  return db
    .select({
      position: emailAttachments.position,
      stored: sql<boolean>`${emailAttachments.content} IS NOT NULL`,
    })
    .from(emailAttachments)
    .where(eq(emailAttachments.emailId, emailId))
    .orderBy(emailAttachments.position);
}

type MailerCall = Parameters<typeof sendMail>[0];

/** How the recording mailer reports the attempt. */
type Outcome = "sent" | "retry" | "hard" | "policy";

/** The delivery group the recording mailer returns for `outcome`. */
function groupFor(outcome: Outcome): DeliveryGroup {
  const base = { recipients: ["user@example.org"], attempts: 1, domain: "example.org" };
  switch (outcome) {
    case "sent":
      return { ...base, status: "sent", deliveredAt: new Date().toISOString() };
    case "retry":
      return {
        ...base,
        status: "retry",
        lastError: "421 4.7.0 try later",
        failureKind: "soft",
        failureCode: "4.7.0",
      };
    case "hard":
      return {
        ...base,
        status: "failed",
        lastError: "550 5.1.1 no such user",
        failureKind: "hard",
        failureCode: "5.1.1",
      };
    case "policy":
      return {
        ...base,
        status: "failed",
        lastError: "550 5.7.1 blocked",
        failureKind: "policy",
        failureCode: "5.7.1",
        blocked: true,
      };
  }
}

/** Runs one queue cycle with a mailer that records its calls and reports `outcome`. */
async function runQueue(outcome: Outcome = "sent"): Promise<MailerCall[]> {
  const calls: MailerCall[] = [];
  const mailer: typeof sendMail = async (options) => {
    calls.push(options);
    return {
      messageId: options.messageId,
      deliveryState: { "example.org": groupFor(outcome) },
    };
  };
  await runQueueCycle({ sendMail: mailer });
  return calls;
}

/** Renders the message `sendMail` would send for a recorded call, DKIM signed. */
async function render(call: MailerCall): Promise<Buffer> {
  const body = composeMessageBody(call.html ?? null, call.text ?? null);
  const options = buildMailOptions({
    recipients: [call.to],
    from: call.from,
    headerTo: call.to,
    headerCc: call.cc ?? null,
    replyTo: call.replyTo ?? null,
    subject: call.subject,
    html: body.html,
    text: body.text,
    messageId: call.messageId,
    headers: call.headers ?? {},
    attachments: call.attachments,
    dkim: call.dkim,
    category: call.category ?? null,
  });
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail(options);
  if (!Buffer.isBuffer(info.message)) throw new Error("expected a buffered message");
  return info.message;
}

/** The one recorded mailer call, or a failure. */
function only(calls: MailerCall[]): MailerCall {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error("expected one mailer call");
  return call;
}

/** The DKIM public key as a TXT record value. */
const DKIM_TXT = `v=DKIM1; k=rsa; p=${publicKey
  .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
  .replace(/\s+/g, "")}`;

/** A resolver that only knows the test domain's DKIM key. */
async function dkimResolver(name: string, type: string): Promise<string[][]> {
  if (type === "TXT" && name === `bunmail._domainkey.${DOMAIN}`) return [[DKIM_TXT]];
  throw Object.assign(new Error(`no ${type} for ${name}`), { code: "ENOTFOUND" });
}

let apiKeyId = "";
let rawKey = "";

beforeEach(async () => {
  await truncateAll();
  ({ id: apiKeyId, rawKey } = await seed.apiKey());
  await seed.domain({ name: DOMAIN, privateKeyPem: privateKey, publicKeyPem: publicKey });
});

describe("REST send with attachments", () => {
  test("a PDF and an inline PNG are stored, sent with derived types and a valid DKIM signature", async () => {
    const { status, body } = await send(rawKey, { attachments: PDF_AND_PNG });
    expect(status).toBe(200);
    const id = body.data!.id;
    /** The declared types are ignored: the bytes decide. */
    expect(body.data!.attachments).toEqual([
      {
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: PDF.byteLength,
        contentId: null,
        available: true,
      },
      {
        filename: "logo.png",
        contentType: "image/png",
        size: PNG.byteLength,
        contentId: "logo@attach.example.com",
        available: true,
      },
    ]);

    /** Two rows with the raw bytes, in order. */
    const rows = await db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.emailId, id))
      .orderBy(emailAttachments.position);
    expect(rows).toHaveLength(2);
    expect(Buffer.from(rows[0]!.content ?? []).equals(PDF)).toBe(true);
    expect(Buffer.from(rows[1]!.content ?? []).equals(PNG)).toBe(true);
    expect(rows[0]!.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(PDF).digest("hex"),
    );

    const call = only(await runQueue("sent"));
    expect(call.attachments).toHaveLength(2);
    expect(call.attachments?.[0]).toMatchObject({
      filename: "invoice.pdf",
      contentType: "application/pdf",
      contentId: null,
    });
    expect(call.attachments?.[1]).toMatchObject({
      filename: "logo.png",
      contentType: "image/png",
      contentId: "logo@attach.example.com",
    });
    expect(call.dkim?.domainName).toBe(DOMAIN);

    const raw = await render(call);
    const parsed = await simpleParser(raw, { keepCidLinks: true });
    expect(parsed.attachments).toHaveLength(2);
    /** Nodemailer puts the inline part beside the HTML, before the attached one. */
    const pdf = parsed.attachments.find((a) => a.filename === "invoice.pdf");
    const png = parsed.attachments.find((a) => a.filename === "logo.png");
    expect(pdf).toMatchObject({
      filename: "invoice.pdf",
      contentType: "application/pdf",
      contentDisposition: "attachment",
    });
    expect(pdf?.content.equals(PDF)).toBe(true);
    expect(png).toMatchObject({
      filename: "logo.png",
      contentType: "image/png",
      cid: "logo@attach.example.com",
      related: true,
    });
    expect(png?.content.equals(PNG)).toBe(true);
    /** The HTML's cid: reference is sent as it was. */
    expect(String(parsed.html)).toContain('src="cid:logo@attach.example.com"');

    const verified = await dkimVerify(raw, { resolver: dkimResolver });
    expect(verified.results[0]?.status.result).toBe("pass");
    expect(verified.results[0]?.signingDomain).toBe(DOMAIN);
  });

  test("a template send takes attachments too", async () => {
    const { id: templateId } = await seed.template({ apiKeyId });
    const { status, body } = await send(rawKey, {
      subject: undefined,
      html: undefined,
      templateId,
      variables: { name: "Ann" },
      attachments: [PDF_AND_PNG[0]],
    });
    expect(status).toBe(200);
    expect(body.data!.attachments).toHaveLength(1);
    expect(await count(emailAttachments)).toBe(1);
  });

  test("a send without attachments answers an empty list", async () => {
    const { body } = await send(rawKey, {});
    expect(body.data!.attachments).toEqual([]);
    expect(await count(emailAttachments)).toBe(0);
  });
});

describe("refused sends store nothing", () => {
  test("more than 10 attachments: 422 TOO_MANY_ATTACHMENTS", async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({
      filename: `f${i}.txt`,
      content: b64(Buffer.from("x")),
    }));
    const { status, body } = await send(rawKey, { attachments: files });
    expect(status).toBe(422);
    expect(body.code).toBe("TOO_MANY_ATTACHMENTS");
    expect(await count(emails)).toBe(0);
    expect(await count(emailAttachments)).toBe(0);
  });

  test("over ATTACHMENTS_MAX_TOTAL_MB: 422 ATTACHMENTS_TOO_LARGE", async () => {
    const big = Buffer.alloc(3_000_000, 1);
    const { status, body } = await send(rawKey, {
      attachments: [
        { filename: "a.txt", content: b64(big) },
        { filename: "b.txt", content: b64(big) },
      ],
    });
    expect(status).toBe(422);
    expect(body.code).toBe("ATTACHMENTS_TOO_LARGE");
    expect(await count(emails)).toBe(0);
    expect(await count(emailAttachments)).toBe(0);
  });

  test("invalid base64: 422 VALIDATION_ERROR at the content", async () => {
    const { status, body } = await send(rawKey, {
      attachments: [{ filename: "a.txt", content: "aGVsbG8" }],
    });
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details?.[0]?.path).toBe("/attachments/0/content");
    expect(await count(emails)).toBe(0);
    expect(await count(emailAttachments)).toBe(0);
  });

  test("a blocked extension: 422 ATTACHMENT_TYPE_NOT_ALLOWED naming the index", async () => {
    const { status, body } = await send(rawKey, {
      attachments: [PDF_AND_PNG[0], { filename: "Invoice.PDF.exe", content: b64(PDF) }],
    });
    expect(status).toBe(422);
    expect(body.code).toBe("ATTACHMENT_TYPE_NOT_ALLOWED");
    expect(body.index).toBe(1);
    expect(body.error).not.toContain("Invoice");
    expect(await count(emails)).toBe(0);
    expect(await count(emailAttachments)).toBe(0);
  });

  test("a PE executable named invoice.pdf and declared application/pdf: refused by its content", async () => {
    const { status, body } = await send(rawKey, {
      attachments: [
        { filename: "invoice.pdf", content: b64(PE), contentType: "application/pdf" },
      ],
    });
    expect(status).toBe(422);
    expect(body.code).toBe("ATTACHMENT_TYPE_NOT_ALLOWED");
    expect(body.index).toBe(0);
    expect(await count(emails)).toBe(0);
    expect(await count(emailAttachments)).toBe(0);
  });

  test("a bad filename: 422 VALIDATION_ERROR, never echoing it", async () => {
    const { status, body } = await send(rawKey, {
      attachments: [{ filename: "../secret-name.pdf", content: b64(PDF) }],
    });
    expect(status).toBe(422);
    expect(body.details?.[0]?.path).toBe("/attachments/0/filename");
    expect(JSON.stringify(body)).not.toContain("secret-name");
    expect(await count(emails)).toBe(0);
  });
});

describe("retention: bytes dropped at the final state", () => {
  test("sent: content is NULL, metadata stays, the API answers available: false", async () => {
    const { body } = await send(rawKey, { attachments: PDF_AND_PNG });
    const id = body.data!.id;
    await runQueue("sent");

    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.status).toBe("sent");
    expect(await storedBytes(id)).toEqual([
      { position: 0, stored: false },
      { position: 1, stored: false },
    ]);
    const got = await getEmail(rawKey, id);
    expect(got.data!.attachments.map((a) => [a.filename, a.size, a.available])).toEqual([
      ["invoice.pdf", PDF.byteLength, false],
      ["logo.png", PNG.byteLength, false],
    ]);
  });

  test("a temporary failure keeps the bytes for the retry, which sends them again", async () => {
    const { body } = await send(rawKey, { attachments: PDF_AND_PNG });
    const id = body.data!.id;
    const first = only(await runQueue("retry"));
    expect(first.attachments).toHaveLength(2);
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.status).toBe("queued");
    expect((await storedBytes(id)).every((r) => r.stored)).toBe(true);

    /** Make the retry due now and run it: the same files go out. */
    await db
      .update(emails)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(emails.id, id));
    const retry = only(await runQueue("sent"));
    expect(retry.attachments?.map((a) => Buffer.from(a.content))).toEqual([PDF, PNG]);
    expect((await storedBytes(id)).some((r) => r.stored)).toBe(false);
  });

  test("bounced (hard 5xx): bytes dropped", async () => {
    const { body } = await send(rawKey, { attachments: PDF_AND_PNG });
    const id = body.data!.id;
    await runQueue("hard");
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.status).toBe("bounced");
    expect((await storedBytes(id)).some((r) => r.stored)).toBe(false);
  });

  test("failed (policy block): bytes dropped", async () => {
    const { body } = await send(rawKey, { attachments: PDF_AND_PNG });
    const id = body.data!.id;
    await runQueue("policy");
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.status).toBe("failed");
    expect((await storedBytes(id)).some((r) => r.stored)).toBe(false);
  });

  test("failed because the key was revoked: bytes dropped, nothing sent", async () => {
    const { body } = await send(rawKey, { attachments: PDF_AND_PNG });
    const id = body.data!.id;
    await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, apiKeyId));
    expect(await runQueue("sent")).toHaveLength(0);
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.status).toBe("failed");
    expect((await storedBytes(id)).some((r) => r.stored)).toBe(false);
  });

  test("an attachment that lost its bytes fails the email instead of sending without it", async () => {
    const { body } = await send(rawKey, { attachments: PDF_AND_PNG });
    const id = body.data!.id;
    await db
      .update(emailAttachments)
      .set({ content: null })
      .where(eq(emailAttachments.position, 1));
    expect(await runQueue("sent")).toHaveLength(0);
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("Attachment 1 is no longer stored");
  });

  test("the trash purge removes the rows; the tombstone keeps the metadata only", async () => {
    const { body } = await send(rawKey, { attachments: PDF_AND_PNG });
    const id = body.data!.id;
    await db
      .update(emails)
      .set({ deletedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) })
      .where(eq(emails.id, id));

    const { emailsPurged } = await runTrashPurge();
    expect(emailsPurged).toBe(1);
    expect(await count(emailAttachments)).toBe(0);
    const [tombstone] = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.id, id));
    expect(tombstone?.attachments).toEqual([
      { filename: "invoice.pdf", contentType: "application/pdf", size: PDF.byteLength },
      { filename: "logo.png", contentType: "image/png", size: PNG.byteLength },
    ]);
  });
});

describe("idempotent replay", () => {
  test("returns the stored metadata; the snapshot never holds the bytes", async () => {
    const headers = { "idempotency-key": "attach-replay-1" };
    const first = await send(rawKey, { attachments: PDF_AND_PNG }, headers);
    expect(first.status).toBe(200);
    const replay = await send(rawKey, { attachments: PDF_AND_PNG }, headers);
    expect(replay.status).toBe(200);
    expect(replay.replayed).toBe("true");
    expect(replay.body.data!.id).toBe(first.body.data!.id);
    expect(replay.body.data!.attachments).toEqual(first.body.data!.attachments);
    expect(await count(emails)).toBe(1);
    expect(await count(emailAttachments)).toBe(2);

    const [stored] = await db.select().from(idempotencyKeys);
    const snapshot = JSON.stringify(stored?.responseBody);
    expect(snapshot).toContain("invoice.pdf");
    expect(snapshot).not.toContain(b64(PDF));
    expect(snapshot).not.toContain(b64(PNG));
    expect(snapshot).not.toContain('"content"');
  });
});

describe("attachment metadata reads never load the bytes", () => {
  /** Every `Output` list of an EXPLAIN (VERBOSE, FORMAT JSON) plan. */
  async function planOutputs(query: SQL): Promise<string[]> {
    const result = await db.execute(sql`EXPLAIN (VERBOSE, FORMAT JSON) ${query}`);
    const rows: unknown[] = [...result];
    const first = rows[0];
    const cell: unknown =
      typeof first === "object" && first !== null ? Object.values(first)[0] : undefined;
    const plan: unknown = typeof cell === "string" ? JSON.parse(cell) : cell;
    const outputs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "Output" && Array.isArray(value)) {
          outputs.push(...value.filter((v): v is string => typeof v === "string"));
        } else walk(value);
      }
    };
    walk(plan);
    return outputs;
  }

  test("the metadata query reads content only as IS NOT NULL", async () => {
    const { body } = await send(rawKey, { attachments: PDF_AND_PNG });
    const outputs = await planOutputs(attachmentMetaQuery(db, [body.data!.id]).getSQL());
    expect(outputs.length).toBeGreaterThan(0);
    const mentions = outputs.filter((o) => /\bcontent\b/.test(o));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/^\((email_attachments\.)?content IS NOT NULL\)$/);
  });

  test("the email list reads only the emails table", async () => {
    await send(rawKey, { attachments: PDF_AND_PNG });
    const outputs = await planOutputs(
      db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId)).getSQL(),
    );
    expect(outputs.some((o) => o.includes("email_attachments"))).toBe(false);
    const res = await app.handle(
      new Request("http://localhost/api/v1/emails", {
        headers: { authorization: `Bearer ${rawKey}` },
      }),
    );
    const list = await readJson<{ data: { attachments: SerializedAttachmentBody[] }[] }>(
      res,
    );
    expect(list.data[0]?.attachments.map((a) => a.filename)).toEqual([
      "invoice.pdf",
      "logo.png",
    ]);
    expect(JSON.stringify(list)).not.toContain(b64(PNG));
  });
});

describe("SMTP submission with attachments", () => {
  const PORT = 12589;

  /** A transport to the test submission server. */
  function transport(pass: string) {
    return createTransport({
      host: "127.0.0.1",
      port: PORT,
      secure: false,
      ignoreTLS: true,
      auth: { user: "apikey", pass },
    });
  }

  /** Awaits a send that must fail and returns its error message. */
  async function failureOf(sending: Promise<unknown>): Promise<string> {
    try {
      await sending;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the submission to be rejected");
  }

  beforeAll(() => {
    smtpSubmission.start(PORT);
  });

  afterAll(() => {
    smtpSubmission.stop();
  });

  test("a PDF and an inline image are relayed, the cid kept", async () => {
    await transport(rawKey).sendMail({
      from: FROM,
      to: "user@example.org",
      subject: "via smtp",
      html: '<p>Hi</p><img src="cid:logo@attach.example.com">',
      attachments: [
        {
          filename: "invoice.pdf",
          content: PDF,
          contentType: "application/octet-stream",
        },
        { filename: "logo.png", content: PNG, cid: "logo@attach.example.com" },
      ],
    });
    const [row] = await db.select().from(emails);
    expect(row?.source).toBe("smtp");
    expect(row?.html).toContain('src="cid:logo@attach.example.com"');
    /** In MIME order: the inline part sits beside the HTML, before the attached one. */
    const files = await db
      .select()
      .from(emailAttachments)
      .orderBy(emailAttachments.filename);
    expect(files.map((f) => [f.filename, f.contentType, f.contentId])).toEqual([
      ["invoice.pdf", "application/pdf", null],
      ["logo.png", "image/png", "logo@attach.example.com"],
    ]);
    expect(Buffer.from(files[0]!.content ?? []).equals(PDF)).toBe(true);
    expect(Buffer.from(files[1]!.content ?? []).equals(PNG)).toBe(true);
  });

  test("a blocked type is refused with 550, nothing queued", async () => {
    const reply = await failureOf(
      transport(rawKey).sendMail({
        from: FROM,
        to: "user@example.org",
        subject: "exe",
        text: "see attached",
        attachments: [{ filename: "report.pdf", content: PE }],
      }),
    );
    expect(reply).toContain("550");
    expect(reply).toContain("not allowed");
    expect(await count(emails)).toBe(0);
    expect(await count(emailAttachments)).toBe(0);
  });

  test("attachments over the budget are refused with 552", async () => {
    const reply = await failureOf(
      transport(rawKey).sendMail({
        from: FROM,
        to: "user@example.org",
        subject: "big",
        text: "see attached",
        attachments: [{ filename: "big.txt", content: Buffer.alloc(5_100_000, 1) }],
      }),
    );
    expect(reply).toContain("552");
    expect(await count(emails)).toBe(0);
  });
});
