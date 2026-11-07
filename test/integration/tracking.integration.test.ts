/**
 * Open and click tracking, recording (#187), against a real Postgres:
 *
 * - `GET /t/o/<token>.gif` and `GET /t/c/<token>` behind the app's
 *   security headers: exact responses and headers, neutral 404s, `HEAD`
 *   never recorded, the kill switch, an untracked email and a deleted
 *   email still served, and only invalid tokens rate limited;
 * - recording: dedupe, caps, the per-second budget, `first_*_at` set once,
 *   no IP or user agent stored, the click URL stored without query, the
 *   `machine` guess, and the metrics;
 * - the full path: a tracked send composed by the queue carries the pixel
 *   and rewritten links (never in the text part), and following them
 *   records events.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { eq, sql } from "drizzle-orm";
import { securityHeadersPlugin } from "../../src/middleware/security-headers.ts";
import {
  TRANSPARENT_GIF,
  trackingPlugin,
  type TrackingPluginOptions,
} from "../../src/modules/tracking/tracking.plugin.ts";
import {
  createTrackingRecorder,
  MAX_OPENS_PER_EMAIL,
  type RecordResult,
} from "../../src/modules/tracking/services/tracking-record.service.ts";
import {
  mintClickToken,
  mintOpenToken,
} from "../../src/modules/tracking/services/tracking-token.ts";
import { emailEvents } from "../../src/modules/emails/models/email-event.schema.ts";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { composeMessageBody } from "../../src/modules/emails/services/message-body.ts";
import { renderMetrics } from "../../src/modules/metrics/services/metrics.service.ts";
import { generateId } from "../../src/utils/id.ts";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

const BASE = "https://mail.example.com";
const RECIPIENT = "user@example.org";
const TARGET = "https://example.com/pricing?token=secret#plans";
const GMAIL_PROXY =
  "Mozilla/5.0 (Windows NT 5.1) Firefox/11.0 (via ggpht.com GoogleImageProxy)";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

const originalEnabled = config.tracking.enabled;
const originalBaseUrl = config.appBaseUrl;

/** Background recordings of the current app, awaited by {@link settle}. */
let pending: Array<Promise<RecordResult | null>> = [];

/** The tracking routes as `src/app.ts` mounts them: security headers first. */
/** Anything that answers a request: the app or a variant of it. */
interface Handler {
  handle: (request: Request) => Promise<Response>;
}

function buildApp(options: TrackingPluginOptions = {}): Handler {
  return new Elysia().use(securityHeadersPlugin({ httpsBaseUrl: true })).use(
    trackingPlugin({
      onRecord: (task) => {
        pending.push(task);
      },
      ...options,
    }),
  );
}

let app = buildApp();

/** Waits for every background recording and returns their results. */
async function settle(): Promise<Array<RecordResult | null>> {
  const tasks = pending;
  pending = [];
  return Promise.all(tasks);
}

function request(
  path: string,
  init: { method?: string; userAgent?: string; target?: Handler } = {},
): Promise<Response> {
  return (init.target ?? app).handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        "user-agent": init.userAgent ?? BROWSER,
        "x-forwarded-for": "203.0.113.9",
      },
    }),
  );
}

let apiKeyId = "";
let emailId = "";

/** A sent, single-recipient email tracked for opens and clicks. */
async function trackedEmail(sentAgoMs = 60 * 60 * 1000): Promise<string> {
  const { id } = await seed.email({ apiKeyId, toAddress: RECIPIENT, status: "sent" });
  await db
    .update(emails)
    .set({
      trackOpens: true,
      trackClicks: true,
      sentAt: new Date(Date.now() - sentAgoMs),
    })
    .where(eq(emails.id, id));
  return id;
}

function openPath(id: string = emailId): string {
  return `/t/o/${mintOpenToken(id)}.gif`;
}

function clickPath(id: string = emailId, position = 0, url = TARGET): string {
  return `/t/c/${mintClickToken({ emailId: id, position, url })}`;
}

