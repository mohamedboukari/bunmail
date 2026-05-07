import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the Suppressions API (/api/v1/suppressions).
 *
 * Same pattern as `emails-api.test.ts`: the suppression service is
 * fully mocked so route handlers can be exercised end-to-end without
 * a live DB. Auth + rate-limit middlewares are stubbed to inject a
 * fixed `apiKeyId`.
 */

interface SerializedSuppression {
  id: string;
  email: string;
  reason: string;
  bounceType: string | null;
  diagnosticCode: string | null;
  sourceEmailId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface SuppressionResponse {
  success: boolean;
  error?: string;
  data: SerializedSuppression;
}

interface SuppressionListResponse {
  success: boolean;
  data: SerializedSuppression[];
  pagination: { page: number; limit: number; total: number };
}

interface ErrorResponse {
  success: false;
  error: string;
}

mock.module("../../src/config.ts", () => ({
  config: {
    database: { url: "postgres://test:test@localhost/test" },
    server: { port: 3000, host: "0.0.0.0" },
    mail: { hostname: "localhost" },
    dashboard: { password: "", sessionSecret: "test-secret" },
    logLevel: "error",
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

mock.module("../../src/db/index.ts", () => ({
  db: {},
}));

const mockSuppression = {
  id: "sup_test123",
  apiKeyId: "key_test",
  email: "blocked@example.com",
  reason: "manual",
  bounceType: null,
  diagnosticCode: null,
  sourceEmailId: null,
  expiresAt: null as Date | null,
  createdAt: new Date("2026-05-01"),
};

const mockBounceSuppression = {
  ...mockSuppression,
  id: "sup_bounce456",
  email: "bounced@example.com",
  reason: "bounce",
  bounceType: "hard",
  diagnosticCode: "5.1.1",
  sourceEmailId: "msg_origin",
};

mock.module("../../src/modules/suppressions/services/suppression.service.ts", () => ({
  createSuppression: mock(() => Promise.resolve(mockSuppression)),
  listSuppressions: mock(() =>
    Promise.resolve({ data: [mockSuppression, mockBounceSuppression], total: 2 }),
  ),
  getSuppressionById: mock((id: string) =>
    Promise.resolve(id === "sup_test123" ? mockSuppression : undefined),
  ),
  deleteSuppression: mock((id: string) =>
    Promise.resolve(id === "sup_test123" ? mockSuppression : undefined),
  ),
  isSuppressed: mock(() => Promise.resolve(undefined)),
  addFromBounce: mock(() => Promise.resolve(mockBounceSuppression)),
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

const { suppressionsPlugin } =
  await import("../../src/modules/suppressions/suppressions.plugin.ts");

const app = new Elysia().use(suppressionsPlugin);

describe("Suppressions API E2E", () => {
  describe("POST /api/v1/suppressions", () => {
    test("creates a manual suppression and returns the serialized row", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/suppressions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({
            email: "blocked@example.com",
            reason: "manual",
          }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as SuppressionResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("sup_test123");
      expect(body.data.email).toBe("blocked@example.com");
      expect(body.data.reason).toBe("manual");
      /** Public response should never carry the apiKeyId — it's the caller's own. */
      expect("apiKeyId" in body.data).toBe(false);
    });

    test("rejects an invalid email format with 422", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/suppressions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ email: "not-an-email", reason: "manual" }),
        }),
      );

      expect(response.status).toBe(422);
    });

    test("rejects an unknown reason with 422", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/suppressions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ email: "x@example.com", reason: "made-up" }),
        }),
      );

      expect(response.status).toBe(422);
    });
  });

  describe("GET /api/v1/suppressions", () => {
    test("returns paginated list with both rows", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/suppressions", {
          method: "GET",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as SuppressionListResponse;
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      expect(body.data[0]!.id).toBe("sup_test123");
      expect(body.data[1]!.bounceType).toBe("hard");
      expect(body.data[1]!.diagnosticCode).toBe("5.1.1");
    });
  });

  describe("GET /api/v1/suppressions/:id", () => {
    test("returns the row when it exists", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/suppressions/sup_test123", {
          method: "GET",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as SuppressionResponse;
      expect(body.data.id).toBe("sup_test123");
    });

    test("returns 404 when the row doesn't exist", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/suppressions/sup_missing", {
          method: "GET",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
    });
  });

  describe("DELETE /api/v1/suppressions/:id", () => {
    test("removes an existing suppression and returns the deleted row", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/suppressions/sup_test123", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as SuppressionResponse;
      expect(body.data.id).toBe("sup_test123");
    });

    test("returns 404 when nothing matches", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/suppressions/sup_missing", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
    });
  });
});
