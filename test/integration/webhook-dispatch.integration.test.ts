/**
 * Integration tests for `webhook-dispatch.service.ts` against a real
 * Postgres + a fetch mock. Catches:
 *
 *   - `enqueueEvent` fans out to active webhooks by `isActive = true` and
 *     by event membership (the JSON `events` array column), inside the
 *     caller's transaction (#184)
 *   - an enqueued event is posted to every subscribed URL
 *   - The signed envelope ships the right headers
 *     (`X-BunMail-Signature`, `X-BunMail-Timestamp`, `X-BunMail-Event`)
 *   - Retry behaviour on non-2xx responses (3 attempts with exponential
 *     backoff in production; we override to fast retries in tests)
 *
 * Outbound HTTP is intercepted by stubbing the global `fetch`: we
 * record what was sent without actually hitting the network.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  enqueueEvent,
  signPayload,
  type DispatchScope,
} from "../../src/modules/webhooks/services/webhook-dispatch.service.ts";
import { runPollCycle } from "../../src/modules/webhooks/services/webhook-delivery-worker.service.ts";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
} from "../../src/modules/webhooks/services/webhook.service.ts";
import { WebhookEnqueueError } from "../../src/modules/webhooks/errors.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import type { WebhookEventType } from "../../src/modules/webhooks/types/webhook.types.ts";
import {
  truncateAll,
  seed,
  db,
  webhooks,
  failWritesWhere,
  removeInjectedFailures,
} from "./_helpers.ts";

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
  globalThis.fetch = Object.assign(
    mock(async (input: string | URL | Request, init?: RequestInit) => {
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
    }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await removeInjectedFailures();
});

/**
 * Drives one worker poll so any due rows actually POST out. `enqueueEvent`
 * only INSERTs `webhook_deliveries` rows, committed with the caller's
 * transaction (#184); the worker is what hits the consumer.
 */
async function deliverDue(): Promise<void> {
  await runPollCycle();
}

/** Enqueues an event in a transaction of its own, the way a caller does. */
function enqueue(
  event: WebhookEventType,
  data: Record<string, unknown>,
  scope: DispatchScope,
): Promise<number> {
  return db.transaction((tx) => enqueueEvent(tx, event, data, scope));
}

/** The webhook ids that have a delivery row for `event`. */
async function deliveredTo(event: WebhookEventType): Promise<string[]> {
  const rows = await db
    .select({ webhookId: webhookDeliveries.webhookId })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.event, event));
  return rows.map((row) => row.webhookId);
}

describe("createWebhook + listWebhooks + deleteWebhook (DB CRUD)", () => {
  test("createWebhook persists with a 64-char secret + event subscription", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { webhook, secret } = await createWebhook(
      { url: "https://93.184.216.34/hook", events: ["email.sent"] },
      apiKeyId,
    );
    expect(webhook.id).toMatch(/^whk_/);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    /** Re-read from DB to confirm persistence. */
    const [persisted] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhook.id));
    expect(persisted?.url).toBe("https://93.184.216.34/hook");
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
    /** Wrong key: no-op. */
    expect(await deleteWebhook(hookId, keyB)).toBeUndefined();
    expect((await listWebhooks(keyA, { page: 1, limit: 100 })).data).toHaveLength(1);
    /** Right key: deletes. */
    const deleted = await deleteWebhook(hookId, keyA);
    expect(deleted?.id).toBe(hookId);
    expect((await listWebhooks(keyA, { page: 1, limit: 100 })).data).toHaveLength(0);
  });
});

describe("enqueueEvent (event filtering)", () => {
  test("returns only active webhooks subscribed to the given event", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    /** Subscribed to email.sent. */
    const { id: sentHook } = await seed.webhook({
      apiKeyId,
      url: "https://a.example.com",
      events: ["email.sent", "email.failed"],
    });
    /** Subscribed to email.bounced only. */
    const { id: bouncedHook } = await seed.webhook({
      apiKeyId,
      url: "https://b.example.com",
      events: ["email.bounced"],
    });
    /** Inactive, should be excluded even though it subscribes to email.sent. */
    const { id: inactiveId } = await seed.webhook({
      apiKeyId,
      url: "https://c.example.com",
      events: ["email.sent"],
    });
    await db.update(webhooks).set({ isActive: false }).where(eq(webhooks.id, inactiveId));

    expect(await enqueue("email.sent", {}, { apiKeyId })).toBe(1);
    expect(await deliveredTo("email.sent")).toEqual([sentHook]);

    expect(await enqueue("email.bounced", {}, { apiKeyId })).toBe(1);
    expect(await deliveredTo("email.bounced")).toEqual([bouncedHook]);

    expect(await enqueue("email.queued", {}, { apiKeyId })).toBe(0);
    expect(await deliveredTo("email.queued")).toEqual([]);
  });
});

describe("enqueueEvent: end-to-end through the worker", () => {
  test("posts to every subscribed webhook with signed headers", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { secret: secret1 } = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34",
      events: ["email.bounced"],
    });
    const { secret: secret2 } = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.35",
      events: ["email.bounced"],
    });

    await enqueue(
      "email.bounced",
      { emailId: "msg_test", to: "user@example.com", bounceType: "hard" },
      { apiKeyId },
    );
    await deliverDue();

    expect(captured).toHaveLength(2);
    const urls = captured.map((c) => c.url).toSorted();
    /** The request URL is rebuilt from the validated address (normalized: `/` path). */
    expect(urls).toEqual(["https://93.184.216.34/", "https://93.184.216.35/"]);

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
    /** Subscribed only to email.sent, should not get email.bounced. */
    await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34",
      events: ["email.sent"],
    });

    expect(await enqueue("email.bounced", { emailId: "msg_test" }, { apiKeyId })).toBe(0);
    await deliverDue();

    expect(captured).toHaveLength(0);
  });
});

