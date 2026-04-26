import { describe, test, expect, mock, beforeAll } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the dashboard.
 *
 * Tests the full HTTP request/response cycle for dashboard routes
 * including login, session management, and page rendering.
 *
 * Mocks the DB and services to avoid requiring a running database.
 */

/* ─── Mock config ─── */
mock.module("../../src/config.ts", () => ({
  config: {
    database: { url: "postgres://test:test@localhost/test" },
    server: { port: 3000, host: "0.0.0.0" },
    mail: { hostname: "localhost" },
    dashboard: { password: "test123", sessionSecret: "e2e-test-secret" },
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

/* ─── Mock services ─── */
mock.module("../../src/modules/emails/services/stats.service.ts", () => ({
  getDashboardStats: mock(() =>
    Promise.resolve({
      totalEmails: 42,
      sentCount: 35,
      failedCount: 3,
      queuedCount: 4,
      sentLast24h: 7,
      failedLast24h: 0,
      successRate: 35 / 38,
      inboundTotal: 9,
      inboundLast24h: 2,
      emailsInTrash: 1,
      inboundInTrash: 0,
      totalApiKeys: 5,
      activeApiKeys: 4,
      totalDomains: 2,
      totalTemplates: 6,
      totalWebhooks: 1,
    }),
  ),
}));

mock.module("../../src/modules/emails/services/email.service.ts", () => ({
  /** Reads */
  listAllEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  listEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  getEmailByIdUnscoped: mock(() => Promise.resolve(undefined)),
  getEmailById: mock(() => Promise.resolve(undefined)),
  createEmail: mock(() => Promise.resolve({})),
  /** Trash — included so this mock can leak into other e2e tests
   *  without stripping fields they depend on. */
  trashEmail: mock(() => Promise.resolve(undefined)),
  trashEmails: mock(() => Promise.resolve(0)),
  trashEmailUnscoped: mock(() => Promise.resolve(undefined)),
  trashEmailsUnscoped: mock(() => Promise.resolve(0)),
  restoreEmail: mock(() => Promise.resolve(undefined)),
  restoreEmailUnscoped: mock(() => Promise.resolve(undefined)),
  permanentDeleteEmail: mock(() => Promise.resolve(undefined)),
  permanentDeleteEmailUnscoped: mock(() => Promise.resolve(undefined)),
  emptyEmailsTrash: mock(() => Promise.resolve(0)),
  emptyEmailsTrashUnscoped: mock(() => Promise.resolve(0)),
  listTrashedEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  listTrashedEmailsUnscoped: mock(() => Promise.resolve({ data: [], total: 0 })),
  getTrashedEmailByIdUnscoped: mock(() => Promise.resolve(undefined)),
}));

mock.module("../../src/modules/api-keys/services/api-key.service.ts", () => ({
  listApiKeys: mock(() => Promise.resolve([])),
  createApiKey: mock(() =>
    Promise.resolve({
      apiKey: {
        id: "key_test123",
        name: "Test Key",
        keyHash: "abc",
        keyPrefix: "bm_live_test",
        isActive: true,
        lastUsedAt: null,
        createdAt: new Date(),
      },
      rawKey: "bm_live_test1234567890abcdef12345678",
    }),
  ),
  revokeApiKey: mock(() =>
    Promise.resolve({
      id: "key_test123",
      name: "Test Key",
      keyHash: "abc",
      keyPrefix: "bm_live_test",
      isActive: false,
      lastUsedAt: null,
      createdAt: new Date(),
    }),
  ),
}));

mock.module("../../src/modules/domains/services/domain.service.ts", () => ({
  listDomains: mock(() => Promise.resolve([])),
  createDomain: mock(() =>
    Promise.resolve({
      id: "dom_test123",
      name: "example.com",
      dkimPrivateKey: null,
      dkimPublicKey: null,
      dkimSelector: "bunmail",
      spfVerified: false,
      dkimVerified: false,
      dmarcVerified: false,
      verifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  ),
  getDomainById: mock(() => Promise.resolve(undefined)),
  deleteDomain: mock(() => Promise.resolve(undefined)),
  getDkimDnsRecord: mock(() => null),
}));

mock.module("../../src/modules/domains/services/dns-verification.service.ts", () => ({
  verifyDomain: mock(() => Promise.resolve()),
}));

mock.module("../../src/modules/templates/services/template.service.ts", () => ({
  renderTemplate: mock(() => ""),
  createTemplate: mock(() => Promise.resolve({})),
  listTemplates: mock(() => Promise.resolve([])),
  listAllTemplates: mock(() => Promise.resolve([])),
  getTemplateByIdUnscoped: mock(() => Promise.resolve(undefined)),
  getTemplateById: mock(() => Promise.resolve(undefined)),
  updateTemplate: mock(() => Promise.resolve({})),
  deleteTemplate: mock(() => Promise.resolve(undefined)),
}));

mock.module("../../src/modules/webhooks/services/webhook.service.ts", () => ({
  createWebhook: mock(() => Promise.resolve({})),
  listWebhooks: mock(() => Promise.resolve([])),
  listAllWebhooks: mock(() => Promise.resolve([])),
  deleteWebhook: mock(() => Promise.resolve(undefined)),
  findWebhooksForEvent: mock(() => Promise.resolve([])),
}));

mock.module("../../src/modules/inbound/services/inbound.service.ts", () => ({
  listInboundEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  listTrashedInboundEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  getInboundEmailById: mock(() => Promise.resolve(undefined)),
  getTrashedInboundEmailById: mock(() => Promise.resolve(undefined)),
  trashInboundEmail: mock(() => Promise.resolve(undefined)),
  trashInboundEmails: mock(() => Promise.resolve(0)),
  restoreInboundEmail: mock(() => Promise.resolve(undefined)),
  permanentDeleteInboundEmail: mock(() => Promise.resolve(undefined)),
  emptyInboundTrash: mock(() => Promise.resolve(0)),
}));

mock.module("../../src/db/index.ts", () => ({
  db: {},
}));

/* ─── Import plugin after mocking ─── */
const { pagesPlugin } = await import("../../src/pages/pages.plugin.tsx");

/** Test app instance with the pages plugin */
const app = new Elysia().use(pagesPlugin);

/* ─── Tests ─── */

describe("Dashboard E2E", () => {
  describe("GET /dashboard/login", () => {
    test("returns 200 with login form", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/login"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sign in");
      expect(html).toContain("password");
    });

    test("shows error message when error=invalid query param", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/login?error=invalid"),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Invalid password");
    });
  });

  describe("POST /dashboard/login", () => {
    test("redirects to /dashboard on correct password", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "password=test123",
        }),
      );
      /** Should redirect (302) */
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      /** Should set a session cookie */
      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).toContain("bm_session=");
      expect(setCookie).toContain("HttpOnly");
    });

    test("redirects to login with error on wrong password", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "password=wrongpassword",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
    });
  });

  describe("Protected routes without session", () => {
    test("GET /dashboard redirects to login", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });

    test("GET /dashboard/emails redirects to login", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/emails"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });
  });

  describe("Protected routes with valid session", () => {
    /** Get a valid session cookie by logging in */
    let sessionCookie: string;

    beforeAll(async () => {
      const loginResponse = await app.handle(
        new Request("http://localhost/dashboard/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "password=test123",
        }),
      );
      const setCookie = loginResponse.headers.get("set-cookie")!;
      /** Extract just the cookie value (bm_session=<value>) */
      const match = setCookie.match(/bm_session=([^;]+)/);
      sessionCookie = `bm_session=${match![1]}`;
    });

    test("GET /dashboard returns 200 with stats", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Dashboard");
      expect(html).toContain("42"); /** totalEmails */
    });

    test("GET /dashboard/emails returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/emails", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Emails");
    });

    test("GET /dashboard/api-keys returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("API Keys");
    });

    test("GET /dashboard/domains returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/domains", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Domains");
    });

    test("POST /dashboard/api-keys creates key and redirects", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "name=TestKey",
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/dashboard/api-keys");
      expect(location).toContain("rawKey=");
    });

    test("POST /dashboard/domains creates domain and redirects", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/domains", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "name=example.com",
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/dashboard/domains");
      expect(location).toContain("flash=");
    });
  });

  describe("POST /dashboard/logout", () => {
    test("clears session cookie and redirects to login", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/logout", {
          method: "POST",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).toContain("Max-Age=0");
    });
  });
});
