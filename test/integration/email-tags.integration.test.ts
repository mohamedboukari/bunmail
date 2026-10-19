/**
 * Tags on emails (#189) against a real Postgres:
 *
 * - `POST /api/v1/emails/send` stores `tags` as a jsonb object and
 *   returns them; a template send keeps them; an invalid tag is
 *   `422 VALIDATION_ERROR` naming the key, never the value, and nothing
 *   is queued; an idempotent replay keeps them;
 * - `GET /api/v1/emails?tag=key:value` filters, every tag must match,
 *   a value may contain `:` and `,`, another key's emails never show, it
 *   composes with status and pagination, and the GIN index serves it;
 * - SMTP submission stores `X-BunMail-Tag` headers as tags, never relays
 *   them, and refuses an invalid one with 550;
 * - the `email.sent` webhook delivery carries the tags;
 * - the dashboard list filters by a tag and the detail page escapes one;
 * - no log line carries a tag value.
 *
 * The REST app mirrors the VALIDATION, `InvalidTagError` and
 * `EmailSendRejectedError` branches of the global `onError` in
 * `src/index.ts`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import { Elysia, ValidationError } from "elysia";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import {
  EmailSendRejectedError,
  InvalidTagError,
} from "../../src/modules/emails/errors.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mirrors the validation branches of the global onError. */
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
    if (error instanceof InvalidTagError) {
      set.status = error.status;
      return {
        success: false,
        error: "Request validation failed",
        code: error.code,
        details: [{ path: error.path, message: error.message }],
      };
    }
    if (error instanceof EmailSendRejectedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(emailsPlugin);

const dashboard = new Elysia().wrap(withRequestContext).use(pagesPlugin);

interface SerializedRow {
  id: string;
  status: string;
  tags: Record<string, string> | null;
}

interface ApiBody {
  success: boolean;
  data?: SerializedRow | SerializedRow[];
  pagination?: { page: number; limit: number; total: number };
  error?: string;
  code?: string;
  details?: { path: string; message: string }[];
}

/** POSTs a send as `rawKey` with the extra body fields. */
async function send(
  rawKey: string,
  extra: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ status: number; body: ApiBody; replayed: string | null }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${rawKey}`,
    "content-type": "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await app.handle(
    new Request("http://localhost/api/v1/emails/send", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "s",
        text: "x",
        ...extra,
      }),
    }),
  );
  return {
    status: res.status,
    body: await readJson<ApiBody>(res),
    replayed: res.headers.get("idempotent-replayed"),
  };
}

/** GETs the list as `rawKey` with a raw query string. */
async function list(
  rawKey: string,
  query: string,
): Promise<{ status: number; body: ApiBody }> {
  const res = await app.handle(
    new Request(`http://localhost/api/v1/emails${query}`, {
      headers: { authorization: `Bearer ${rawKey}` },
    }),
  );
  return { status: res.status, body: await readJson<ApiBody>(res) };
}

/** The email of a send response. */
function rowOf(body: ApiBody): SerializedRow {
  if (!body.data || Array.isArray(body.data)) throw new Error("expected one email");
  return body.data;
}

/** The ids of a list response, sorted. */
function idsOf(body: ApiBody): string[] {
  const data = Array.isArray(body.data) ? body.data : [];
  return data.map((row) => row.id).toSorted();
}

/** `?tag=` for each `key:value`, URL-encoded. */
function tagQuery(...tags: string[]): string {
  const params = new URLSearchParams();
  for (const tag of tags) params.append("tag", tag);
  return `?${params.toString()}`;
}

/** Number of emails rows. */
async function emailCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(emails);
  return row?.n ?? 0;
}

