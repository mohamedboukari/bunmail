/**
 * Per-key webhook limits (#258), over HTTP with real auth against a real
 * Postgres: the webhook cap (`WEBHOOKS_MAX_PER_API_KEY`, default 10) on
 * the REST API and the dashboard, race-safe under parallel creates; the
 * replay budget (5 per delivery per hour) on both; and the paginated
 * `GET /api/v1/webhooks` and `GET /api/v1/templates` lists.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { webhooksPlugin } from "../../src/modules/webhooks/webhooks.plugin.ts";
import { templatesPlugin } from "../../src/modules/templates/templates.plugin.ts";
import {
  ReplayLimitReachedError,
  WebhookLimitReachedError,
} from "../../src/modules/webhooks/errors.ts";
import { createWebhook } from "../../src/modules/webhooks/services/webhook.service.ts";
import { replayDelivery } from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { REPLAYS_PER_DELIVERY_PER_HOUR } from "../../src/modules/webhooks/services/replay-limit.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { config } from "../../src/config.ts";
import { generateId } from "../../src/utils/id.ts";
import { truncateAll, seed, db, webhooks } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mirrors the global onError mapping in src/index.ts for these errors. */
const api = new Elysia()
  .onError(({ error, set }) => {
    if (error instanceof WebhookLimitReachedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }
    if (error instanceof ReplayLimitReachedError) {
      set.status = error.status;
      set.headers["retry-after"] = String(error.retryAfterSec);
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(webhooksPlugin)
  .use(templatesPlugin);

const dashboard = new Elysia().use(pagesPlugin);

/** A public IP literal: passes the SSRF guard without a DNS lookup. */
const HOOK_URL = "https://93.184.216.34/hook";

const MAX = config.webhookDelivery.maxPerApiKey;

function apiCall(
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<Response> {
  return api.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function dashboardPost(path: string, token: string, body: Record<string, string>) {
  return dashboard.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        cookie: `bm_session=${token}`,
        origin: "http://localhost",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    }),
  );
}

async function seedHooks(apiKeyId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await seed.webhook({ apiKeyId, url: `${HOOK_URL}/${i}`, events: ["email.sent"] });
  }
}

async function hookCount(apiKeyId: string): Promise<number> {
  return (await db.select().from(webhooks).where(eq(webhooks.apiKeyId, apiKeyId))).length;
}

/** A `failed` delivery on a fresh webhook of `apiKeyId`. */
async function failedDelivery(apiKeyId: string): Promise<string> {
  const { id: webhookId } = await seed.webhook({
    apiKeyId,
    url: HOOK_URL,
    events: ["email.sent"],
  });
  const id = generateId("wdl");
  await db.insert(webhookDeliveries).values({
    id,
    webhookId,
    event: "email.sent",
    payload: "{}",
    status: "failed",
    attempts: 5,
  });
  return id;
}

beforeEach(async () => {
  await truncateAll();
});

describe("webhooks per API key (#258)", () => {
  test("the default cap is 10", () => {
    expect(MAX).toBe(10);
  });

  test("REST: creating one past the cap is refused with 422 WEBHOOK_LIMIT_REACHED", async () => {
    const { id, rawKey } = await seed.apiKey();
    await seedHooks(id, MAX - 1);

    const last = await apiCall("POST", "/api/v1/webhooks", rawKey, {
      url: HOOK_URL,
      events: ["email.sent"],
    });
    expect(last.status).toBe(200);

    const over = await apiCall("POST", "/api/v1/webhooks", rawKey, {
      url: HOOK_URL,
      events: ["email.sent"],
    });
    expect(over.status).toBe(422);
    const body = await readJson<{ code: string; error: string }>(over);
    expect(body.code).toBe("WEBHOOK_LIMIT_REACHED");
    expect(body.error).toContain(`maximum of ${MAX} webhooks`);
    expect(await hookCount(id)).toBe(MAX);
  });

  test("the cap is per key: another key can still create", async () => {
    const { id: full } = await seed.apiKey();
    const { rawKey: other } = await seed.apiKey();
    await seedHooks(full, MAX);

    const res = await apiCall("POST", "/api/v1/webhooks", other, {
      url: HOOK_URL,
      events: ["email.sent"],
    });
    expect(res.status).toBe(200);
  });

  test("webhooks already over the cap are kept, and listed; deleting frees a slot only below the cap", async () => {
    const { id, rawKey } = await seed.apiKey();
    await seedHooks(id, MAX + 2);

    const list = await apiCall("GET", "/api/v1/webhooks", rawKey);
    expect((await readJson<{ data: unknown[] }>(list)).data).toHaveLength(MAX + 2);

    const [first] = await db.select().from(webhooks).where(eq(webhooks.apiKeyId, id));
    await apiCall("DELETE", `/api/v1/webhooks/${first?.id}`, rawKey);
    const stillOver = await apiCall("POST", "/api/v1/webhooks", rawKey, {
      url: HOOK_URL,
      events: ["email.sent"],
    });
    expect(stillOver.status).toBe(422);
    expect(await hookCount(id)).toBe(MAX + 1);
  });

  test("parallel creates cannot overshoot the cap", async () => {
    const { id } = await seed.apiKey();
    await seedHooks(id, MAX - 2);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createWebhook({ url: HOOK_URL, events: ["email.sent"] }, id),
      ),
    );

    const created = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof WebhookLimitReachedError,
    );
    expect(created).toHaveLength(2);
    expect(refused).toHaveLength(6);
    expect(await hookCount(id)).toBe(MAX);
  });

  test("dashboard: creating one past the cap redirects with the limit message", async () => {
    const { id: ownerId } = await seed.owner({ email: "owner@example.com" });
    const { token } = await seed.session({ userId: ownerId });
    const { id } = await seed.apiKey();
    await seedHooks(id, MAX);

    const res = await dashboardPost("/dashboard/webhooks", token, {
      url: HOOK_URL,
      events: "email.sent",
    });
    expect(res.status).toBe(302);
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    expect(location).toContain("flashType=error");
    expect(location).toContain(`maximum of ${MAX} webhooks`);
    expect(await hookCount(id)).toBe(MAX);
  });
});

