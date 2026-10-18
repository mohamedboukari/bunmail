/**
 * The Bearer API key middleware (#183), real middleware against real
 * Postgres, on a real route (`GET /api/v1/emails`).
 *
 * The route-by-route boundary (no key, invalid key, revoked key, admin
 * gate, tenant isolation) is covered for every route by
 * `authz-matrix.integration.test.ts`; a key whose creator is deactivated
 * by `record-ownership.integration.test.ts`. This file covers what those
 * don't: each malformed `Authorization` header gets its own `401`, and the
 * `last_used_at` write is throttled to once a minute per key.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { apiPlugins } from "../../src/modules/api-plugins.ts";
import { truncateAll, seed, db, apiKeys } from "./_helpers.ts";

const app = new Elysia().use(apiPlugins);

function listEmails(authorization: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers["authorization"] = authorization;
  return app.handle(new Request("http://localhost/api/v1/emails", { headers }));
}

async function lastUsedAt(id: string): Promise<Date | null> {
  const [row] = await db
    .select({ lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, id));
  return row?.lastUsedAt ?? null;
}

/** Waits up to 2 s for the fire-and-forget `last_used_at` write. */
async function waitForLastUsedAt(id: string): Promise<Date | null> {
  for (let i = 0; i < 200; i++) {
    const value = await lastUsedAt(id);
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  return null;
}

beforeEach(async () => {
  await truncateAll();
});

describe("Authorization header", () => {
  test.each([
    ["missing", null, "Missing Authorization header"],
    ["another scheme", "Basic dXNlcjpwYXNz", "Invalid Authorization scheme"],
    ["a bare token", "bm_live_no_scheme", "Invalid Authorization scheme"],
    ["an unknown key", "Bearer bm_live_unknown", "Invalid API key"],
  ])("%s → 401", async (_case, authorization, error) => {
    const response = await listEmails(authorization);
    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ success: false, error: expect.stringContaining(error) });
  });

  test("a valid key passes", async () => {
    const { rawKey } = await seed.apiKey();
    expect((await listEmails(`Bearer ${rawKey}`)).status).toBe(200);
  });
});

describe("last_used_at", () => {
  test("is written on first use, then at most once a minute", async () => {
    const { id, rawKey } = await seed.apiKey();
    expect(await lastUsedAt(id)).toBeNull();

    expect((await listEmails(`Bearer ${rawKey}`)).status).toBe(200);
    const first = await waitForLastUsedAt(id);
    expect(first).not.toBeNull();

    /** Clear it: a second write within the minute would set it again. */
    await db.update(apiKeys).set({ lastUsedAt: null }).where(eq(apiKeys.id, id));
    expect((await listEmails(`Bearer ${rawKey}`)).status).toBe(200);
    await Bun.sleep(200);
    expect(await lastUsedAt(id)).toBeNull();
  });
});
