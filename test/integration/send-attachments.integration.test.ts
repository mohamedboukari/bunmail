/**
 * REST sends with `attachments` (#250) against a real Postgres.
 *
 * Attachments are not supported, and the send body ignores unknown
 * fields, so a send carrying them used to be queued without them. Now a
 * body with an `attachments` property, whatever its value, is refused with
 * `422 ATTACHMENTS_NOT_SUPPORTED` and nothing is queued; any other unknown
 * field is still ignored.
 *
 * The REST app mirrors the VALIDATION and `EmailSendRejectedError`
 * branches of the global `onError` in `src/index.ts`.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia, ValidationError } from "elysia";
import { sql } from "drizzle-orm";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { EmailSendRejectedError } from "../../src/modules/emails/errors.ts";
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
  data?: { id: string };
  code?: string;
}

/** POSTs a send with `extra` merged into a valid body, as the calling key. */
async function send(
  key: string,
  extra: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: SendBody }> {
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
        text: "x",
        ...extra,
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

beforeEach(async () => {
  await truncateAll();
});

describe("REST send with attachments (#250)", () => {
  test("attachments: refused with 422 ATTACHMENTS_NOT_SUPPORTED, nothing queued", async () => {
    const { rawKey } = await seed.apiKey();

    const { status, body } = await send(rawKey, {
      attachments: [{ filename: "a.pdf", content: "aGVsbG8=" }],
    });

    expect(status).toBe(422);
    expect(body.code).toBe("ATTACHMENTS_NOT_SUPPORTED");
    expect(await emailCount()).toBe(0);
  });

  test("an empty attachments array is refused too", async () => {
    const { rawKey } = await seed.apiKey();

    const { status, body } = await send(rawKey, { attachments: [] });

    expect(status).toBe(422);
    expect(body.code).toBe("ATTACHMENTS_NOT_SUPPORTED");
    expect(await emailCount()).toBe(0);
  });

  test("any value is refused, null included", async () => {
    const { rawKey } = await seed.apiKey();

    for (const attachments of [null, "a.pdf", {}]) {
      const { status, body } = await send(rawKey, { attachments });
      expect(status).toBe(422);
      expect(body.code).toBe("ATTACHMENTS_NOT_SUPPORTED");
    }
    expect(await emailCount()).toBe(0);
  });

  test("a template send with attachments is refused", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const { id: templateId } = await seed.template({ apiKeyId });

    const { status, body } = await send(rawKey, {
      subject: undefined,
      text: undefined,
      templateId,
      attachments: [],
    });

    expect(status).toBe(422);
    expect(body.code).toBe("ATTACHMENTS_NOT_SUPPORTED");
    expect(await emailCount()).toBe(0);
  });

  test("with an Idempotency-Key: refused, and the key stays unused", async () => {
    const { rawKey } = await seed.apiKey();
    const key = { "idempotency-key": "attach-1" };

    const refused = await send(rawKey, { attachments: [] }, key);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("ATTACHMENTS_NOT_SUPPORTED");

    /** The key was not claimed: the same key with a valid body sends. */
    const sent = await send(rawKey, {}, key);
    expect(sent.status).toBe(200);
    expect(await emailCount()).toBe(1);
  });

  test("another unknown field is still ignored and the email is queued", async () => {
    const { rawKey } = await seed.apiKey();

    const { status, body } = await send(rawKey, { trackOpens: true });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(await emailCount()).toBe(1);
  });
});