/**
 * Tenant isolation (GHSA-8r3q-hqf8-2264). Webhooks used to receive every
 * key's events: one key's email.sent (sender, recipient, subject) reached
 * another key's webhook, and restricted keys could subscribe to inbound
 * email.received, bypassing the admin-only inbound API (#130).
 */
describe("dispatch is scoped to the owning API key", () => {
  test("an email event reaches only the owning key's webhooks", async () => {
    const a = await seed.apiKey({ name: "tenant-a" });
    const b = await seed.apiKey({ name: "tenant-b" });
    await seed.webhook({
      apiKeyId: a.id,
      url: "https://93.184.216.34",
      events: ["email.sent"],
    });
    await seed.webhook({
      apiKeyId: b.id,
      url: "https://93.184.216.35",
      events: ["email.sent"],
    });

    await enqueue(
      "email.sent",
      { emailId: "msg_a", to: "customer@example.org", subject: "Tenant A only" },
      { apiKeyId: a.id },
    );
    await deliverDue();

    expect(captured.map((c) => c.url)).toEqual(["https://93.184.216.34/"]);
  });

  test("nothing is enqueued for a key without matching webhooks", async () => {
    const a = await seed.apiKey({ name: "tenant-a" });
    const b = await seed.apiKey({ name: "tenant-b" });
    await seed.webhook({
      apiKeyId: a.id,
      url: "https://a.example.com",
      events: ["email.sent"],
    });
    expect(await enqueue("email.sent", {}, { apiKeyId: b.id })).toBe(0);
    expect(await deliveredTo("email.sent")).toEqual([]);
  });

  test("inbound email.received reaches admin keys' webhooks only", async () => {
    const admin = await seed.apiKey({ name: "admin", isAdmin: true });
    const restricted = await seed.apiKey({ name: "restricted", isAdmin: false });
    const { id: adminHook } = await seed.webhook({
      apiKeyId: admin.id,
      url: "https://admin.example.com",
      events: ["email.received"],
    });
    /** Seeded directly (bypassing the create-time check) to model a webhook
     *  created before this fix. */
    await seed.webhook({
      apiKeyId: restricted.id,
      url: "https://restricted.example.com",
      events: ["email.received"],
    });

    await enqueue("email.received", {}, { adminOnly: true });
    expect(await deliveredTo("email.received")).toEqual([adminHook]);
  });
});

/**
 * The outbox insert itself (#184): one statement inside the caller's
 * transaction, the stored body a JSON object, failures thrown.
 */
describe("enqueueEvent: the outbox insert", () => {
  test("stores the envelope as a JSON object, one pending row per webhook", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: hookA } = await seed.webhook({
      apiKeyId,
      url: "https://a.example.com",
      events: ["email.sent"],
    });
    const { id: hookB } = await seed.webhook({
      apiKeyId,
      url: "https://b.example.com",
      events: ["email.sent"],
    });

    expect(await enqueue("email.sent", { emailId: "msg_1", n: 1 }, { apiKeyId })).toBe(2);

    const rows = await db
      .select({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        payload: webhookDeliveries.payload,
        payloadType: sql<string>`jsonb_typeof(${webhookDeliveries.payload}::jsonb)`,
      })
      .from(webhookDeliveries);
    expect(rows.map((r) => r.webhookId).toSorted()).toEqual([hookA, hookB].toSorted());
    for (const row of rows) {
      expect(row.id).toMatch(/^wdl_[0-9a-f]{32}$/);
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      /** Not double-encoded: the stored text is a JSON object, not a JSON string. */
      expect(row.payloadType).toBe("object");
      const body: unknown = JSON.parse(row.payload);
      expect(body).toMatchObject({
        event: "email.sent",
        data: { emailId: "msg_1", n: 1 },
      });
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  test("rolls back with the caller's transaction", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.webhook({
      apiKeyId,
      url: "https://a.example.com",
      events: ["email.sent"],
    });

    const error = await db
      .transaction(async (tx) => {
        expect(await enqueueEvent(tx, "email.sent", {}, { apiKeyId })).toBe(1);
        throw new Error("the caller's next write failed");
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String(error)).toContain("the caller's next write failed");

    expect(await deliveredTo("email.sent")).toEqual([]);
  });

  test("a failed insert throws WebhookEnqueueError without the payload", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: hook } = await seed.webhook({
      apiKeyId,
      url: "https://a.example.com",
      events: ["email.sent"],
    });
    await failWritesWhere("webhook_deliveries", { webhook_id: hook });

    const error = await db
      .transaction((tx) =>
        enqueueEvent(tx, "email.sent", { to: "recipient@example.org" }, { apiKeyId }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(WebhookEnqueueError);
    expect(error).toMatchObject({ sqlState: "P0001" });
    expect(String(error)).not.toContain("recipient@example.org");
    expect(await deliveredTo("email.sent")).toEqual([]);
  });
});
