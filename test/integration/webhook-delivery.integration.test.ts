/**
 * Integration tests for the persisted webhook delivery queue (#30).
 *
 * Covers the full end-to-end flow that replaced the in-memory retry
 * loop: enqueue → claim → deliver → reschedule on failure → terminate
 * at `failed` after the cap → replay flips back to `pending`.
 *
 * Outbound HTTP is intercepted by stubbing `globalThis.fetch` — same
 * pattern as `webhook-dispatch.integration.test.ts` and
 * `inbound-bounce-flow.integration.test.ts`. Each test installs its
 * own scripted handler so we can drive 2xx vs 5xx vs network-error
 * deterministically without timing-dependent retries.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import {
  enqueueDelivery,
  claimDueDeliveries,
  recordAttempt,
  performHttpAttempt,
  replayDelivery,
  getDeliveryById,
  listDeliveriesForWebhook,
  purgeOldDeliveries,
  RETRY_BACKOFF_MINUTES,
} from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { runPollCycle } from "../../src/modules/webhooks/services/webhook-delivery-worker.service.ts";
import { truncateAll, seed, db } from "./_helpers.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { webhooks } from "../../src/modules/webhooks/models/webhook.schema.ts";

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Helper: reusable scripted-fetch installer. */
function installFetch(handler: (req: Request) => Promise<Response> | Response) {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const req =
      input instanceof Request
        ? input
        : new Request(typeof input === "string" ? input : input.toString(), init);
    return handler(req);
  }) as unknown as typeof fetch;
}

/** Build a small standard envelope for tests. */
function envelope(event: "email.sent" | "email.bounced" = "email.sent") {
  return {
    event,
    timestamp: "2026-05-10T12:00:00.000Z",
    data: { emailId: "msg_test", to: "user@example.com" },
  } as const;
}

describe("enqueueDelivery — initial state", () => {
  test("inserts a pending row with attempts=0 and next_attempt_at=now-ish", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });

    const before = Date.now();
    const { id } = await enqueueDelivery({ webhookId, envelope: envelope() });
    const after = Date.now();

    expect(id).toMatch(/^wdl_/);

    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.event).toBe("email.sent");
    /** Body bytes are stored verbatim — re-signed per attempt by the worker. */
    expect(JSON.parse(row!.payload)).toEqual(envelope());
    /** `next_attempt_at` should be set to ~now (defaultNow). */
    const nextMs = row!.nextAttemptAt.getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before - 500);
    expect(nextMs).toBeLessThanOrEqual(after + 500);
  });
});

describe("worker poll cycle — happy path (2xx response → delivered)", () => {
  test("delivers and marks status=delivered with deliveredAt set", async () => {
    const captured: Array<{ url: string; body: string; headers: Headers }> = [];
    installFetch(async (req) => {
      captured.push({ url: req.url, body: await req.text(), headers: req.headers });
      return new Response("ok", { status: 200 });
    });

    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
      secret: "unit-test-secret",
    });
    const { id: deliveryId } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });

    const result = await runPollCycle();
    expect(result.claimed).toBe(1);

    /** Captured one HTTP request with the right shape. */
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://hook.example.com/x");
    expect(captured[0]?.headers.get("x-bunmail-event")).toBe("email.sent");
    expect(captured[0]?.headers.get("x-bunmail-signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(captured[0]?.headers.get("x-bunmail-timestamp")).toMatch(/^\d{10}$/);

    const row = await getDeliveryById({ deliveryId, apiKeyId });
    expect(row?.status).toBe("delivered");
    expect(row?.attempts).toBe(1);
    expect(row?.lastResponseStatus).toBe(200);
    expect(row?.deliveredAt).not.toBeNull();
  });
});