/** A mailer that accepts every send and records the options it got. */
function recordingMailer(calls: Parameters<typeof sendMail>[0][]): typeof sendMail {
  return async (options) => {
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
}

/** Every log line written while `work` runs, as JSON. */
async function captureLogs(work: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string, data?: Record<string, unknown>): void => {
      lines.push(JSON.stringify({ level, message, data }));
    };
  const spies = [
    spyOn(logger, "debug").mockImplementation(record("debug")),
    spyOn(logger, "info").mockImplementation(record("info")),
    spyOn(logger, "warn").mockImplementation(record("warn")),
    spyOn(logger, "error").mockImplementation(record("error")),
  ];
  try {
    await work();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines.join("\n");
}

beforeEach(async () => {
  await truncateAll();
});

describe("REST send with tags", () => {
  test("stores them as a jsonb object and returns them", async () => {
    const { rawKey } = await seed.apiKey();
    const tags = { flow: "password-reset", tenant: "t:42" };
    const { status, body } = await send(rawKey, { tags });
    expect(status).toBe(200);
    const data = rowOf(body);
    expect(data.tags).toEqual(tags);

    const [row] = await db
      .select({ tags: emails.tags, type: sql<string>`jsonb_typeof(tags)` })
      .from(emails)
      .where(eq(emails.id, data.id));
    expect(row!.type).toBe("object");
    expect(row!.tags).toEqual(tags);
  });

  test("values are trimmed; no tags or {} is null", async () => {
    const { rawKey } = await seed.apiKey();
    const trimmed = await send(rawKey, { tags: { flow: "  reset  " } });
    expect(rowOf(trimmed.body).tags).toEqual({ flow: "reset" });
    expect(rowOf((await send(rawKey, {})).body).tags).toBeNull();
    expect(rowOf((await send(rawKey, { tags: {} })).body).tags).toBeNull();
  });

  test("a template send keeps the tags", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const { id: templateId } = await seed.template({ apiKeyId });
    const { status, body } = await send(rawKey, {
      subject: undefined,
      text: undefined,
      templateId,
      variables: { name: "Ada" },
      tags: { flow: "welcome" },
    });
    expect(status).toBe(200);
    expect(rowOf(body).tags).toEqual({ flow: "welcome" });
  });

  test.each([
    ["a control character", { flow: "re\u0000set" }, "/tags/flow"],
    ["a line break", { flow: "re\r\nBcc: victim@example.com" }, "/tags/flow"],
    ["a bidi control", { flow: "re\u202eset" }, "/tags/flow"],
    ["an empty value", { flow: "  " }, "/tags/flow"],
    ["a 257-character value", { flow: "a".repeat(257) }, "/tags/flow"],
    ["an invalid key", { "bad key": "v" }, "/tags"],
    ["keys equal ignoring case", { Flow: "a", flow: "b" }, "/tags/flow"],
    [
      "11 tags",
      Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])),
      "/tags",
    ],
  ])("%s is 422 VALIDATION_ERROR, nothing queued", async (_name, tags, path) => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, { tags });
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details?.[0]?.path).toBe(path);
    expect(JSON.stringify(body)).not.toContain("victim");
    expect(JSON.stringify(body)).not.toContain("bad key");
    expect(await emailCount()).toBe(0);
  });

  test("a non-string value is a schema validation error, nothing queued", async () => {
    const { rawKey } = await seed.apiKey();
    const { status, body } = await send(rawKey, { tags: { flow: 1 } });
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(await emailCount()).toBe(0);
  });

  test("an idempotent replay keeps the tags", async () => {
    const { rawKey } = await seed.apiKey();
    const tags = { flow: "invoice" };
    const first = await send(rawKey, { tags }, "key-189");
    const replay = await send(rawKey, { tags }, "key-189");
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.replayed).toBe("true");
    expect(rowOf(replay.body).tags).toEqual(tags);
    expect(await emailCount()).toBe(1);
  });
});

