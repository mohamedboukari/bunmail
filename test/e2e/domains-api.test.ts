import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the Domains API (/api/v1/domains).
 *
 * Tests the full HTTP request/response cycle for domain CRUD endpoints.
 * Mocks the DB, auth middleware, and services to avoid requiring
 * a running database or valid API key.
 */

/** Serialized domain shape returned by the API */
interface SerializedDomain {
  id: string;
  name: string;
  dkimPrivateKey?: string;
  dkimPublicKey?: string;
  dkimSelector: string;
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

/** Single-item response (create, get, delete) */
interface DomainResponse {
  success: boolean;
  error?: string;
  data: SerializedDomain;
}

/** List response */
interface DomainListResponse {
  success: boolean;
  data: SerializedDomain[];
}

/** Error response */
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
const mockDomain = {
  id: "dom_test123",
  name: "example.com",
  dkimPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
  dkimPublicKey: "-----BEGIN PUBLIC KEY-----\nPUBLIC\n-----END PUBLIC KEY-----",
  dkimSelector: "bunmail",
  spfVerified: false,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

/* ─── Mock domain service ─── */
mock.module("../../src/modules/domains/services/domain.service.ts", () => ({
  createDomain: mock(() => Promise.resolve(mockDomain)),
  listDomains: mock(() => Promise.resolve([mockDomain])),
  getDomainById: mock((id: string) =>
    Promise.resolve(id === "dom_test123" ? mockDomain : undefined)
  ),
  deleteDomain: mock((id: string) =>
    Promise.resolve(id === "dom_test123" ? mockDomain : undefined)
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
const { domainsPlugin } = await import(
  "../../src/modules/domains/domains.plugin.ts"
);

/** Test app instance with the domains plugin */
const app = new Elysia().use(domainsPlugin);

/* ─── Tests ─── */

describe("Domains API E2E", () => {
  describe("POST /api/v1/domains", () => {
    test("creates a domain and returns serialized response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ name: "example.com" }),
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as DomainResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("dom_test123");
      expect(body.data.name).toBe("example.com");
      /** Private key must not be exposed */
      expect(body.data.dkimPrivateKey).toBeUndefined();
      expect(body.data.dkimPublicKey).toBeUndefined();
    });

    test("returns 422 on missing name", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains", {
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

  describe("GET /api/v1/domains", () => {
    test("returns list of domains", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains", {
          headers: { authorization: "Bearer test_key" },
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as DomainListResponse;
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      const first = body.data[0]!;
      expect(first.name).toBe("example.com");
      /** Private key must not be exposed in list */
      expect(first.dkimPrivateKey).toBeUndefined();
    });
  });

  describe("GET /api/v1/domains/:id", () => {
    test("returns domain when found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains/dom_test123", {
          headers: { authorization: "Bearer test_key" },
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as DomainResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("dom_test123");
    });

    test("returns 404 when domain not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains/dom_nonexistent", {
          headers: { authorization: "Bearer test_key" },
        })
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("Domain not found");
    });
  });

  describe("DELETE /api/v1/domains/:id", () => {
    test("deletes domain and returns serialized response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains/dom_test123", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as DomainResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("dom_test123");
    });

    test("returns 404 when domain not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains/dom_nonexistent", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        })
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
    });
  });
});
