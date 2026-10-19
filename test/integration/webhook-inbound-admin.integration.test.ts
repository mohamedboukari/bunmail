/**
 * Only admin keys may subscribe to inbound `email.received`
 * (GHSA-8r3q-hqf8-2264), exercised over HTTP with real auth against a real
 * Postgres. Inbound mail has no owning key and is admin-only (#130).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { webhooksPlugin } from "../../src/modules/webhooks/webhooks.plugin.ts";
import { InboundEventsRequireAdminError } from "../../src/modules/webhooks/errors.ts";
import { truncateAll, seed } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

/** Mirrors the global onError mapping in src/index.ts for this error. */
const app = new Elysia()
  .onError(({ error, set }) => {
    if (error instanceof InboundEventsRequireAdminError) {
      set.status = 403;
      return {
        success: false,
        error: error.message,
        code: "INBOUND_EVENTS_REQUIRE_ADMIN",
      };
    }
  })
  .use(webhooksPlugin);

function createHook(key: string, events: string[]): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/v1/webhooks", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://93.184.216.34/hook", events }),
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
});

describe("email.received subscriptions (GHSA-8r3q-hqf8-2264)", () => {
  test("a restricted key gets 403", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: false });
    const res = await createHook(rawKey, ["email.received"]);
    expect(res.status).toBe(403);
    const body = await readJson<{ code?: string }>(res);
    expect(body.code).toBe("INBOUND_EVENTS_REQUIRE_ADMIN");
  });

  test("a restricted key mixing in email.received is still rejected", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: false });
    expect((await createHook(rawKey, ["email.sent", "email.received"])).status).toBe(403);
  });

  test("an admin key may subscribe", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: true });
    expect((await createHook(rawKey, ["email.received"])).status).toBe(200);
  });

  test("a restricted key may still subscribe to its own outbound events", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: false });
    expect((await createHook(rawKey, ["email.sent", "email.bounced"])).status).toBe(200);
  });
});

describe("domain event subscriptions (#250)", () => {
  test.each(["domain.verification_failed", "domain.verified"])(
    "a restricted key gets 403 for %p",
    async (event) => {
      const { rawKey } = await seed.apiKey({ isAdmin: false });
      const res = await createHook(rawKey, ["email.sent", event]);
      expect(res.status).toBe(403);
      const body = await readJson<{ code?: string }>(res);
      expect(body.code).toBe("INBOUND_EVENTS_REQUIRE_ADMIN");
    },
  );

  test("an admin key may subscribe to both", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: true });
    const res = await createHook(rawKey, [
      "domain.verification_failed",
      "domain.verified",
    ]);
    expect(res.status).toBe(200);
  });
});
