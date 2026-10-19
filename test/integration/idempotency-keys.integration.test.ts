/**
 * Idempotency keys on the send API (#188) against a real Postgres.
 *
 * Covers the whole path of `POST /api/v1/emails/send` with an
 * `Idempotency-Key` header: a retry replays the first response (same
 * email, same body, `Idempotent-Replayed: true`) and queues nothing new,
 * another body under the same key is refused, key order in the JSON does
 * not matter, keys are scoped to the API key, parallel duplicates create
 * exactly one email without a 500, a refused send stores nothing, an
 * expired key is reusable, the purge deletes only expired rows, invalid
 * header values are a 422, and a purged email still replays.
 *
 * The REST app mirrors the VALIDATION, suppression and
 * `EmailSendRejectedError` branches of the global `onError` in
 * `src/index.ts`.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia, ValidationError } from "elysia";
import { eq, sql } from "drizzle-orm";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { EmailSendRejectedError } from "../../src/modules/emails/errors.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import { idempotencyKeys } from "../../src/modules/emails/models/idempotency-key.schema.ts";
import { runIdempotencyKeySweep } from "../../src/modules/trash/services/purge.service.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, emails, suppressions } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mirrors the VALIDATION, suppression and send-rejection branches of the global onError. */
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
    if (error instanceof SuppressedRecipientError) {
      set.status = 422;
      return { success: false, error: error.message, code: "RECIPIENT_SUPPRESSED" };
    }
    if (error instanceof EmailSendRejectedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(emailsPlugin);

interface SendBody {
  success: boolean;
  data?: { id: string; status: string; createdAt: string };
  warnings?: string[];
  error?: string;
  code?: string;
  details?: { path: string }[];
}

interface SendResult {
  status: number;
  replayed: string | null;
  /** The raw response text. */
  text: string;
  body: SendBody;
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

/** POSTs a send as `rawKey`, with `idempotencyKey` when given, and `body` as JSON text. */
async function send(
  rawKey: string,
  idempotencyKey: string | null,
  body: string | Record<string, unknown> = sendBody(),
): Promise<SendResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${rawKey}`,
    "content-type": "application/json",
  };
  if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
  const res = await app.handle(
    new Request("http://localhost/api/v1/emails/send", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    replayed: res.headers.get("idempotent-replayed"),
    text,
    body: await readJson<SendBody>(new Response(text)),
  };
}

/** Number of emails rows, and of those still queued. */
async function emailCounts(): Promise<{ total: number; queued: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      queued: sql<number>`count(*) filter (where status = 'queued')::int`,
    })
    .from(emails);
  return { total: row?.total ?? 0, queued: row?.queued ?? 0 };
}

/** Number of idempotency_keys rows. */
async function keyCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(idempotencyKeys);
  return row?.n ?? 0;
}

/** Moves every stored key of `apiKeyId` into the past, as if its TTL ran out. */
async function expireKeys(apiKeyId: string): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(idempotencyKeys.apiKeyId, apiKeyId));
}

beforeEach(async () => {
  await truncateAll();
});

describe("a retry with the same key", () => {
  test("replays the first response and queues one email", async () => {
    const { rawKey } = await seed.apiKey();

    const first = await send(rawKey, "order-1042-shipped");
    expect(first.status).toBe(200);
    expect(first.replayed).toBeNull();
    expect(first.body.data!.status).toBe("queued");

    const retry = await send(rawKey, "order-1042-shipped");
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe("true");
    expect(retry.body.data!.id).toBe(first.body.data!.id);
    /** The same JSON, warnings and timestamps included (jsonb may reorder members). */
    expect(retry.body).toEqual(first.body);

    expect(await emailCounts()).toEqual({ total: 1, queued: 1 });
    expect(await keyCount()).toBe(1);
  });

  test("stores the email, the response and an expiry of the TTL", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const first = await send(rawKey, "k-1");

    const [row] = await db
      .select({
        emailId: idempotencyKeys.emailId,
        responseStatus: idempotencyKeys.responseStatus,
        bodyType: sql<string>`jsonb_typeof(response_body)`,
        ttlSeconds: sql<number>`extract(epoch from expires_at - created_at)::int`,
      })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.apiKeyId, apiKeyId));
    expect(row!.emailId).toBe(first.body.data!.id);
    expect(row!.responseStatus).toBe(200);
    /** A real jsonb object, not a double-encoded string (#261). */
    expect(row!.bodyType).toBe("object");
    expect(row!.ttlSeconds).toBe(config.idempotency.keyTtlHours * 3600);
  });

  test("with the JSON keys in another order still replays", async () => {
    const { rawKey } = await seed.apiKey();
    const first = await send(
      rawKey,
      "reordered",
      sendBody({ headers: { "X-A": "1", "X-B": "2" } }),
    );
    expect(first.status).toBe(200);

    const reordered = `{"headers":{"X-B":"2","X-A":"1"},"text":"Your order is on its way.","subject":"Order shipped","to":"user@example.org","from":"hello@unregistered.test"}`;
    const retry = await send(rawKey, "reordered", reordered);
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe("true");
    expect(retry.body.data!.id).toBe(first.body.data!.id);
    expect((await emailCounts()).total).toBe(1);
  });

  test("with another body is refused and creates nothing", async () => {
    const { rawKey } = await seed.apiKey();
    const first = await send(rawKey, "same-key");
    expect(first.status).toBe(200);

    const other = await send(
      rawKey,
      "same-key",
      sendBody({ subject: "Order cancelled" }),
    );
    expect(other.status).toBe(422);
    expect(other.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(other.replayed).toBeNull();
    /** The message never echoes the key. */
    expect(other.text).not.toContain("same-key");

    expect(await emailCounts()).toEqual({ total: 1, queued: 1 });
    expect(await keyCount()).toBe(1);
  });

  test("still replays the snapshot after the email was purged", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const first = await send(rawKey, "purged-later");
    await db.delete(emails).where(eq(emails.id, first.body.data!.id));

    const [row] = await db
      .select({ emailId: idempotencyKeys.emailId })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.apiKeyId, apiKeyId));
    expect(row!.emailId).toBeNull();

    const retry = await send(rawKey, "purged-later");
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe("true");
    expect(retry.body).toEqual(first.body);
    expect((await emailCounts()).total).toBe(0);
  });
});

describe("scoping", () => {
  test("two API keys with the same idempotency key are independent", async () => {
    const a = await seed.apiKey({ name: "a" });
    const b = await seed.apiKey({ name: "b" });

    const fromA = await send(a.rawKey, "shared-key");
    const fromB = await send(b.rawKey, "shared-key", sendBody({ subject: "Other" }));
    expect(fromA.status).toBe(200);
    expect(fromB.status).toBe(200);
    expect(fromB.replayed).toBeNull();
    expect(fromB.body.data!.id).not.toBe(fromA.body.data!.id);

    expect((await emailCounts()).total).toBe(2);
    expect(await keyCount()).toBe(2);
  });

  test("a send without the header is never deduplicated", async () => {
    const { rawKey } = await seed.apiKey();
    await send(rawKey, null);
    await send(rawKey, null);
    expect((await emailCounts()).total).toBe(2);
    expect(await keyCount()).toBe(0);
  });
});

describe("concurrent duplicates", () => {
  test("ten parallel sends with one key create exactly one email", async () => {
    const { rawKey } = await seed.apiKey();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => send(rawKey, "parallel-key")),
    );

    for (const r of results) expect(r.status).toBe(200);
    const ids = new Set(results.map((r) => r.body.data!.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.replayed === null)).toHaveLength(1);
    expect(results.filter((r) => r.replayed === "true")).toHaveLength(9);

    expect(await emailCounts()).toEqual({ total: 1, queued: 1 });
    expect(await keyCount()).toBe(1);
  });

  test("parallel sends on an expired key create exactly one new email", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const old = await send(rawKey, "expired-parallel");
    await expireKeys(apiKeyId);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => send(rawKey, "expired-parallel")),
    );

    for (const r of results) expect(r.status).toBe(200);
    const ids = new Set(results.map((r) => r.body.data!.id));
    expect(ids.size).toBe(1);
    expect(ids.has(old.body.data!.id)).toBe(false);
    expect(results.filter((r) => r.replayed === null)).toHaveLength(1);

    expect((await emailCounts()).total).toBe(2);
    expect(await keyCount()).toBe(1);
  });
});

describe("a refused send", () => {
  test("stores nothing, and a retry with the same key can succeed", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const { id: suppressionId } = await seed.suppression({
      apiKeyId,
      email: "user@example.org",
    });

    const refused = await send(rawKey, "after-fix");
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("RECIPIENT_SUPPRESSED");
    expect(await keyCount()).toBe(0);
    expect((await emailCounts()).total).toBe(0);

    await db.delete(suppressions).where(eq(suppressions.id, suppressionId));

    const retry = await send(rawKey, "after-fix");
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBeNull();
    expect((await emailCounts()).total).toBe(1);
  });

  test("a body that fails validation stores nothing", async () => {
    const { rawKey } = await seed.apiKey();
    const invalid = await send(rawKey, "bad-body", sendBody({ to: "not-an-address" }));
    expect(invalid.status).toBe(422);
    expect(await keyCount()).toBe(0);

    const valid = await send(rawKey, "bad-body");
    expect(valid.status).toBe(200);
    expect(valid.replayed).toBeNull();
  });
});

describe("expiry", () => {
  test("an expired key is reusable, with another body too", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const first = await send(rawKey, "daily-digest");
    await expireKeys(apiKeyId);

    const again = await send(rawKey, "daily-digest", sendBody({ subject: "Tomorrow" }));
    expect(again.status).toBe(200);
    expect(again.replayed).toBeNull();
    expect(again.body.data!.id).not.toBe(first.body.data!.id);

    /** The row was taken over: it now belongs to the new email, live again. */
    const [row] = await db
      .select({
        emailId: idempotencyKeys.emailId,
        live: sql<boolean>`expires_at > now()`,
      })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.apiKeyId, apiKeyId));
    expect(row!.emailId).toBe(again.body.data!.id);
    expect(row!.live).toBe(true);
    expect(await keyCount()).toBe(1);

    const retry = await send(rawKey, "daily-digest", sendBody({ subject: "Tomorrow" }));
    expect(retry.replayed).toBe("true");
    expect(retry.body.data!.id).toBe(again.body.data!.id);
  });

  test("the purge deletes only expired keys", async () => {
    const a = await seed.apiKey({ name: "a" });
    const b = await seed.apiKey({ name: "b" });
    await send(a.rawKey, "old");
    await send(b.rawKey, "fresh");
    await expireKeys(a.id);

    const { deleted } = await runIdempotencyKeySweep();
    expect(deleted).toBe(1);

    const rows = await db
      .select({ apiKeyId: idempotencyKeys.apiKeyId })
      .from(idempotencyKeys);
    expect(rows).toEqual([{ apiKeyId: b.id }]);
    /** The emails themselves are untouched. */
    expect((await emailCounts()).total).toBe(2);
  });
});

describe("header validation", () => {
  test.each([
    ["empty", ""],
    ["a space", "order 1042"],
    ["256 characters", "k".repeat(256)],
    ["a non-ASCII character", "clé"],
    ["a repeated header (joined with a comma and space)", "a, b"],
  ])("refuses %s with 422 naming the header", async (_label, value) => {
    const { rawKey } = await seed.apiKey();
    const res = await send(rawKey, value);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details!.map((d) => d.path)).toContain("/idempotency-key");
    expect((await emailCounts()).total).toBe(0);
    expect(await keyCount()).toBe(0);
  });

  test("accepts 255 printable ASCII characters", async () => {
    const { rawKey } = await seed.apiKey();
    const res = await send(rawKey, `${"~!".repeat(127)}Z`);
    expect(res.status).toBe(200);
    expect(await keyCount()).toBe(1);
  });
});
