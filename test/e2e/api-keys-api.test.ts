import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the API Keys API (/api/v1/api-keys).
 *
 * Tests the full HTTP request/response cycle for API key management endpoints.
 * Mocks the DB, auth middleware, and services to avoid requiring
 * a running database or valid API key.
 */

/** Serialized API key shape returned by the API */
interface SerializedApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  allowedSenders: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

interface ApiKeyCreateResponse {
  success: boolean;
  data: SerializedApiKey & { key: string };
}

interface ApiKeyResponse {
  success: boolean;
  error?: string;
  data: SerializedApiKey;
}

interface ApiKeyListResponse {
  success: boolean;
  data: SerializedApiKey[];
}

interface ErrorResponse {
  success: false;
  error: string;
}

/* ─── Mock config ─── */
mock.module("../../src/config.ts", () => ({
  config: {
    database: { url: "postgres://test:test@localhost/test" },
    server: { port: 3000, host: "0.0.0.0" },
    mail: { hostname: "localhost" },
    dashboard: { password: "", sessionSecret: "test-secret" },
    logLevel: "error",
  },
}));

/* ─── Mock logger ─── */
mock.module("../../src/utils/logger.ts", () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

/* ─── Mock DB ─── */
mock.module("../../src/db/index.ts", () => ({
  db: {},
}));

/* ─── Test data ─── */
const mockApiKey = {
  id: "key_test123",
  name: "Test Key",
  keyHash: "abc123hash",
  keyPrefix: "bm_live_test",
  isActive: true,
  allowedSenders: [] as string[],
  lastUsedAt: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

/* ─── Mock api-key service ─── */
mock.module("../../src/modules/api-keys/services/api-key.service.ts", () => ({
  createApiKey: mock((input: { name: string; allowedSenders?: string[] }) =>
    Promise.resolve({
      apiKey: { ...mockApiKey, allowedSenders: input.allowedSenders ?? [] },
      rawKey: "bm_live_test_fullkey123",
    }),
  ),
  listApiKeys: mock(() => Promise.resolve([mockApiKey])),
  revokeApiKey: mock((id: string) =>
    Promise.resolve(id === "key_test123" ? mockApiKey : undefined),
  ),
  updateApiKey: mock((id: string, input: { name?: string; allowedSenders?: string[] }) =>
    Promise.resolve(
      id === "key_test123"
        ? { ...mockApiKey, ...input, allowedSenders: input.allowedSenders ?? [] }
        : undefined,
    ),
  ),
}));

/* ─── Mock auth + rate limit middleware ─── */
mock.module("../../src/middleware/auth.ts", () => ({
  authMiddleware: new Elysia({ name: "auth-middleware" }).derive(() => ({
    apiKeyId: "key_test",
    apiKeyName: "Test Key",
  })),
}));

mock.module("../../src/middleware/rate-limit.ts", () => ({
  rateLimitMiddleware: new Elysia({ name: "rate-limit-middleware" }),
}));

/* ─── Import plugin after mocking ─── */
const { apiKeysPlugin } = await import("../../src/modules/api-keys/api-keys.plugin.ts");

const app = new Elysia().use(apiKeysPlugin);

/* ─── Tests ─── */

describe("API Keys API E2E", () => {
  describe("POST /api/v1/api-keys", () => {
    test("creates an API key and returns raw key in response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ name: "Test Key" }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as ApiKeyCreateResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("key_test123");
      expect(body.data.name).toBe("Test Key");
      expect(body.data.keyPrefix).toBe("bm_live_test");
      expect(body.data.key).toBe("bm_live_test_fullkey123");
      /** keyHash must not be exposed */
      expect((body.data as unknown as Record<string, unknown>).keyHash).toBeUndefined();
    });

    test("returns 422 on missing name", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({}),
        }),
      );

      expect(response.status).toBe(422);
    });

    test("accepts allowedSenders and echoes them in the response (#126)", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({
            name: "Restricted",
            allowedSenders: ["noreply@example.com"],
          }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as ApiKeyCreateResponse;
      expect(body.data.allowedSenders).toEqual(["noreply@example.com"]);
    });

    test("rejects a non-email allowedSenders entry with 422", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ name: "Bad", allowedSenders: ["not-an-email"] }),
        }),
      );

      expect(response.status).toBe(422);
    });
  });

  describe("PATCH /api/v1/api-keys/:id (#126)", () => {
    test("updates the allowed-senders list", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys/key_test123", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ allowedSenders: ["ceo@example.com"] }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as ApiKeyResponse;
      expect(body.success).toBe(true);
      expect(body.data.allowedSenders).toEqual(["ceo@example.com"]);
    });

    test("returns 404 for an unknown key", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys/key_missing", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ allowedSenders: [] }),
        }),
      );

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/v1/api-keys", () => {
    test("returns list of API keys", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as ApiKeyListResponse;
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.name).toBe("Test Key");
      /** keyHash must not be exposed in list */
      expect(
        (body.data[0] as unknown as Record<string, unknown>).keyHash,
      ).toBeUndefined();
    });
  });

  describe("DELETE /api/v1/api-keys/:id", () => {
    test("revokes API key and returns serialized response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys/key_test123", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as ApiKeyResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("key_test123");
    });

    test("returns 404 when API key not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/api-keys/key_nonexistent", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("API key not found");
    });
  });
});
