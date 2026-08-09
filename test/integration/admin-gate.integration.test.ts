/**
 * Integration test for the admin/restricted key boundary (#130) against a
 * real Postgres, exercising the REAL `authMiddleware` + `adminMiddleware` +
 * plugin over HTTP (no mocks). Proves that:
 *   - an admin key reaches the management plane (200),
 *   - a restricted key is rejected (403 ADMIN_REQUIRED) — including the
 *     #126-bypass path (PATCH your own allowedSenders), which is the whole
 *     point of this issue.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { apiKeysPlugin } from "../../src/modules/api-keys/api-keys.plugin.ts";
import { inboundPlugin } from "../../src/modules/inbound/inbound.plugin.ts";
import { truncateAll, seed } from "./_helpers.ts";

const app = new Elysia().use(apiKeysPlugin).use(inboundPlugin);

function req(path: string, key: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
});

describe("admin/restricted key gate (#130)", () => {
  test("admin key reaches the management plane", async () => {
    const { rawKey } = await seed.apiKey({ name: "admin", isAdmin: true });

    const list = await req("/api/v1/api-keys", rawKey);
    expect(list.status).toBe(200);

    const inbound = await req("/api/v1/inbound", rawKey);
    expect(inbound.status).toBe(200);
  });

  test("restricted key is rejected with 403 ADMIN_REQUIRED", async () => {
    const { rawKey } = await seed.apiKey({ name: "restricted", isAdmin: false });

    const list = await req("/api/v1/api-keys", rawKey);
    expect(list.status).toBe(403);
    const body = (await list.json()) as { code?: string };
    expect(body.code).toBe("ADMIN_REQUIRED");

    const inbound = await req("/api/v1/inbound", rawKey);
    expect(inbound.status).toBe(403);
  });

  test("restricted key CANNOT PATCH allowedSenders (closes the #126 self-bypass)", async () => {
    const { id, rawKey } = await seed.apiKey({
      name: "restricted",
      isAdmin: false,
    });

    /** The attack from #130: clear my own allowlist to regain spoofing. */
    const res = await req(`/api/v1/api-keys/${id}`, rawKey, {
      method: "PATCH",
      body: JSON.stringify({ allowedSenders: [] }),
    });
    expect(res.status).toBe(403);
  });

  test("an invalid key is still 401 (auth runs before the admin gate)", async () => {
    const res = await req("/api/v1/api-keys", "bm_live_not_a_real_key");
    expect(res.status).toBe(401);
  });
});
