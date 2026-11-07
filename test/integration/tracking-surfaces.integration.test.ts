/**
 * Open and click tracking, part 3 (#187), against a real Postgres:
 *
 * - `email.opened` / `email.clicked` webhooks: enqueued through the outbox
 *   in the recording transaction (a failed enqueue rolls the event back),
 *   for recorded events only, with the documented payload, and only to
 *   the sending key's subscriptions;
 * - `GET /api/v1/emails/:id/events`: scoped to the key, paginated, oldest
 *   first, no internal ids;
 * - the dashboard: the email page's timeline (escaped) and the list's
 *   Opened / Clicked badges.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { createTrackingRecorder } from "../../src/modules/tracking/services/tracking-record.service.ts";
import * as dispatch from "../../src/modules/webhooks/services/webhook-dispatch.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { emailEvents } from "../../src/modules/emails/models/email-event.schema.ts";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import type { TrackingHit } from "../../src/modules/tracking/types/tracking.types.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

const RECIPIENT = "user@example.org";
const HOOK_URL = "https://93.184.216.34/hook";
const originalEnabled = config.tracking.enabled;

let keyA = { id: "", rawKey: "" };
let keyB = { id: "", rawKey: "" };
let emailId = "";

/** A sent, tracked, single-recipient email of `apiKeyId`. */
async function trackedEmail(
  apiKeyId: string,
  tags: Record<string, string> | null = null,
): Promise<string> {
  const { id } = await seed.email({
    apiKeyId,
    toAddress: RECIPIENT,
    status: "sent",
    tags,
  });
  await db
    .update(emails)
    .set({
      trackOpens: true,
      trackClicks: true,
      sentAt: new Date(Date.now() - 3_600_000),
    })
    .where(eq(emails.id, id));
  return id;
}

function openHit(id: string = emailId): TrackingHit {
  return { kind: "open", emailId: id, position: null, url: null, userAgent: null };
}

function clickHit(position: number, url: string, id: string = emailId): TrackingHit {
  return { kind: "click", emailId: id, position, url, userAgent: null };
}

/** The deliveries enqueued so far, payload parsed. */
async function deliveries(): Promise<
  Array<{
    webhookId: string;
    event: string;
    payload: { event: string; data: Record<string, unknown> };
  }>
> {
  const rows = await db
    .select({
      webhookId: webhookDeliveries.webhookId,
      event: webhookDeliveries.event,
      payload: webhookDeliveries.payload,
    })
    .from(webhookDeliveries);
  return rows.map((row) => ({
    webhookId: row.webhookId,
    event: row.event,
    payload: envelopeOf(JSON.parse(row.payload)),
  }));
}

/** Narrows a parsed delivery payload to the webhook envelope. */
function envelopeOf(value: unknown): { event: string; data: Record<string, unknown> } {
  if (typeof value !== "object" || value === null) throw new Error("not an envelope");
  const event: unknown = Reflect.get(value, "event");
  const data: unknown = Reflect.get(value, "data");
  if (typeof event !== "string" || typeof data !== "object" || data === null) {
    throw new Error("not an envelope");
  }
  return { event, data: Object.fromEntries(Object.entries(data)) };
}

beforeEach(async () => {
  await truncateAll();
  Object.assign(config.tracking, { enabled: true });
  keyA = await seed.apiKey({ name: "a" });
  keyB = await seed.apiKey({ name: "b" });
  emailId = await trackedEmail(keyA.id, { flow: "welcome" });
});

afterEach(() => {
  Object.assign(config.tracking, { enabled: originalEnabled });
});

