/**
 * Delivery visibility (#250), against real Postgres:
 *
 * - `GET /api/v1/emails/:id` returns the stored per-MX delivery state as
 *   `deliveryState`, for the owning key only (another key gets 404), and
 *   the list carries it too;
 * - the dashboard detail page renders it as a table, every value escaped
 *   (a hostile MX name and `lastError`), with the plaintext badge;
 * - the stats count bounced rows, compute the bounce rate and the new
 *   success rate, and the home page shows the rate with its warning.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db, emails, seed, truncateAll } from "./_helpers.ts";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { getDashboardStats } from "../../src/modules/emails/services/stats.service.ts";
import type { DeliveryState } from "../../src/modules/emails/models/email.schema.ts";
import { readJson } from "../read-json.ts";

const api = new Elysia().use(emailsPlugin);
const dashboard = new Elysia().wrap(withRequestContext).use(pagesPlugin);

const HOSTILE_MX = "<img src=x onerror=alert(1)>.example";

const STATE: DeliveryState = {
  [`${HOSTILE_MX}#0`]: {
    status: "failed",
    recipients: ["alice@example.org"],
    attempts: 1,
    lastError: "550 5.1.1 <script>alert(1)</script>",
    failureKind: "hard",
    failureCode: "5.1.1",
    mxHost: HOSTILE_MX,
    tls: "plaintext",
    updatedAt: "2026-10-19T10:00:01.000Z",
  },
  "mx.example.org": {
    status: "sent",
    recipients: ["bob@example.org"],
    attempts: 1,
    deliveredAt: "2026-10-19T10:00:00.000Z",
    messageId: "<mid@bunmail.example.com>",
    tls: "plaintext",
    updatedAt: "2026-10-19T10:00:00.000Z",
  },
};

let ownerKey = { id: "", rawKey: "" };
let otherKey = { id: "", rawKey: "" };
let memberToken = "";
let emailId = "";

beforeEach(async () => {
  await truncateAll();
  ownerKey = await seed.apiKey({ name: "owner-key" });
  otherKey = await seed.apiKey({ name: "other-key" });
  const { id: userId } = await seed.user({ email: "member@example.com", role: "member" });
  memberToken = (await seed.session({ userId })).token;
  emailId = (
    await seed.email({
      apiKeyId: ownerKey.id,
      toAddress: "alice@example.org, bob@example.org",
      status: "sent",
    })
  ).id;
  await db.update(emails).set({ deliveryState: STATE }).where(eq(emails.id, emailId));
});

function apiGet(path: string, rawKey: string): Promise<Response> {
  return api.handle(
    new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${rawKey}` },
    }),
  );
}

function dashboardGet(path: string): Promise<Response> {
  return dashboard.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: `bm_session=${memberToken}` },
    }),
  );
}

describe("GET /api/v1/emails/:id: deliveryState (#250)", () => {
  test("the owning key sees the per-MX state, without internal keys", async () => {
    const res = await apiGet(`/api/v1/emails/${emailId}`, ownerKey.rawKey);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const data: unknown = Reflect.get(Object(body), "data");
    const state: unknown = Reflect.get(Object(data), "deliveryState");
    expect(state).toEqual([
      {
        mx: HOSTILE_MX,
        recipients: ["alice@example.org"],
        status: "failed",
        attempts: 1,
        failureKind: "hard",
        failureCode: "5.1.1",
        lastError: "550 5.1.1 <script>alert(1)</script>",
        tls: "plaintext",
        updatedAt: "2026-10-19T10:00:01.000Z",
      },
      {
        mx: "mx.example.org",
        recipients: ["bob@example.org"],
        status: "sent",
        attempts: 1,
        failureKind: null,
        failureCode: null,
        lastError: null,
        tls: "plaintext",
        updatedAt: "2026-10-19T10:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(state)).not.toContain("#0");
  });

  test("another key cannot see the email or its state", async () => {
    const res = await apiGet(`/api/v1/emails/${emailId}`, otherKey.rawKey);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("mx.example.org");
  });

  test("the list carries the state for the owning key only", async () => {
    const own = await readJson(await apiGet("/api/v1/emails", ownerKey.rawKey));
    expect(JSON.stringify(own)).toContain('"deliveryState":[{"mx"');
    const other = await readJson(await apiGet("/api/v1/emails", otherKey.rawKey));
    expect(JSON.stringify(other)).not.toContain("mx.example.org");
  });
});

describe("dashboard email detail: delivery by MX (#250)", () => {
  test("renders the table escaped, with the plaintext badge", async () => {
    const res = await dashboardGet(`/dashboard/emails/${emailId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Delivery by MX");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.example");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Sent without TLS");
  });
});

describe("stats: bounce rate (#250)", () => {
  /** 45 sent, 3 failed, 2 bounced (the seeded email above is sent). */
  async function seedTerminal(): Promise<void> {
    for (let i = 0; i < 44; i++)
      await seed.email({ apiKeyId: ownerKey.id, status: "sent" });
    for (let i = 0; i < 3; i++)
      await seed.email({ apiKeyId: ownerKey.id, status: "failed" });
    for (let i = 0; i < 2; i++)
      await seed.email({ apiKeyId: otherKey.id, status: "bounced" });
  }

  test("counts bounced rows and computes both rates", async () => {
    await seedTerminal();
    const stats = await getDashboardStats();
    expect(stats.sentCount).toBe(45);
    expect(stats.failedCount).toBe(3);
    expect(stats.bouncedCount).toBe(2);
    expect(stats.bouncedLast24h).toBe(2);
    expect(stats.successRate).toBeCloseTo(45 / 50, 10);
    expect(stats.bounceRate).toBeCloseTo(2 / 47, 10);
  });

  test("the home page shows the bounce rate with the warning above 2%", async () => {
    await seedTerminal();
    const res = await dashboardGet("/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Bounce Rate");
    expect(html).toContain(`${((2 / 47) * 100).toFixed(1)}%`);
    expect(html).toContain("remove bounced and stale addresses from your lists");
  });

  test("no bounces: rate 0.0%, no warning", async () => {
    const stats = await getDashboardStats();
    expect(stats.bouncedCount).toBe(0);
    expect(stats.bounceRate).toBe(0);
    const html = await (await dashboardGet("/dashboard")).text();
    expect(html).toContain("0.0%");
    expect(html).not.toContain("stale addresses");
  });
});