describe("replays per delivery (#258)", () => {
  test("REST: the 6th replay within the hour is 429 REPLAY_LIMIT_REACHED with Retry-After", async () => {
    const { id, rawKey } = await seed.apiKey();
    const deliveryId = await failedDelivery(id);
    const path = `/api/v1/webhooks/deliveries/${deliveryId}/replay`;

    for (let i = 0; i < REPLAYS_PER_DELIVERY_PER_HOUR; i++) {
      expect((await apiCall("POST", path, rawKey)).status).toBe(200);
    }
    const over = await apiCall("POST", path, rawKey);
    expect(over.status).toBe(429);
    const retryAfter = Number(over.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(3500);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect((await readJson<{ code: string }>(over)).code).toBe("REPLAY_LIMIT_REACHED");
  });

  test("allowed again once the hour has passed", async () => {
    const { id } = await seed.apiKey();
    const deliveryId = await failedDelivery(id);
    const start = Date.now();
    for (let i = 0; i < REPLAYS_PER_DELIVERY_PER_HOUR; i++) {
      await replayDelivery({ deliveryId, apiKeyId: id, now: new Date(start + i * 1000) });
    }
    const refused = await replayDelivery({
      deliveryId,
      apiKeyId: id,
      now: new Date(start + 59 * 60_000),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ReplayLimitReachedError);

    const later = await replayDelivery({
      deliveryId,
      apiKeyId: id,
      now: new Date(start + 60 * 60_000 + 1000),
    });
    expect(later?.status).toBe("pending");
  });

  test("the budget is per delivery: another delivery of the same key is unaffected", async () => {
    const { id } = await seed.apiKey();
    const first = await failedDelivery(id);
    const second = await failedDelivery(id);
    for (let i = 0; i < REPLAYS_PER_DELIVERY_PER_HOUR; i++) {
      await replayDelivery({ deliveryId: first, apiKeyId: id });
    }
    expect(await replayDelivery({ deliveryId: second, apiKeyId: id })).toBeDefined();
  });

  test("another key's attempts are 404s and never use up the owner's budget", async () => {
    const { id: owner, rawKey: ownerKey } = await seed.apiKey();
    const { rawKey: stranger } = await seed.apiKey();
    const deliveryId = await failedDelivery(owner);
    const path = `/api/v1/webhooks/deliveries/${deliveryId}/replay`;

    for (let i = 0; i < REPLAYS_PER_DELIVERY_PER_HOUR + 2; i++) {
      expect((await apiCall("POST", path, stranger)).status).toBe(404);
    }
    expect((await apiCall("POST", path, ownerKey)).status).toBe(200);
  });

  test("dashboard: the 6th replay answers 429 with Retry-After on the delivery page", async () => {
    const { id: ownerId } = await seed.owner({ email: "owner@example.com" });
    const { token } = await seed.session({ userId: ownerId });
    const { id } = await seed.apiKey();
    const deliveryId = await failedDelivery(id);
    const path = `/dashboard/webhooks/deliveries/${deliveryId}/replay`;

    for (let i = 0; i < REPLAYS_PER_DELIVERY_PER_HOUR; i++) {
      expect((await dashboardPost(path, token, {})).status).toBe(302);
    }
    const over = await dashboardPost(path, token, {});
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await over.text()).toContain("already replayed 5 times");
  });
});

interface Listed {
  data: Array<{ id: string }>;
  pagination: { page: number; limit: number; total: number };
}

describe("paginated lists (#258)", () => {
  const lists = [
    {
      path: "/api/v1/webhooks",
      seedOne: (apiKeyId: string, i: number) =>
        seed.webhook({ apiKeyId, url: `${HOOK_URL}/${i}`, events: ["email.sent"] }),
    },
    {
      path: "/api/v1/templates",
      seedOne: (apiKeyId: string, i: number) =>
        seed.template({ apiKeyId, name: `t${i}` }),
    },
  ];

  for (const { path, seedOne } of lists) {
    test(`${path}: defaults to page 1, limit 100, with the total`, async () => {
      const { id, rawKey } = await seed.apiKey();
      const { id: other } = await seed.apiKey();
      for (let i = 0; i < 3; i++) await seedOne(id, i);
      await seedOne(other, 99);

      const res = await apiCall("GET", path, rawKey);
      expect(res.status).toBe(200);
      const body = await readJson<Listed>(res);
      expect(body.data).toHaveLength(3);
      expect(body.pagination).toEqual({ page: 1, limit: 100, total: 3 });
    });

    test(`${path}: page 2 holds the rest, oldest first`, async () => {
      const { id, rawKey } = await seed.apiKey();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await seedOne(id, i)).id);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const first = await readJson<Listed>(
        await apiCall("GET", `${path}?limit=2`, rawKey),
      );
      const second = await readJson<Listed>(
        await apiCall("GET", `${path}?page=2&limit=2`, rawKey),
      );
      const third = await readJson<Listed>(
        await apiCall("GET", `${path}?page=3&limit=2`, rawKey),
      );
      expect(first.data.map((r) => r.id)).toEqual(ids.slice(0, 2));
      expect(second.data.map((r) => r.id)).toEqual(ids.slice(2, 4));
      expect(third.data.map((r) => r.id)).toEqual(ids.slice(4));
      expect(second.pagination).toEqual({ page: 2, limit: 2, total: 5 });
    });

    for (const qs of [
      "page=0",
      "page=-1",
      "page=abc",
      "limit=0",
      "limit=101",
      "limit=abc",
    ]) {
      test(`${path}?${qs} is rejected with 422`, async () => {
        const { rawKey } = await seed.apiKey();
        expect((await apiCall("GET", `${path}?${qs}`, rawKey)).status).toBe(422);
      });
    }

    test(`${path}?limit=100 is the maximum accepted`, async () => {
      const { rawKey } = await seed.apiKey();
      expect((await apiCall("GET", `${path}?limit=100`, rawKey)).status).toBe(200);
    });
  }
});