describe("worker poll cycle — non-2xx response reschedules with backoff", () => {
  test("first failure: status stays pending, attempts=1, next_attempt_at advanced 1m", async () => {
    installFetch(() => new Response("server error", { status: 500 }));

    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const before = Date.now();
    const { id: deliveryId } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });

    await runPollCycle();

    const row = await getDeliveryById({ deliveryId, apiKeyId });
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.lastResponseStatus).toBe(500);
    expect(row?.lastError).toContain("HTTP 500");
    /** Should be scheduled ~1 minute from now (RETRY_BACKOFF_MINUTES[0]). */
    const expectedNextMs = before + RETRY_BACKOFF_MINUTES[0]! * 60_000;
    expect(Math.abs(row!.nextAttemptAt.getTime() - expectedNextMs)).toBeLessThan(5_000);
  });

  test("network error path: status pending, lastError captured, response status null", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const { id: deliveryId } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });

    await runPollCycle();

    const row = await getDeliveryById({ deliveryId, apiKeyId });
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.lastResponseStatus).toBeNull();
    expect(row?.lastError).toContain("ECONNREFUSED");
  });
});

describe("worker poll cycle — exhausting retries flips status=failed", () => {
  test("after MAX_DELIVERY_ATTEMPTS failures, row terminates at failed", async () => {
    installFetch(() => new Response("nope", { status: 500 }));

    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const { id: deliveryId } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });

    /** Step the worker forward one attempt at a time. After each attempt
     *  we shove `next_attempt_at` back to now() so the next runPollCycle
     *  picks it up — saves us waiting through real backoff in tests. */
    for (let i = 0; i < 5; i++) {
      await runPollCycle();
      await db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(webhookDeliveries.id, deliveryId));
    }

    const row = await getDeliveryById({ deliveryId, apiKeyId });
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(5);
    expect(row?.lastResponseStatus).toBe(500);
  });
});

describe("worker poll cycle — only claims due rows", () => {
  test("future-scheduled rows are NOT claimed", async () => {
    let calls = 0;
    installFetch(() => {
      calls++;
      return new Response("ok", { status: 200 });
    });

    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const { id: dueId } = await enqueueDelivery({ webhookId, envelope: envelope() });
    const { id: futureId } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });
    /** Push the future row 30 minutes ahead. */
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(webhookDeliveries.id, futureId));

    const result = await runPollCycle();

    expect(result.claimed).toBe(1);
    expect(calls).toBe(1);
    expect((await getDeliveryById({ deliveryId: dueId, apiKeyId }))?.status).toBe(
      "delivered",
    );
    expect((await getDeliveryById({ deliveryId: futureId, apiKeyId }))?.status).toBe(
      "pending",
    );
  });
});

describe("worker poll cycle — concurrent workers see disjoint claims", () => {
  test("two parallel poll cycles claim distinct rows (FOR UPDATE SKIP LOCKED)", async () => {
    /** All requests succeed — we just want to verify no row is double-claimed. */
    installFetch(() => new Response("ok", { status: 200 }));

    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const { id } = await enqueueDelivery({ webhookId, envelope: envelope() });
      ids.push(id);
    }

    /** Fire 4 concurrent poll cycles; total demand (4 × 25 = 100) far
     *  exceeds supply (30), so we should claim exactly 30 across all
     *  workers with no duplicates. */
    const results = await Promise.all([
      runPollCycle(),
      runPollCycle(),
      runPollCycle(),
      runPollCycle(),
    ]);

    const totalClaimed = results.reduce((sum, r) => sum + r.claimed, 0);
    expect(totalClaimed).toBe(30);

    /** All 30 rows transitioned to delivered (each was claimed exactly once). */
    const allRows = await db.select().from(webhookDeliveries);
    expect(allRows.every((r) => r.status === "delivered")).toBe(true);
    expect(allRows.every((r) => r.attempts === 1)).toBe(true);
  });
});

describe("worker poll cycle — webhook deactivated after enqueue is skipped + marked failed", () => {
  test("inactive webhook → row terminates at failed without HTTP attempt", async () => {
    let calls = 0;
    installFetch(() => {
      calls++;
      return new Response("ok", { status: 200 });
    });

    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const { id: deliveryId } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });
    /** Operator deactivated the hook between enqueue and delivery. */
    await db.update(webhooks).set({ isActive: false }).where(eq(webhooks.id, webhookId));

    await runPollCycle();

    expect(calls).toBe(0);
    const row = await getDeliveryById({ deliveryId, apiKeyId });
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("inactive");
  });
});