describe("GET /api/v1/emails?tag=", () => {
  let key = { id: "", rawKey: "" };
  let other = { id: "", rawKey: "" };
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    key = await seed.apiKey({ name: "a" });
    other = await seed.apiKey({ name: "b" });
    const rows: [string, Record<string, string>, "sent" | "queued"][] = [
      ["r1", { flow: "reset", tenant: "t1" }, "sent"],
      ["r2", { flow: "reset", tenant: "t2" }, "queued"],
      ["inv", { flow: "invoice", tenant: "t1" }, "sent"],
      ["url", { link: "https://example.com:8443/a,b" }, "sent"],
    ];
    for (const [name, tags, status] of rows) {
      ids[name] = (await seed.email({ apiKeyId: key.id, tags, status })).id;
    }
    ids["none"] = (await seed.email({ apiKeyId: key.id })).id;
    ids["otherKey"] = (
      await seed.email({ apiKeyId: other.id, tags: { flow: "reset", tenant: "t1" } })
    ).id;
  });

  test("one tag: only this key's emails carrying it", async () => {
    const { status, body } = await list(key.rawKey, tagQuery("flow:reset"));
    expect(status).toBe(200);
    expect(idsOf(body)).toEqual([ids["r1"]!, ids["r2"]!].toSorted());
    expect(body.pagination?.total).toBe(2);
  });

  test("two tags: both must match (AND)", async () => {
    const { body } = await list(key.rawKey, tagQuery("flow:reset", "tenant:t1"));
    expect(idsOf(body)).toEqual([ids["r1"]!]);
  });

  test("a value containing : and , matches whole", async () => {
    const { body } = await list(
      key.rawKey,
      tagQuery("link:https://example.com:8443/a,b"),
    );
    expect(idsOf(body)).toEqual([ids["url"]!]);
    const partial = await list(key.rawKey, tagQuery("link:https://example.com"));
    expect(idsOf(partial.body)).toEqual([]);
  });

  test("another key's tagged emails never show", async () => {
    const { body } = await list(other.rawKey, tagQuery("flow:reset"));
    expect(idsOf(body)).toEqual([ids["otherKey"]!]);
    const mine = await list(key.rawKey, tagQuery("flow:reset", "tenant:t1"));
    expect(idsOf(mine.body)).not.toContain(ids["otherKey"]!);
  });

  test("composes with status and pagination", async () => {
    const sent = await list(key.rawKey, `${tagQuery("flow:reset")}&status=sent`);
    expect(idsOf(sent.body)).toEqual([ids["r1"]!]);
    const page = await list(key.rawKey, `${tagQuery("tenant:t1")}&limit=1&page=2`);
    expect(page.body.pagination).toEqual({ page: 2, limit: 1, total: 2 });
    expect(idsOf(page.body)).toHaveLength(1);
  });

  test.each([
    ["no colon", "flow"],
    ["a bad key", "bad key:v"],
    ["an empty value", "flow:"],
    ["a control character", "flow:a\u0000"],
  ])("%s is 422 VALIDATION_ERROR at /tag", async (_name, raw) => {
    const { status, body } = await list(key.rawKey, tagQuery(raw));
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details?.[0]?.path).toBe("/tag");
  });

  test("more than 10 filters is 422", async () => {
    const raws = Array.from({ length: 11 }, (_, i) => `k${i}:v`);
    expect((await list(key.rawKey, tagQuery(...raws))).status).toBe(422);
  });

  test("the filter is served by the GIN index", async () => {
    await db.execute(sql`
      INSERT INTO emails (id, api_key_id, from_address, to_address, subject, status, tags)
      SELECT 'msg_bulk_' || g, ${key.id}, 'a@example.com', 'b@example.org', 's', 'sent',
             jsonb_build_object('order', 'o' || g)
      FROM generate_series(1, 5000) AS g
    `);
    await db.execute(sql`ANALYZE emails`);
    const query = db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          eq(emails.apiKeyId, key.id),
          isNull(emails.deletedAt),
          sql`${emails.tags} @> jsonb_build_object(${"order"}::text, ${"o42"}::text)`,
        ),
      );
    const { sql: text, params } = query.toSQL();
    const plan: Record<string, unknown>[] = await db.$client.unsafe(
      `EXPLAIN ${text}`,
      params,
    );
    const lines = plan.map((row) => String(row["QUERY PLAN"])).join("\n");
    expect(lines).toContain("idx_emails_tags");
  });
});

describe("SMTP submission X-BunMail-Tag", () => {
  /** Isolated port, distinct from the other SMTP test files'. */
  const TEST_PORT = 12615;

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

  test("stores the tags and never relays the header", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    await client(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "via smtp",
      text: "hi",
      headers: [
        { key: "X-BunMail-Tag", value: "flow=reset" },
        { key: "x-bunmail-tag", value: "query=a=b" },
        { key: "X-Trace", value: "1" },
      ],
    });

    const [row] = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(row!.tags).toEqual({ flow: "reset", query: "a=b" });
    const names = Object.keys(row!.headers ?? {}).map((n) => n.toLowerCase());
    expect(names).toContain("x-trace");
    expect(names).not.toContain("x-bunmail-tag");

    const calls: Parameters<typeof sendMail>[0][] = [];
    await runQueueCycle({ sendMail: recordingMailer(calls) });
    expect(calls).toHaveLength(1);
    const relayed = Object.keys(calls[0]!.headers ?? {}).map((n) => n.toLowerCase());
    expect(relayed).not.toContain("x-bunmail-tag");
  });

  test.each([
    ["no =", ["flow"]],
    ["a bidi control", ["flow=re\u202eset"]],
    ["a duplicate key", ["flow=a", "Flow=b"]],
    ["11 tags", Array.from({ length: 11 }, (_, i) => `k${i}=v`)],
  ])("%s is refused with 550, nothing queued", async (_name, values) => {
    const { rawKey } = await seed.apiKey();
    const refused = await client(rawKey)
      .sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "via smtp",
        text: "hi",
        headers: values.map((value) => ({ key: "X-BunMail-Tag", value })),
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(Error);
    expect(Reflect.get(Object(refused), "responseCode")).toBe(550);
    expect(String(Reflect.get(Object(refused), "response"))).toContain("X-BunMail-Tag");
    expect(await emailCount()).toBe(0);
  });
});

