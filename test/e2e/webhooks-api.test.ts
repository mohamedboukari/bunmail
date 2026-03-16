import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the Webhooks API (/api/v1/webhooks).
 *
 * Tests the full HTTP request/response cycle for webhook management endpoints.
 * Mocks the DB, auth middleware, and services to avoid requiring
 * a running database or valid API key.
 */

/** Serialized webhook shape returned by the API (secret stripped) */
interface SerializedWebhook {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
}

interface WebhookCreateResponse {
  success: boolean;
  data: SerializedWebhook & { secret: string };
}

interface WebhookResponse {
  success: boolean;
  error?: string;
  data: SerializedWebhook;
}

interface WebhookListResponse {
  success: boolean;
  data: SerializedWebhook[];
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
const mockWebhook = {
  id: "whk_test123",
  apiKeyId: "key_test",
  url: "https://example.com/hook",
  events: ["email.sent", "email.failed"],
  secret: "supersecret123",
  isActive: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

/* ─── Mock webhook service ─── */
mock.module(
  "../../src/modules/webhooks/services/webhook.service.ts",
  () => ({
    createWebhook: mock(() =>
      Promise.resolve({ webhook: mockWebhook, secret: "supersecret123" })
    ),
    listWebhooks: mock(() => Promise.resolve([mockWebhook])),
    deleteWebhook: mock((id: string) =>
      Promise.resolve(id === "whk_test123" ? mockWebhook : undefined)
    ),
  })
);

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
const { webhooksPlugin } = await import(
  "../../src/modules/webhooks/webhooks.plugin.ts"
);

const app = new Elysia().use(webhooksPlugin);

/* ─── Tests ─── */

describe("Webhooks API E2E", () => {
  describe("POST /api/v1/webhooks", () => {
    test("creates a webhook and returns secret in response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/webhooks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({
            url: "https://example.com/hook",
            events: ["email.sent", "email.failed"],
          }),
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as WebhookCreateResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("whk_test123");
      expect(body.data.url).toBe("https://example.com/hook");
      expect(body.data.events).toEqual(["email.sent", "email.failed"]);
      expect(body.data.secret).toBe("supersecret123");
    });

    test("returns 422 on missing url/events", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/webhooks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({}),
        })
      );

      expect(response.status).toBe(422);
    });
  });

  describe("GET /api/v1/webhooks", () => {
    test("returns list of webhooks with secret stripped", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/webhooks", {
          headers: { authorization: "Bearer test_key" },
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as WebhookListResponse;
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe("whk_test123");
      expect(body.data[0]!.url).toBe("https://example.com/hook");
      /** Secret must not be exposed in list response */
      expect(
        (body.data[0] as unknown as Record<string, unknown>).secret
      ).toBeUndefined();
    });
  });

  describe("DELETE /api/v1/webhooks/:id", () => {
    test("deletes webhook and returns serialized response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/webhooks/whk_test123", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as WebhookResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("whk_test123");
    });

    test("returns 404 when webhook not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/webhooks/whk_nonexistent", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        })
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("Webhook not found");
    });
  });
});