describe("replayDelivery — resets a failed row to pending", () => {
  test("flips status, zeroes attempts, sets next_attempt_at to now", async () => {
    installFetch(() => new Response("nope", { status: 500 }));

    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const { id: deliveryId } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });

    /** Burn through all retries to land on `failed`. */
    for (let i = 0; i < 5; i++) {
      await runPollCycle();
      await db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(webhookDeliveries.id, deliveryId));
    }
    let row = await getDeliveryById({ deliveryId, apiKeyId });
    expect(row?.status).toBe("failed");

    /** Replay. */
    const before = Date.now();
    const replayed = await replayDelivery({ deliveryId, apiKeyId });
    expect(replayed?.status).toBe("pending");
    expect(replayed?.attempts).toBe(0);
    expect(replayed?.lastError).toBeNull();
    expect(replayed?.deliveredAt).toBeNull();
    expect(replayed!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 100);

    /** Now have the worker pick it up — this time the receiver responds 200. */
    installFetch(() => new Response("ok", { status: 200 }));
    await runPollCycle();
    row = await getDeliveryById({ deliveryId, apiKeyId });
    expect(row?.status).toBe("delivered");
    expect(row?.attempts).toBe(1);
  });

  test("returns undefined for delivery the api key doesn't own", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId: keyA,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const { id: deliveryId } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });

    expect(await replayDelivery({ deliveryId, apiKeyId: keyB })).toBeUndefined();
  });
});

describe("listDeliveriesForWebhook — pagination + status filter + tenant scoping", () => {
  test("scopes to the calling api key; foreign keys see empty result", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: hookA } = await seed.webhook({
      apiKeyId: keyA,
      url: "https://a.example.com",
      events: ["email.sent"],
    });
    await enqueueDelivery({ webhookId: hookA, envelope: envelope() });

    /** Owner sees the row. */
    const ownerView = await listDeliveriesForWebhook({
      webhookId: hookA,
      apiKeyId: keyA,
      page: 1,
      limit: 20,
    });
    expect(ownerView.total).toBe(1);

    /** A different api key sees nothing — even with the right webhook id. */
    const strangerView = await listDeliveriesForWebhook({
      webhookId: hookA,
      apiKeyId: keyB,
      page: 1,
      limit: 20,
    });
    expect(strangerView.total).toBe(0);
    expect(strangerView.data).toHaveLength(0);
  });

  test("filters by status and paginates", async () => {
    installFetch(() => new Response("ok", { status: 200 }));
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });

    /** 3 enqueued, 1 delivered, 2 still pending. */
    const enqueued: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await enqueueDelivery({ webhookId, envelope: envelope() });
      enqueued.push(id);
    }
    /** Push two of them into the future so runPollCycle only takes one. */
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(webhookDeliveries.id, enqueued[1]!));
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(webhookDeliveries.id, enqueued[2]!));

    await runPollCycle();

    const allRows = await listDeliveriesForWebhook({
      webhookId,
      apiKeyId,
      page: 1,
      limit: 20,
    });
    expect(allRows.total).toBe(3);

    const deliveredOnly = await listDeliveriesForWebhook({
      webhookId,
      apiKeyId,
      status: "delivered",
      page: 1,
      limit: 20,
    });
    expect(deliveredOnly.total).toBe(1);
    expect(deliveredOnly.data[0]?.status).toBe("delivered");

    const pendingOnly = await listDeliveriesForWebhook({
      webhookId,
      apiKeyId,
      status: "pending",
      page: 1,
      limit: 20,
    });
    expect(pendingOnly.total).toBe(2);
  });
});