describe("webhooks", () => {
  test("the email.sent delivery carries the tags", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    await seed.webhook({
      apiKeyId,
      url: "https://hooks.example.com/x",
      events: ["email.sent"],
    });
    const tags = { flow: "reset", tenant: "t_42" };
    await send(rawKey, { tags });

    await runQueueCycle({ sendMail: recordingMailer([]) });

    const rows = await db
      .select({ event: webhookDeliveries.event, payload: webhookDeliveries.payload })
      .from(webhookDeliveries);
    expect(rows.map((r) => r.event)).toEqual(["email.sent"]);
    const envelope: { data: { tags: unknown } } = JSON.parse(rows[0]!.payload);
    expect(envelope.data.tags).toEqual(tags);
  });

  test("an email without tags sends tags: null", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    await seed.webhook({
      apiKeyId,
      url: "https://hooks.example.com/x",
      events: ["email.sent"],
    });
    await send(rawKey, {});
    await runQueueCycle({ sendMail: recordingMailer([]) });
    const [row] = await db
      .select({ payload: webhookDeliveries.payload })
      .from(webhookDeliveries);
    const envelope: { data: Record<string, unknown> } = JSON.parse(row!.payload);
    expect(envelope.data).toHaveProperty("tags", null);
  });
});

describe("dashboard", () => {
  const HOSTILE = '<script>alert("x")</script>';
  let memberToken = "";
  let apiKeyId = "";

  beforeEach(async () => {
    apiKeyId = (await seed.apiKey()).id;
    const { id: userId } = await seed.user({
      email: "member@example.com",
      role: "member",
    });
    memberToken = (await seed.session({ userId })).token;
  });

  function dashboardGet(path: string): Promise<Response> {
    return dashboard.handle(
      new Request(`http://localhost${path}`, {
        headers: { cookie: `bm_session=${memberToken}` },
      }),
    );
  }

  test("the list filters by a tag and keeps it in the other filters' links", async () => {
    await seed.email({ apiKeyId, subject: "tagged-one", tags: { flow: "reset" } });
    await seed.email({ apiKeyId, subject: "untagged-one" });

    const res = await dashboardGet(
      `/dashboard/emails${tagQuery("flow:reset")}&status=queued`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("tagged-one");
    expect(html).not.toContain("untagged-one");
    /** The status tabs and dropdowns keep the tag. */
    expect(html).toContain("tag=flow%3Areset");
    expect(html).toContain('value="flow:reset"');
  });

  test("an invalid filter lists nothing and says why", async () => {
    await seed.email({ apiKeyId, subject: "tagged-one", tags: { flow: "reset" } });
    const res = await dashboardGet(`/dashboard/emails${tagQuery("flow")}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("tagged-one");
    expect(html).toContain("must be key:value");
  });

  test("the detail page shows the tags, escaped", async () => {
    const { id } = await seed.email({ apiKeyId, tags: { flow: HOSTILE } });
    const res = await dashboardGet(`/dashboard/emails/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(HOSTILE);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("flow: ");
  });
});

describe("logging", () => {
  test("no log line carries a tag value", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    await seed.webhook({
      apiKeyId,
      url: "https://hooks.example.com/x",
      events: ["email.sent"],
    });
    const SECRET = "cust-secret-value-189";
    const logs = await captureLogs(async () => {
      await send(rawKey, { tags: { customer: SECRET } });
      await send(rawKey, { tags: { customer: `${SECRET}\u0000` } });
      await list(rawKey, tagQuery(`customer:${SECRET}`));
      await list(rawKey, tagQuery(`customer:${SECRET}\u0000`));
      await runQueueCycle({ sendMail: recordingMailer([]) });
    });
    expect(logs).toContain("customer");
    expect(logs).not.toContain(SECRET);
  });
});
