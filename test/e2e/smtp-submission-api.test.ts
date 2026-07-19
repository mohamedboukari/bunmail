import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the SMTP submission stats API
 * (`GET /api/v1/smtp-submission/stats`, #123).
 *
 * The usage service is mocked so the route is exercised without a DB;
 * auth + rate-limit middlewares are stubbed to inject a fixed apiKeyId.
 * The config mock includes `smtpSubmission.dailyQuota` because the route
 * surfaces quota status in the response.
 */

interface StatsResponse {
  success: boolean;
  data: {
    window: { days: number };
    quota: { daily: number | null; usedToday: number; remaining: number | null };
    totals: { accepted: number; rejected: number };
    daily: Array<{ day: string; accepted: number; rejected: number }>;
  };
}

/** Flipped per-describe to exercise both the quota and unlimited shapes. */
let mockDailyQuota = 100;

mock.module("../../src/config.ts", () => ({
  config: {
    database: { url: "postgres://test:test@localhost/test" },
    server: { port: 3000, host: "0.0.0.0" },
    mail: { hostname: "localhost" },
    dashboard: { password: "", sessionSecret: "test-secret" },
    logLevel: "error",
    get smtpSubmission() {
      return { dailyQuota: mockDailyQuota };
    },
  },
}));

mock.module("../../src/utils/logger.ts", () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

mock.module("../../src/db/index.ts", () => ({ db: {} }));

mock.module("../../src/modules/smtp-submission/services/usage.service.ts", () => ({
  getStats: mock((_apiKeyId: string, days: number) =>
    Promise.resolve({
      days,
      totals: { accepted: 7, rejected: 2 },
      daily: [{ day: "2026-07-19", accepted: 7, rejected: 2 }],
    }),
  ),
  getAcceptedToday: mock(() => Promise.resolve(7)),
}));

mock.module("../../src/middleware/auth.ts", () => ({
  authMiddleware: new Elysia({ name: "auth-middleware" }).derive(() => ({
    apiKeyId: "key_test",
    apiKeyName: "Test Key",
  })),
}));

mock.module("../../src/middleware/rate-limit.ts", () => ({
  rateLimitMiddleware: new Elysia({ name: "rate-limit-middleware" }),
}));

const { smtpSubmissionPlugin } =
  await import("../../src/modules/smtp-submission/smtp-submission.plugin.ts");

const app = new Elysia().use(smtpSubmissionPlugin);

function getStats(qs = "") {
  return app.handle(
    new Request(`http://localhost/api/v1/smtp-submission/stats${qs}`, {
      headers: { authorization: "Bearer test_key" },
    }),
  );
}

describe("SMTP submission stats API E2E", () => {
  test("returns totals, per-day rows, and quota status", async () => {
    mockDailyQuota = 100;
    const response = await getStats();
    expect(response.status).toBe(200);

    const body = (await response.json()) as StatsResponse;
    expect(body.success).toBe(true);
    expect(body.data.window.days).toBe(30); // default
    expect(body.data.totals).toEqual({ accepted: 7, rejected: 2 });
    expect(body.data.daily).toHaveLength(1);
    expect(body.data.quota).toEqual({ daily: 100, usedToday: 7, remaining: 93 });
  });

  test("honours the days query param", async () => {
    mockDailyQuota = 100;
    const response = await getStats("?days=7");
    const body = (await response.json()) as StatsResponse;
    expect(body.data.window.days).toBe(7);
  });

  test("reports unlimited quota as null (not a literal 0)", async () => {
    mockDailyQuota = 0;
    const response = await getStats();
    const body = (await response.json()) as StatsResponse;
    expect(body.data.quota.daily).toBeNull();
    expect(body.data.quota.remaining).toBeNull();
    expect(body.data.quota.usedToday).toBe(7);
  });

  test("rejects an out-of-range days param with 422", async () => {
    mockDailyQuota = 100;
    const response = await getStats("?days=9999");
    expect(response.status).toBe(422);
  });
});