describe("purgeOldDeliveries — retention cleanup", () => {
  test("deletes only delivered rows older than the cutoff; failed kept indefinitely", async () => {
    installFetch(() => new Response("ok", { status: 200 }));
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    const { id: oldDelivered } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });
    const { id: newDelivered } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });
    /** Run the worker so both transition to delivered. */
    await runPollCycle();

    /** Backdate one of them — pretend it was created 60 days ago. */
    await db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })
      .where(eq(webhookDeliveries.id, oldDelivered));

    /** Also seed a failed row that's old — should NOT be purged. */
    installFetch(() => new Response("nope", { status: 500 }));
    const { id: oldFailed } = await enqueueDelivery({
      webhookId,
      envelope: envelope(),
    });
    for (let i = 0; i < 5; i++) {
      await runPollCycle();
      await db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(webhookDeliveries.id, oldFailed));
    }
    await db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })
      .where(eq(webhookDeliveries.id, oldFailed));

    /** Run cleanup with a 30-day cutoff. */
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await purgeOldDeliveries({ olderThan: cutoff });
    expect(result.deleted).toBe(1);

    /** The old delivered row is gone; the new one survives; the failed one survives. */
    expect(await getDeliveryById({ deliveryId: oldDelivered, apiKeyId })).toBeUndefined();
    expect(await getDeliveryById({ deliveryId: newDelivered, apiKeyId })).toBeDefined();
    expect(await getDeliveryById({ deliveryId: oldFailed, apiKeyId })).toBeDefined();
  });
});

describe("performHttpAttempt — re-signs per attempt", () => {
  test("two attempts ship two distinct signing timestamps", async () => {
    const captured: Array<{ ts: string; sig: string }> = [];
    installFetch((req) => {
      captured.push({
        ts: req.headers.get("x-bunmail-timestamp") ?? "",
        sig: req.headers.get("x-bunmail-signature") ?? "",
      });
      return new Response("ok", { status: 200 });
    });

    /** Two back-to-back attempts. We can't make Date.now() advance
     *  reliably inside a tight loop, but we can advance our perceived
     *  clock by sleeping ~1.1s between calls so the unix-second
     *  timestamps differ. */
    await performHttpAttempt({
      url: "https://hook.example.com/x",
      secret: "s",
      body: "{}",
      event: "email.sent",
    });
    await new Promise((r) => setTimeout(r, 1_100));
    await performHttpAttempt({
      url: "https://hook.example.com/x",
      secret: "s",
      body: "{}",
      event: "email.sent",
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]?.ts).not.toBe(captured[1]?.ts);
    /** Different timestamps with the same body+secret → different signatures. */
    expect(captured[0]?.sig).not.toBe(captured[1]?.sig);
  });
});

describe("CASCADE on webhook delete — deliveries vanish too", () => {
  test("deleting the webhook cascades and deletes all its deliveries", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/x",
      events: ["email.sent"],
    });
    for (let i = 0; i < 3; i++) {
      await enqueueDelivery({ webhookId, envelope: envelope() });
    }

    expect(
      (
        await listDeliveriesForWebhook({
          webhookId,
          apiKeyId,
          page: 1,
          limit: 20,
        })
      ).total,
    ).toBe(3);

    await db.delete(webhooks).where(eq(webhooks.id, webhookId));

    /** Deliveries for the now-gone webhook are also gone. */
    const remaining = await db.select().from(webhookDeliveries);
    expect(remaining).toHaveLength(0);
  });
});

describe("claimDueDeliveries — direct call (sanity)", () => {
  test("returns hydrated rows with url + secret joined in", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://specific-target.example/path",
      events: ["email.sent"],
      secret: "specific-secret",
    });
    const { id: deliveryId } = await enqueueDelivery({
      webhookId,
      envelope: envelope("email.bounced"),
    });

    const claimed = await claimDueDeliveries(10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(deliveryId);
    expect(claimed[0]?.url).toBe("https://specific-target.example/path");
    expect(claimed[0]?.secret).toBe("specific-secret");
    expect(claimed[0]?.event).toBe("email.bounced");
    /** Claim doesn't bump attempts; that's recordAttempt's job. */
    expect(claimed[0]?.attempts).toBe(0);

    /** recordAttempt: simulate a 200. */
    await recordAttempt({
      deliveryId,
      outcome: { ok: true, status: 200, error: null, bodyPreview: "ok" },
      priorAttempts: 0,
    });
    const row = await getDeliveryById({ deliveryId, apiKeyId });
    expect(row?.status).toBe("delivered");
    expect(row?.attempts).toBe(1);
  });
});
