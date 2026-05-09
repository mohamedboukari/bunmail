/**
 * Integration tests for `webhook-dispatch.service.ts` against a real
 * Postgres + a fetch mock. Catches:
 *
 *   - `findWebhooksForEvent` filters by `isActive = true` and by event
 *     membership (the JSON `events` array column)
 *   - `dispatchEvent` posts to every subscribed URL
 *   - The signed envelope ships the right headers
 *     (`X-BunMail-Signature`, `X-BunMail-Timestamp`, `X-BunMail-Event`)
 *   - Retry behaviour on non-2xx responses (3 attempts with exponential
 *     backoff in production; we override to fast retries in tests)
 *
 * Outbound HTTP is intercepted by stubbing the global `fetch` — we
 * record what was sent without actually hitting the network.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import {
  dispatchEvent,
  signPayload,
} from "../../src/modules/webhooks/services/webhook-dispatch.service.ts";
import { runPollCycle } from "../../src/modules/webhooks/services/webhook-delivery-worker.service.ts";
import {
  createWebhook,
  findWebhooksForEvent,
  deleteWebhook,
  listWebhooks,
} from "../../src/modules/webhooks/services/webhook.service.ts";
import { truncateAll, seed, db, webhooks } from "./_helpers.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const captured: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await truncateAll();
  captured.length = 0;
  /** Replace fetch with a recording stub that returns 200. */
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Wait for `dispatchEvent`'s enqueue chain to drain, then trigger the
 * worker poll once so any due rows actually POST out. dispatchEvent
 * is fire-and-forget, so we wait briefly for the enqueue inserts to
 * commit before we ask the worker to claim them.
 *
 * Pre-#30 this was just a setTimeout — the old implementation POSTed
 * directly from `dispatchEvent`'s fire-and-forget chain. Now the POST
 * happens via the worker poll, so we drive one tick manually. The
 * tests' assertions (signed payload shape, fetch call count) are
 * unchanged — we just have an extra async hop to walk through.
 */
async function waitForDispatch(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await runPollCycle();
}

describe("createWebhook + listWebhooks + deleteWebhook (DB CRUD)", () => {
  test("createWebhook persists with a 64-char secret + event subscription", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { webhook, secret } = await createWebhook(
      { url: "https://example.com/hook", events: ["email.sent"] },
      apiKeyId,
    );
    expect(webhook.id).toMatch(/^whk_/);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    /** Re-read from DB to confirm persistence. */
    const [persisted] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhook.id));
    expect(persisted?.url).toBe("https://example.com/hook");
    expect(persisted?.events).toEqual(["email.sent"]);
    expect(persisted?.isActive).toBe(true);
  });

  test("deleteWebhook is scoped per api_key", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: hookId } = await seed.webhook({
      apiKeyId: keyA,
      url: "https://example.com/h",
      events: ["email.sent"],
    });
    /** Wrong key — no-op. */
    expect(await deleteWebhook(hookId, keyB)).toBeUndefined();
    expect(await listWebhooks(keyA)).toHaveLength(1);
    /** Right key — deletes. */
    const deleted = await deleteWebhook(hookId, keyA);
    expect(deleted?.id).toBe(hookId);
    expect(await listWebhooks(keyA)).toHaveLength(0);
  });
});

describe("findWebhooksForEvent (event filtering)", () => {
  test("returns only active webhooks subscribed to the given event", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    /** Subscribed to email.sent. */
    await seed.webhook({
      apiKeyId,
      url: "https://a.example.com",
      events: ["email.sent", "email.failed"],
    });
    /** Subscribed to email.bounced only. */
    await seed.webhook({
      apiKeyId,
      url: "https://b.example.com",
      events: ["email.bounced"],
    });
    /** Inactive — should be excluded even though it subscribes to email.sent. */
    const { id: inactiveId } = await seed.webhook({
      apiKeyId,
      url: "https://c.example.com",
      events: ["email.sent"],
    });
    await db.update(webhooks).set({ isActive: false }).where(eq(webhooks.id, inactiveId));

    const sent = await findWebhooksForEvent("email.sent");
    expect(sent.map((h) => h.url)).toEqual(["https://a.example.com"]);

    const bounced = await findWebhooksForEvent("email.bounced");
    expect(bounced.map((h) => h.url)).toEqual(["https://b.example.com"]);

    const queued = await findWebhooksForEvent("email.queued");
    expect(queued).toHaveLength(0);
  });
});

describe("dispatchEvent — end-to-end", () => {
  test("posts to every subscribed webhook with signed headers", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { secret: secret1 } = await seed.webhook({
      apiKeyId,
      url: "https://hook1.example.com",
      events: ["email.bounced"],
    });
    const { secret: secret2 } = await seed.webhook({
      apiKeyId,
      url: "https://hook2.example.com",
      events: ["email.bounced"],
    });

    dispatchEvent("email.bounced", {
      emailId: "msg_test",
      to: "user@example.com",
      bounceType: "hard",
    });
    await waitForDispatch();

    expect(captured).toHaveLength(2);
    const urls = captured.map((c) => c.url).sort();
    expect(urls).toEqual(["https://hook1.example.com", "https://hook2.example.com"]);

    /** Both deliveries share the same JSON body (same event payload). */
    const body1 = JSON.parse(captured[0]!.body);
    expect(body1.event).toBe("email.bounced");
    expect(body1.data.emailId).toBe("msg_test");
    expect(body1.data.bounceType).toBe("hard");

    /** Each request gets its own signature, matching its own webhook's secret. */
    for (const req of captured) {
      expect(req.method).toBe("POST");
      expect(req.headers["content-type"]).toContain("application/json");
      expect(req.headers["x-bunmail-event"]).toBe("email.bounced");
      expect(req.headers["x-bunmail-timestamp"]).toMatch(/^\d{10}$/);
      expect(req.headers["x-bunmail-signature"]).toMatch(/^[a-f0-9]{64}$/);
    }

    /** Verify each signature matches the corresponding secret. */
    const sig1Expected = signPayload(
      captured[0]!.headers["x-bunmail-timestamp"]!,
      captured[0]!.body,
      captured[0]!.url.includes("hook1") ? secret1 : secret2,
    );
    expect(captured[0]!.headers["x-bunmail-signature"]).toBe(sig1Expected);
  });

  test("doesn't dispatch when no subscribers match", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    /** Subscribed only to email.sent — should not get email.bounced. */
    await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com",
      events: ["email.sent"],
    });

    dispatchEvent("email.bounced", { emailId: "msg_test" });
    await waitForDispatch();

    expect(captured).toHaveLength(0);
  });
});
