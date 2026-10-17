/**
 * Per-API-key rate limiting on the REST API, through a real plugin with
 * the real auth and rate-limit middleware against real Postgres.
 *
 * The e2e suites replace `rateLimitMiddleware` with a stub, so before this
 * test nothing sent requests through the real middleware. The hook was
 * registered without `.as("scoped")`, so Elysia kept it local to the
 * middleware instance and it never ran for any route: a key could send
 * unlimited requests.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { templatesPlugin } from "../../src/modules/templates/templates.plugin.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed } from "./_helpers.ts";

function listTemplates(rawKey: string): Promise<Response> {
  return templatesPlugin.handle(
    new Request("http://localhost/api/v1/templates", {
      headers: { authorization: `Bearer ${rawKey}` },
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
});

describe("API rate limit", () => {
  test("allows the configured number of requests per key, then returns 429", async () => {
    const { rawKey } = await seed.apiKey({ isAdmin: false });
    const { max, windowSec } = config.apiRateLimit;

    for (let i = 0; i < max; i++) {
      expect((await listTemplates(rawKey)).status).toBe(200);
    }

    const limited = await listTemplates(rawKey);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(windowSec);
  });

  test("each key has its own budget", async () => {
    const a = await seed.apiKey({ isAdmin: false });
    const b = await seed.apiKey({ isAdmin: false });

    for (let i = 0; i <= config.apiRateLimit.max; i++) await listTemplates(a.rawKey);
    expect((await listTemplates(a.rawKey)).status).toBe(429);

    expect((await listTemplates(b.rawKey)).status).toBe(200);
  });
});
