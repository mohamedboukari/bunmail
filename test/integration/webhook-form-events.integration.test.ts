/**
 * The dashboard webhook create form (#425), against a real Postgres: the
 * POST behind the form accepts every event the form now lists (it renders
 * one checkbox per `WEBHOOK_EVENT_TYPES` entry), including
 * `email.complained` and `email.received`, which the old hand-written list
 * missed. The admin-only rule for inbound and domain events is unchanged.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { WEBHOOK_EVENT_TYPES } from "../../src/modules/webhooks/types/webhook.types.ts";
import { truncateAll, seed, db, webhooks } from "./_helpers.ts";

const dashboard = new Elysia().use(pagesPlugin);

/** A public IP literal: passes the SSRF guard without a DNS lookup. */
const HOOK_URL = "https://93.184.216.34/hook";

/**
 * Posts the create form as a browser does: one `events` field per ticked
 * checkbox, so several events arrive as repeated keys.
 */
function postForm(token: string, events: readonly string[]): Promise<Response> {
  const body = new URLSearchParams({ url: HOOK_URL });
  for (const event of events) body.append("events", event);
  return dashboard.handle(
    new Request("http://localhost/dashboard/webhooks", {
      method: "POST",
      headers: {
        cookie: `bm_session=${token}`,
        origin: "http://localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    }),
  );
}

/** The events stored on the one webhook created at `HOOK_URL`. */
async function storedEvents(): Promise<unknown> {
  const [hook] = await db
    .select({ events: webhooks.events })
    .from(webhooks)
    .where(eq(webhooks.url, HOOK_URL));
  return hook?.events;
}

/** The decoded redirect target of a form POST. */
function locationOf(response: Response): string {
  return decodeURIComponent(response.headers.get("location") ?? "");
}

/** A signed-in owner's session token: the owner may create webhooks. */
async function ownerToken(): Promise<string> {
  const { id } = await seed.owner({ email: "owner@example.com" });
  return (await seed.session({ userId: id })).token;
}

beforeEach(async () => {
  await truncateAll();
});

describe("dashboard webhook create form (#425)", () => {
  test("the form lists every event type", async () => {
    const token = await ownerToken();
    const response = await dashboard.handle(
      new Request("http://localhost/dashboard/webhooks", {
        headers: { cookie: `bm_session=${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const event of WEBHOOK_EVENT_TYPES) {
      expect(html).toContain(`value="${event}"`);
    }
  });

  test("with an admin key, every listed event can be subscribed to at once", async () => {
    const token = await ownerToken();
    await seed.apiKey({ name: "admin key", isAdmin: true });

    const response = await postForm(token, WEBHOOK_EVENT_TYPES);
    expect(response.status).toBe(302);
    expect(locationOf(response)).not.toContain("flashType=error");
    expect(await storedEvents()).toEqual([...WEBHOOK_EVENT_TYPES]);
  });

  test("email.complained alone works on a regular key", async () => {
    const token = await ownerToken();
    await seed.apiKey({ name: "regular key" });

    const response = await postForm(token, ["email.complained"]);
    expect(locationOf(response)).toContain("Webhook created");
    expect(await storedEvents()).toEqual(["email.complained"]);
  });

  test("email.received on a regular key is still refused as admin-only", async () => {
    const token = await ownerToken();
    await seed.apiKey({ name: "regular key" });

    const response = await postForm(token, ["email.received"]);
    expect(locationOf(response)).toContain("flashType=error");
    expect(await storedEvents()).toBeUndefined();
  });
});