describe("email.opened and email.clicked webhooks", () => {
  test("a recorded open fires email.opened to the sending key's webhook only", async () => {
    const hookA = await seed.webhook({
      apiKeyId: keyA.id,
      url: HOOK_URL,
      events: ["email.opened"],
    });
    await seed.webhook({ apiKeyId: keyB.id, url: HOOK_URL, events: ["email.opened"] });
    await seed.webhook({ apiKeyId: keyA.id, url: HOOK_URL, events: ["email.sent"] });

    expect(await createTrackingRecorder()(openHit())).toBe("recorded");
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.webhookId).toBe(hookA.id);
    expect(rows[0]?.event).toBe("email.opened");
    const data = rows[0]?.payload.data ?? {};
    expect(Object.keys(data).toSorted()).toEqual(
      [
        "clientKind",
        "emailId",
        "first",
        "machine",
        "occurredAt",
        "recipient",
        "tags",
      ].toSorted(),
    );
    expect(data).toMatchObject({
      emailId,
      recipient: RECIPIENT,
      first: true,
      machine: false,
      clientKind: "unknown",
      tags: { flow: "welcome" },
    });
    expect(Number.isNaN(Date.parse(String(data["occurredAt"])))).toBe(false);
  });

  test("a recorded click carries the URL without query and fragment, the link position and first", async () => {
    await seed.webhook({ apiKeyId: keyA.id, url: HOOK_URL, events: ["email.clicked"] });
    const recorder = createTrackingRecorder();
    expect(
      await recorder(clickHit(2, "https://example.com/pricing?token=secret#plans")),
    ).toBe("recorded");
    expect(await recorder(clickHit(3, "https://example.com/other"))).toBe("recorded");
    const rows = await deliveries();
    expect(rows.map((r) => r.event)).toEqual(["email.clicked", "email.clicked"]);
    const [firstClick, secondClick] = rows.map((r) => r.payload.data);
    expect(firstClick).toMatchObject({
      emailId,
      url: "https://example.com/pricing",
      linkPosition: 2,
      first: true,
    });
    expect(secondClick).toMatchObject({ linkPosition: 3, first: false, machine: true });
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  test("deduped, capped and untracked hits fire nothing", async () => {
    await seed.webhook({
      apiKeyId: keyA.id,
      url: HOOK_URL,
      events: ["email.opened", "email.clicked"],
    });
    const recorder = createTrackingRecorder();
    expect(await recorder(openHit())).toBe("recorded");
    expect(await recorder(openHit())).toBe("deduped");

    /** A fresh process: the database dedupe answers. */
    expect(await createTrackingRecorder()(openHit())).toBe("deduped");

    const untracked = await trackedEmail(keyA.id);
    await db.update(emails).set({ trackOpens: false }).where(eq(emails.id, untracked));
    expect(await recorder(openHit(untracked))).toBe("untracked");

    Object.assign(config.tracking, { enabled: false });
    expect(await recorder(clickHit(0, "https://example.com/"))).toBe("untracked");
    expect(await deliveries()).toHaveLength(1);
  });

  test("the event row and its webhook commit together: a failed enqueue leaves neither", async () => {
    await seed.webhook({ apiKeyId: keyA.id, url: HOOK_URL, events: ["email.opened"] });
    const enqueue = spyOn(dispatch, "enqueueEvent").mockRejectedValue(
      new Error("outbox down"),
    );
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      expect(await createTrackingRecorder()(openHit())).toBeNull();
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      enqueue.mockRestore();
      error.mockRestore();
    }
    expect(await db.select().from(emailEvents)).toEqual([]);
    expect(await deliveries()).toEqual([]);
    const [row] = await db
      .select({ opened: emails.firstOpenedAt })
      .from(emails)
      .where(eq(emails.id, emailId));
    expect(row?.opened).toBeNull();
  });
});

/* ─── Events API ─── */

const api = new Elysia().use(emailsPlugin);

interface EventsBody {
  success: boolean;
  data?: Array<Record<string, unknown>>;
  pagination?: { page: number; limit: number; total: number };
}

function getEvents(key: string, id: string, query = ""): Promise<Response> {
  return api.handle(
    new Request(`http://localhost/api/v1/emails/${id}/events${query}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
  );
}

/** Inserts `count` events of the seeded email, one second apart from `ageSeconds` ago. */
async function insertEvents(count: number, ageSeconds = 600): Promise<void> {
  await db.insert(emailEvents).values(
    Array.from({ length: count }, (_, i) => ({
      id: generateId("evt"),
      emailId,
      apiKeyId: keyA.id,
      type: i % 2 === 0 ? "open" : "click",
      linkPosition: i % 2 === 0 ? null : i,
      url: i % 2 === 0 ? null : `https://example.com/${i}`,
      clientKind: "unknown",
      machine: false,
      occurredAt: new Date(Date.now() - (ageSeconds - i) * 1000),
    })),
  );
}

