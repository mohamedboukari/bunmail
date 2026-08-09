/**
 * Integration tests for the webhook SSRF guard (#128) against a real
 * Postgres + real config. Uses literal IPs (no DNS) so it's deterministic.
 * Covers: rejection at create, and re-validation (+ no fetch, + manual
 * redirect) at delivery time.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createWebhook } from "../../src/modules/webhooks/services/webhook.service.ts";
import { performHttpAttempt } from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { BlockedUrlError } from "../../src/utils/ssrf-guard.ts";
import { truncateAll, seed, db } from "./_helpers.ts";
import { webhooks } from "../../src/modules/webhooks/models/webhook.schema.ts";

beforeEach(async () => {
  await truncateAll();
});

describe("createWebhook — SSRF guard", () => {
  test("rejects cloud-metadata / private / loopback URLs (nothing stored)", async () => {
    const { id: apiKeyId } = await seed.apiKey({ isAdmin: true });

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/hook",
      "https://127.0.0.1/hook",
    ]) {
      await expect(
        createWebhook({ url, events: ["email.sent"] }, apiKeyId),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    }

    const rows = await db.select().from(webhooks).where(eq(webhooks.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(0);
  });

  test("rejects http when insecure http isn't opted in (default)", async () => {
    const { id: apiKeyId } = await seed.apiKey({ isAdmin: true });
    await expect(
      createWebhook({ url: "http://1.1.1.1/hook", events: ["email.sent"] }, apiKeyId),
    ).rejects.toThrow(/https/);
  });

  test("accepts a public https URL", async () => {
    const { id: apiKeyId } = await seed.apiKey({ isAdmin: true });
    const { webhook } = await createWebhook(
      { url: "https://1.1.1.1/hook", events: ["email.sent"] },
      apiKeyId,
    );
    expect(webhook.url).toBe("https://1.1.1.1/hook");
  });
});

describe("performHttpAttempt — delivery-time re-validation", () => {
  const base = { secret: "s", body: "{}", event: "email.sent" };

  test("does NOT fetch a blocked URL; returns a failed outcome", async () => {
    let fetchCalled = false;
    const spyFetch = (() => {
      fetchCalled = true;
      throw new Error("fetch must not be called for a blocked URL");
    }) as unknown as typeof fetch;

    const outcome = await performHttpAttempt({
      ...base,
      url: "http://169.254.169.254/latest/meta-data/",
      fetchImpl: spyFetch,
    });

    expect(fetchCalled).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/private|reserved|https/i);
  });

  test("fetches an allowed URL with redirect:'manual'", async () => {
    let seenInit: RequestInit | undefined;
    const stubFetch = ((_url: string, init: RequestInit) => {
      seenInit = init;
      return Promise.resolve(
        new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    }) as unknown as typeof fetch;

    const outcome = await performHttpAttempt({
      ...base,
      url: "https://1.1.1.1/hook",
      fetchImpl: stubFetch,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(seenInit?.redirect).toBe("manual");
  });
});