async function events(
  id: string = emailId,
): Promise<Array<typeof emailEvents.$inferSelect>> {
  return db.select().from(emailEvents).where(eq(emailEvents.emailId, id));
}

/** The value of one exact series line in a fresh scrape, 0 when absent. */
async function sample(series: string): Promise<number> {
  const text = await renderMetrics();
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

beforeEach(async () => {
  await truncateAll();
  Object.assign(config.tracking, { enabled: true });
  Reflect.set(config, "appBaseUrl", BASE);
  pending = [];
  app = buildApp();
  apiKeyId = (await seed.apiKey()).id;
  emailId = await trackedEmail();
});

afterEach(async () => {
  await settle();
  Object.assign(config.tracking, { enabled: originalEnabled });
  Reflect.set(config, "appBaseUrl", originalBaseUrl);
});

describe("GET /t/o/<token>.gif", () => {
  test("a valid token: the 43-byte GIF with exact headers, and an event", async () => {
    const res = await request(openPath());
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(43);
    expect(body.equals(TRANSPARENT_GIF)).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await settle()).toEqual(["recorded"]);
    const [event] = await events();
    expect(event).toMatchObject({
      type: "open",
      apiKeyId,
      linkPosition: null,
      url: null,
      clientKind: "unknown",
      machine: false,
    });
  });

  test("invalid tokens get a neutral 404 and record nothing", async () => {
    const valid = openPath();
    const tampered = `${valid.slice(0, -5)}${valid.at(-5) === "0" ? "1" : "0"}.gif`;
    for (const path of [tampered, valid.replace(".gif", ".png"), "/t/o/nope.gif"]) {
      const res = await request(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(emailId.slice(4));
    }
    expect(await settle()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  test("HEAD is answered like GET and never recorded", async () => {
    const res = await request(openPath(), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(await settle()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  test("the kill switch off: still served, nothing recorded", async () => {
    Object.assign(config.tracking, { enabled: false });
    expect((await request(openPath())).status).toBe(200);
    expect(await settle()).toEqual(["untracked"]);
    expect(await events()).toEqual([]);
  });

  test("an email not tracked for opens: still served, nothing recorded", async () => {
    await db.update(emails).set({ trackOpens: false }).where(eq(emails.id, emailId));
    expect((await request(openPath())).status).toBe(200);
    expect(await settle()).toEqual(["untracked"]);
  });

  test("a deleted email: the pixel is still served, nothing recorded", async () => {
    const path = openPath();
    await db.delete(emails).where(eq(emails.id, emailId));
    const res = await request(path);
    expect(res.status).toBe(200);
    /** A valid MAC for a missing row: the recorder finds no row. */
    expect(await settle()).toEqual(["untracked"]);
    expect(await events()).toEqual([]);
  });

  test("invalid open tokens are refused before any database query", async () => {
    const select = spyOn(db, "select");
    const transaction = spyOn(db, "transaction");
    try {
      const forged = `/t/o/${emailId.slice(4)}.${"0".repeat(32)}.gif`;
      expect((await request(forged)).status).toBe(404);
      expect((await request("/t/o/nope.gif")).status).toBe(404);
      expect(select).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      transaction.mockRestore();
    }
  });

  test("a forged token for a deleted email gets the same 404 as any other (no existence oracle)", async () => {
    const forged = `/t/o/${emailId.slice(4)}.${"0".repeat(32)}.gif`;
    const before = await request(forged);
    await db.delete(emails).where(eq(emails.id, emailId));
    const after = await request(forged);
    expect([before.status, after.status]).toEqual([404, 404]);
    expect(await after.text()).toBe(await before.text());
  });
});

describe("GET /t/c/<token>", () => {
  test("a valid token: 302 to exactly the signed URL, and an event without the query", async () => {
    const res = await request(clickPath(emailId, 3));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TARGET);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await settle()).toEqual(["recorded"]);
    const [event] = await events();
    expect(event).toMatchObject({
      type: "click",
      linkPosition: 3,
      url: "https://example.com/pricing",
      machine: false,
    });
  });

  test("an invalid token: a neutral 404 page that never shows the URL", async () => {
    const path = clickPath();
    const [hex, position, , mac] = path.slice("/t/c/".length).split(".");
    const evil = Buffer.from("https://evil.example/steal").toString("base64url");
    const js = Buffer.from("javascript:alert(1)").toString("base64url");
    for (const bad of [
      `/t/c/${hex}.${position}.${evil}.${mac}`,
      `/t/c/${hex}.${position}.${js}.${mac}`,
      "/t/c/garbage",
    ]) {
      const res = await request(bad);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      const text = await res.text();
      expect(text).toContain("This link is not valid.");
      expect(text).not.toContain("evil.example");
      expect(text).not.toContain("example.com");
    }
    expect(await events()).toEqual([]);
  });

  test("HEAD redirects and is never recorded", async () => {
    const res = await request(clickPath(), { method: "HEAD" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TARGET);
    expect(await settle()).toEqual([]);
  });

  test("links already sent still redirect: kill switch off, email untracked, or gone", async () => {
    Object.assign(config.tracking, { enabled: false });
    expect((await request(clickPath())).headers.get("location")).toBe(TARGET);
    Object.assign(config.tracking, { enabled: true });
    await db.update(emails).set({ trackClicks: false }).where(eq(emails.id, emailId));
    /** Other links of the email, so the in-memory dedupe does not answer first. */
    expect((await request(clickPath(emailId, 1))).headers.get("location")).toBe(TARGET);
    await db.delete(emails).where(eq(emails.id, emailId));
    expect((await request(clickPath(emailId, 2))).headers.get("location")).toBe(TARGET);
    expect(await settle()).toEqual(["untracked", "untracked", "untracked"]);
  });
});

describe("rate limit: invalid tokens only", () => {
  test("past the limit invalid tokens get 429; valid requests are still served", async () => {
    const limited = buildApp({ limit: { max: 2, windowMs: 60_000 } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await request("/t/c/garbage", { target: limited })).status);
    }
    expect(statuses).toEqual([404, 404, 429]);
    expect((await request(clickPath(), { target: limited })).status).toBe(302);
    expect((await request(openPath(), { target: limited })).status).toBe(200);
  });
});

describe("recording", () => {
  test("the same email, type and link within 60 s is recorded once", async () => {
    /** Concurrent recordings: the row lock lets one through, whichever comes first. */
    await request(openPath());
    await request(openPath());
    expect((await settle()).map(String).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "deduped",
      "recorded",
    ]);
    await request(clickPath(emailId, 0));
    await request(clickPath(emailId, 0));
    expect((await settle()).map(String).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "deduped",
      "recorded",
    ]);
    expect(await events()).toHaveLength(2);
  });

  test("another link of the same email is its own event", async () => {
    await request(clickPath(emailId, 0));
    await settle();
    await request(clickPath(emailId, 1, "https://example.com/other"));
    expect(await settle()).toEqual(["recorded"]);
    const second = (await events()).find((e) => e.linkPosition === 1);
    /** A second link within 2 s of the first: likely a link scanner. */
    expect(second?.machine).toBe(true);
  });

  test("an email's open cap stops recording", async () => {
    await db.insert(emailEvents).values(
      Array.from({ length: MAX_OPENS_PER_EMAIL }, () => ({
        id: generateId("evt"),
        emailId,
        apiKeyId,
        type: "open",
        clientKind: "unknown",
        machine: false,
        occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      })),
    );
    expect((await request(openPath())).status).toBe(200);
    expect(await settle()).toEqual(["capped"]);
    expect(await events()).toHaveLength(MAX_OPENS_PER_EMAIL);
  });

  test("the per-second budget: served, not recorded past it", async () => {
    const budgeted = buildApp({
      recorder: createTrackingRecorder({ budgetPerSecond: 1, now: () => 1_000_000 }),
    });
    const other = await trackedEmail();
    await request(openPath(), { target: budgeted });
    expect((await request(openPath(other), { target: budgeted })).status).toBe(200);
    expect(await settle()).toEqual(["recorded", "capped"]);
  });

  test("a replayed token is deduped in memory and never uses the budget up for other emails", async () => {
    const budgeted = buildApp({
      recorder: createTrackingRecorder({ budgetPerSecond: 2 }),
    });
    const others = [await trackedEmail(), await trackedEmail()];
    for (let i = 0; i < 20; i += 1) await request(openPath(), { target: budgeted });
    for (const other of others) await request(openPath(other), { target: budgeted });
    const results = await settle();
    expect(results.filter((r) => r === "recorded")).toHaveLength(2);
    expect(results.filter((r) => r === "deduped")).toHaveLength(19);
    expect(results.at(-1)).toBe("capped");
  });

  test("at most maxInFlight recordings at once: the rest is capped without the database", async () => {
    const narrow = buildApp({ recorder: createTrackingRecorder({ maxInFlight: 1 }) });
    const other = await trackedEmail();
    await request(openPath(), { target: narrow });
    await request(openPath(other), { target: narrow });
    expect(await settle()).toEqual(["recorded", "capped"]);
    expect(await events(other)).toEqual([]);
  });

  test("a held email row lock times out: capped, logged at debug, never an error", async () => {
    const recorder = createTrackingRecorder();
    const error = spyOn(logger, "error");
    try {
      const result = await db.transaction(async (tx) => {
        await tx
          .select({ id: emails.id })
          .from(emails)
          .where(eq(emails.id, emailId))
          .for("update");
        return recorder({
          kind: "open",
          emailId,
          position: null,
          url: null,
          userAgent: null,
        });
      });
      expect(result).toBe("capped");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(await events()).toEqual([]);
  }, 15_000);

  test("a database failure is logged by name and SQLSTATE only, never the driver message", async () => {
    const recorder = createTrackingRecorder();
    const failure = spyOn(db, "transaction").mockRejectedValue(
      new Error(
        "insert into email_events values ('user@example.org', 'https://example.com/?token=secret')",
      ),
    );
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      expect(
        await recorder({
          kind: "click",
          emailId,
          position: 0,
          url: TARGET,
          userAgent: null,
        }),
      ).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(error.mock.calls[0]);
      expect(logged).toContain(emailId);
      expect(logged).not.toContain("secret");
      expect(logged).not.toContain("user@example.org");
    } finally {
      failure.mockRestore();
      error.mockRestore();
    }
  });

  test("first_opened_at and first_clicked_at are set once", async () => {
    await request(openPath());
    await settle();
    const [first] = await db
      .select({ opened: emails.firstOpenedAt, clicked: emails.firstClickedAt })
      .from(emails)
      .where(eq(emails.id, emailId));
    expect(first?.opened).toBeInstanceOf(Date);
    expect(first?.clicked).toBeNull();

    /** Out of the dedupe window, a second open is recorded but does not move it. */
    await db
      .update(emailEvents)
      .set({ occurredAt: sql`now() - interval '2 minutes'` })
      .where(eq(emailEvents.emailId, emailId));
    /** A fresh process: its in-memory dedupe has not seen the first open. */
    await request(openPath(), { target: buildApp() });
    expect(await settle()).toEqual(["recorded"]);
    const [after] = await db
      .select({ opened: emails.firstOpenedAt })
      .from(emails)
      .where(eq(emails.id, emailId));
    expect(after?.opened?.getTime()).toBe(first?.opened?.getTime());
  });

  test("no IP address and no user agent are stored, only client_kind and machine", async () => {
    await request(openPath(), { userAgent: GMAIL_PROXY });
    await settle();
    const [event] = await events();
    expect(event).toMatchObject({ clientKind: "image_proxy", machine: true });
    expect(Object.keys(event ?? {}).toSorted()).toEqual(
      [
        "apiKeyId",
        "clientKind",
        "emailId",
        "id",
        "linkPosition",
        "machine",
        "occurredAt",
        "type",
        "url",
      ].toSorted(),
    );
    const stored = JSON.stringify(event);
    expect(stored).not.toContain("203.0.113.9");
    expect(stored).not.toContain("GoogleImageProxy");
  });

  test("a click within 10 s of sending is flagged as likely automated", async () => {
    const fresh = await trackedEmail(2000);
    await request(clickPath(fresh, 0));
    await settle();
    expect((await events(fresh))[0]?.machine).toBe(true);
  });

  test("metrics count recorded and invalid requests", async () => {
    const recorded = 'bunmail_tracking_requests_total{kind="open",result="recorded"}';
    const invalid = 'bunmail_tracking_requests_total{kind="click",result="invalid"}';
    const before = [await sample(recorded), await sample(invalid)];
    await request(openPath());
    await settle();
    await request("/t/c/garbage");
    expect(await sample(recorded)).toBe((before[0] ?? 0) + 1);
    expect(await sample(invalid)).toBe((before[1] ?? 0) + 1);
  });
});

describe("the full path", () => {
  test("a tracked send carries the pixel and rewritten links, and following them records events", async () => {
    const { name } = await seed.domain({
      name: "tracked.example.com",
      trackOpens: true,
      trackClicks: true,
    });
    const { email } = await createEmail(
      {
        from: `hello@${name}`,
        to: RECIPIENT,
        subject: "Pricing",
        html: `<p>See <a href="${TARGET}">pricing</a>.</p>`,
      },
      apiKeyId,
    );
    expect(email.trackOpens && email.trackClicks).toBe(true);

    const calls: Array<Parameters<typeof sendMail>[0]> = [];
    const mailer: typeof sendMail = async (options) => {
      calls.push(options);
      return {
        messageId: options.messageId,
        deliveryState: {
          "example.org": {
            status: "sent",
            recipients: [RECIPIENT],
            attempts: 1,
            domain: "example.org",
          },
        },
      };
    };
    await runQueueCycle({ sendMail: mailer });
    const call = calls.find((c) => c.to === RECIPIENT && c.subject === "Pricing");
    expect(call?.tracking).toBeDefined();

    const body = composeMessageBody(
      call?.html ?? null,
      call?.text ?? null,
      call?.tracking,
    );
    const html = body.html ?? "";
    expect(body.text).not.toContain("/t/");
    expect(html).not.toContain(TARGET.replaceAll("&", "&amp;"));
    const pixel = /<img src="https:\/\/mail\.example\.com(\/t\/o\/[^"]+)"/.exec(
      html,
    )?.[1];
    const link = /href="https:\/\/mail\.example\.com(\/t\/c\/[^"]+)"/.exec(html)?.[1];
    expect(pixel).toBeDefined();
    expect(link).toBeDefined();
    /** The row keeps what the caller sent. */
    const [row] = await db
      .select({ html: emails.html })
      .from(emails)
      .where(eq(emails.id, email.id));
    expect(row?.html).toBe(`<p>See <a href="${TARGET}">pricing</a>.</p>`);

    expect((await request(pixel ?? "")).status).toBe(200);
    const res = await request(link ?? "");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TARGET);
    expect(await settle()).toEqual(["recorded", "recorded"]);
    expect((await events(email.id)).map((e) => e.type).toSorted()).toEqual([
      "click",
      "open",
    ]);
  });

  test("an untracked send carries nothing", async () => {
    const { name } = await seed.domain({ name: "plain.example.com" });
    await createEmail(
      {
        from: `hello@${name}`,
        to: RECIPIENT,
        subject: "Plain",
        html: `<a href="${TARGET}">x</a>`,
      },
      apiKeyId,
    );
    const calls: Array<Parameters<typeof sendMail>[0]> = [];
    await runQueueCycle({
      sendMail: async (options) => {
        calls.push(options);
        return { messageId: options.messageId, deliveryState: {} };
      },
    });
    expect(calls.find((c) => c.subject === "Plain")?.tracking).toBeUndefined();
  });
});