describe("GET /api/v1/emails/:id/events", () => {
  test("oldest first, paginated, without internal ids", async () => {
    await insertEvents(5);
    const res = await getEvents(keyA.rawKey, emailId, "?limit=2&page=2");
    expect(res.status).toBe(200);
    const body = await readJson<EventsBody>(res);
    expect(body.pagination).toEqual({ page: 2, limit: 2, total: 5 });
    expect(body.data?.map((e) => e["type"])).toEqual(["open", "click"]);
    expect(Object.keys(body.data?.[1] ?? {}).toSorted()).toEqual(
      ["clientKind", "linkPosition", "machine", "occurredAt", "type", "url"].toSorted(),
    );
    expect(body.data?.[1]).toMatchObject({
      url: "https://example.com/3",
      linkPosition: 3,
    });
    const all = await readJson<EventsBody>(await getEvents(keyA.rawKey, emailId));
    const times = (all.data ?? []).map((e) => Date.parse(String(e["occurredAt"])));
    expect(times).toEqual(times.toSorted((a, b) => a - b));
  });

  test("an email without events: an empty page", async () => {
    const body = await readJson<EventsBody>(await getEvents(keyA.rawKey, emailId));
    expect(body).toEqual({
      success: true,
      data: [],
      pagination: { page: 1, limit: 20, total: 0 },
    });
  });

  test("another key's email, a missing email or a trashed one: 404", async () => {
    await insertEvents(1);
    expect((await getEvents(keyB.rawKey, emailId)).status).toBe(404);
    expect((await getEvents(keyA.rawKey, "msg_000000000000000000000000")).status).toBe(
      404,
    );
    await db.update(emails).set({ deletedAt: new Date() }).where(eq(emails.id, emailId));
    expect((await getEvents(keyA.rawKey, emailId)).status).toBe(404);
  });

  test("at most 100 per page", async () => {
    expect((await getEvents(keyA.rawKey, emailId, "?limit=101")).status).toBe(422);
    expect((await getEvents(keyA.rawKey, emailId, "?limit=100")).status).toBe(200);
  });
});

/* ─── Dashboard ─── */

const dashboard = new Elysia().use(pagesPlugin);

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

describe("dashboard", () => {
  const HOSTILE = `https://example.com/"><script>alert(1)</script>`;

  test("the email page shows the timeline, escaped, with the caveat and the automated badge", async () => {
    await db.insert(emailEvents).values([
      {
        id: generateId("evt"),
        emailId,
        apiKeyId: keyA.id,
        type: "open",
        clientKind: "image_proxy",
        machine: true,
        occurredAt: new Date("2026-11-07T10:00:00Z"),
      },
      {
        id: generateId("evt"),
        emailId,
        apiKeyId: keyA.id,
        type: "click",
        linkPosition: 0,
        url: HOSTILE,
        clientKind: "unknown",
        machine: false,
        occurredAt: new Date("2026-11-07T10:05:00Z"),
      },
    ]);
    const html = await page(`/dashboard/emails/${emailId}`);
    expect(html).toContain("Opens and clicks");
    expect(html).toContain("Apple Mail Privacy Protection");
    expect(html).toContain("2026-11-07 10:00:00 UTC");
    expect(html).toContain("Likely automated");
    expect(html).toContain("Image proxy");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("an untracked email without events shows no timeline", async () => {
    const plain = (await seed.email({ apiKeyId: keyA.id })).id;
    expect(await page(`/dashboard/emails/${plain}`)).not.toContain("Opens and clicks");
  });

  test("the list shows Opened and Clicked badges from the first open and click", async () => {
    await db
      .update(emails)
      .set({ firstOpenedAt: new Date(), firstClickedAt: new Date() })
      .where(eq(emails.id, emailId));
    const other = await seed.email({ apiKeyId: keyA.id, subject: "plain" });
    const html = await page("/dashboard/emails");
    expect(html).toContain(">Opened</span>");
    expect(html).toContain(">Clicked</span>");
    expect(html.split(">Opened</span>")).toHaveLength(2);
    expect(other.id).toMatch(/^msg_/);
  });
});
