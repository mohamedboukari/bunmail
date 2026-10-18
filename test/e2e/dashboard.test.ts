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

/**
 * Held in a variable so a test can switch the dashboard off
 * (`password = ""`) inside try/finally and restore it.
 */
const dashboardConfig = {
  password: "test123",
  sessionSecret: "e2e-test-secret",
  /** Unset in this stub; the owner bootstrap runs in index.ts, not here. */
  ownerEmail: null,
  /** Trust one proxy hop so tests can drive distinct client IPs via
   *  the X-Forwarded-For header (app.handle has no real socket). */
  trustedProxyHops: 1,
  loginRateLimit: { enabled: true, maxAttempts: 5, windowSec: 900 },
};

void mock.module("../../src/config.ts", () => ({
  config: {
    env: "development",
    appBaseUrl: "",
    database: { url: "postgres://test:test@localhost/test" },
    server: { port: 3000, host: "0.0.0.0" },
    mail: { hostname: "localhost" },
    dashboard: dashboardConfig,
    logLevel: "error",
    logRedactPii: false,
  },
}));

/* ─── Mock logger ─── */

/** Kept so the owner setup tests can assert the audit line (#215). */
const warnLog = mock((_message: string, _data?: Record<string, unknown>) => {});

void mock.module("../../src/utils/logger.ts", () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: warnLog,
    error: mock(() => {}),
  },
}));

/* ─── Mock services ─── */
void mock.module("../../src/modules/emails/services/stats.service.ts", () => ({
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

void mock.module("../../src/modules/emails/services/email.service.ts", () => ({
  /** Reads */
  listAllEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  listEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  getEmailByIdUnscoped: mock(() => Promise.resolve(undefined)),
  getEmailById: mock(() => Promise.resolve(undefined)),
  createEmail: mock(() => Promise.resolve({})),
  /** Trash: included so this mock can leak into other e2e tests
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

void mock.module("../../src/modules/api-keys/services/api-key.service.ts", () => ({
  listApiKeys: mock(() => Promise.resolve([])),
  createApiKey: mock(() =>
    Promise.resolve({
      apiKey: {
        id: "key_test123",
        name: "Test Key",
        keyHash: "abc",
        keyPrefix: "bm_live_test",
        isActive: true,
        allowedSenders: [],
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
      allowedSenders: [],
      lastUsedAt: null,
      createdAt: new Date(),
    }),
  ),
  /**
   * Included so a cross-file `mock.module` leak (this mock shadowing
   * api-keys-api.test.ts under CI's file order) can't leave `updateApiKey`
   * undefined. See #126 / the redact.test.ts leak fix (#121).
   */
  updateApiKey: mock(() =>
    Promise.resolve({
      id: "key_test123",
      name: "Test Key",
      keyHash: "abc",
      keyPrefix: "bm_live_test",
      isActive: true,
      allowedSenders: [],
      lastUsedAt: null,
      createdAt: new Date(),
    }),
  ),
}));

void mock.module("../../src/modules/domains/services/domain.service.ts", () => ({
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
      unsubscribeEmail: null,
      unsubscribeUrl: null,
      notifyEmail: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  ),
  getDomainById: mock(() => Promise.resolve(undefined)),
  deleteDomain: mock(() => Promise.resolve(undefined)),
  getDkimDnsRecord: mock(() => null),
}));

void mock.module(
  "../../src/modules/domains/services/dns-verification.service.ts",
  () => ({
    verifyDomain: mock(() => Promise.resolve()),
  }),
);

void mock.module("../../src/modules/templates/services/template.service.ts", () => ({
  renderTemplate: mock(() => ""),
  createTemplate: mock(() => Promise.resolve({})),
  listTemplates: mock(() => Promise.resolve([])),
  listAllTemplates: mock(() => Promise.resolve([])),
  getTemplateByIdUnscoped: mock(() => Promise.resolve(undefined)),
  getTemplateById: mock(() => Promise.resolve(undefined)),
  updateTemplate: mock(() => Promise.resolve({})),
  deleteTemplate: mock(() => Promise.resolve(undefined)),
}));

void mock.module("../../src/modules/webhooks/services/webhook.service.ts", () => ({
  createWebhook: mock(() => Promise.resolve({})),
  listWebhooks: mock(() => Promise.resolve([])),
  listAllWebhooks: mock(() => Promise.resolve([])),
  deleteWebhook: mock(() => Promise.resolve(undefined)),
  findWebhooksForEvent: mock(() => Promise.resolve([])),
}));

void mock.module("../../src/modules/inbound/services/inbound.service.ts", () => ({
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

/**
 * Owner setup (#215). `db` is mocked as `{}` below, so the real service
 * cannot run here; its database behaviour is covered by
 * owner-setup.integration.test.ts. Well-formed tokens (43 base64url
 * characters): LIVE_TOKEN is live, anything else is not.
 */
const LIVE_TOKEN = "L".repeat(40) + "i_v";
const UNKNOWN_TOKEN = "U".repeat(40) + "n-k";
const OWNER = { userId: "usr_owner", email: "owner@example.com" };

const findLiveOwnerSetup = mock((token: string) =>
  Promise.resolve(token === LIVE_TOKEN ? OWNER : null),
);
const completeOwnerSetup = mock((token: string, _password: string) =>
  Promise.resolve<typeof OWNER | null>(token === LIVE_TOKEN ? OWNER : null),
);

void mock.module("../../src/modules/users/services/owner.service.ts", () => ({
  findLiveOwnerSetup,
  completeOwnerSetup,
  /** Included so this mock can leak into other files without holes. */
  bootstrapOwner: mock(() => Promise.resolve({ kind: "complete" })),
  issueOwnerSetupLink: mock(() =>
    Promise.resolve({ token: LIVE_TOKEN, email: OWNER.email, expiresAt: new Date() }),
  ),
}));

void mock.module("../../src/db/index.ts", () => ({
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

  describe("POST /dashboard/login brute-force protection (#109)", () => {
    /** Each test uses a distinct X-Forwarded-For so the module-level
     *  attempt map doesn't bleed across cases. */
    const wrongLogin = (ip: string) =>
      app.handle(
        new Request("http://localhost/dashboard/login", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": ip,
          },
          body: "password=wrongpassword",
        }),
      );

    test("blocks with 429 + Retry-After after 5 failed attempts from one IP", async () => {
      const ip = "9.9.9.9";
      /** First 5 wrong attempts redirect with the invalid-password error. */
      for (let i = 0; i < 5; i++) {
        const res = await wrongLogin(ip);
        expect(res.status).toBe(302);
      }
      /** The 6th is locked out. */
      const blocked = await wrongLogin(ip);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      const html = await blocked.text();
      expect(html).toContain("Too many failed attempts");
      /** The lockout response disables the form (standalone `disabled`
       *  attribute, distinct from the `disabled:` Tailwind classes). */
      expect(/disabled(?![:\w-])/.test(html)).toBe(true);
    });

    test("lockout is per-IP: a different IP is unaffected", async () => {
      const attacker = "9.9.9.10";
      for (let i = 0; i < 6; i++) await wrongLogin(attacker);

      /** A wrong password from a fresh IP still gets the normal redirect,
       *  not a 429. */
      const other = await wrongLogin("9.9.9.11");
      expect(other.status).toBe(302);
      expect(other.headers.get("location")).toBe("/dashboard/login?error=invalid");
    });

    test("a successful login clears the IP's failure counter", async () => {
      const ip = "9.9.9.12";
      /** Burn 4 failures (still under the limit of 5). */
      for (let i = 0; i < 4; i++) await wrongLogin(ip);

      /** Correct password from the same IP succeeds and resets the counter. */
      const ok = await app.handle(
        new Request("http://localhost/dashboard/login", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": ip,
          },
          body: "password=test123",
        }),
      );
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe("/dashboard");

      /** With the counter cleared, 5 fresh failures are needed again, so a
       *  single wrong attempt still just redirects. */
      const after = await wrongLogin(ip);
      expect(after.status).toBe(302);
      expect(after.headers.get("location")).toBe("/dashboard/login?error=invalid");
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

    test("POST /dashboard/api-keys creates key, redirects with a reveal token, NOT the raw key (#132)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            /** Same-origin: passes the CSRF guard (#133). */
            origin: "http://localhost",
          },
          body: "name=TestKey",
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/dashboard/api-keys");
      /** The raw key MUST NOT appear in the URL (leaks to logs/history/Referer). */
      expect(location).not.toContain("rawKey=");
      expect(location).not.toContain("bm_live_");
      /** Only an opaque one-time reveal token rides in the query. */
      expect(location).toMatch(/[?&]reveal=[a-f0-9]{64}\b/);
    });

    describe("dashboard pagination is clamped, never a 500 (#172)", () => {
      /** Renders /dashboard/inbound and checks what reached the service. */
      const expectListedWith = async (qs: string, expected: object): Promise<void> => {
        const inbound =
          await import("../../src/modules/inbound/services/inbound.service.ts");
        const res = await app.handle(
          new Request(`http://localhost/dashboard/inbound?${qs}`, {
            headers: { cookie: sessionCookie },
          }),
        );
        expect(res.status).toBe(200);
        expect(inbound.listInboundEmails).toHaveBeenLastCalledWith(
          expect.objectContaining(expected),
        );
      };

      test("garbage page/limit fall back to defaults", async () => {
        await expectListedWith("page=0&limit=abc", { page: 1, limit: 20 });
        await expectListedWith("page=-1&limit=0", { page: 1, limit: 20 });
      });

      test("huge page/limit are capped", async () => {
        await expectListedWith("page=99999999999999999999&limit=99999999", {
          page: 1_000_000,
          limit: 100,
        });
      });
    });

    describe("POST /dashboard/send header-injection guard (#202)", () => {
      /** Form-encodes a send with one field overridden. */
      const sendForm = (overrides: Record<string, string>): Promise<Response> =>
        app.handle(
          new Request("http://localhost/dashboard/send", {
            method: "POST",
            headers: {
              cookie: sessionCookie,
              "content-type": "application/x-www-form-urlencoded",
              origin: "http://localhost",
            },
            body: new URLSearchParams({
              apiKeyId: "key_test123",
              from: "hello@example.com",
              to: "user@example.com",
              subject: "hi",
              text: "body",
              ...overrides,
            }).toString(),
          }),
        );

      test("a clean payload passes validation and reaches the handler", async () => {
        /** The mocked key list is empty, so the handler redirects: proof
         *  validation didn't reject it. */
        const response = await sendForm({ cc: "a@example.com, b@example.com" });
        expect(response.status).toBe(302);
      });

      for (const field of ["cc", "bcc", "subject", "replyTo"]) {
        test(`rejects CR/LF in ${field} with 422`, async () => {
          const response = await sendForm({
            [field]: "a@example.com\r\nBcc: victim@example.com",
          });
          expect(response.status).toBe(422);
        });
      }

      test("rejects an over-long cc with 422", async () => {
        const response = await sendForm({ cc: "a@example.com,".repeat(200) });
        expect(response.status).toBe(422);
      });
    });

    test("reveal token shows the raw key exactly once, then is spent (#132)", async () => {
      /** Create → capture the reveal token from the redirect. */
      const created = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: "name=RevealKey",
        }),
      );
      const location = created.headers.get("location")!;
      const token = location.match(/[?&]reveal=([a-f0-9]{64})\b/)![1];

      /** First GET with the token renders the raw key from the mock. */
      const first = await app.handle(
        new Request(`http://localhost/dashboard/api-keys?reveal=${token}`, {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("bm_live_test1234567890abcdef12345678");

      /** Second GET with the SAME token no longer reveals it (single-use). */
      const second = await app.handle(
        new Request(`http://localhost/dashboard/api-keys?reveal=${token}`, {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(second.status).toBe(200);
      expect(await second.text()).not.toContain("bm_live_test1234567890abcdef12345678");
    });

    test("POST /dashboard/domains creates domain and redirects", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/domains", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: "name=example.com",
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/dashboard/domains");
      expect(location).toContain("flash=");
    });

    test("rejects a cross-origin POST with 403 (CSRF guard, #133)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            /** Attacker's origin ≠ request host → rejected. */
            origin: "http://evil.example",
          },
          body: "name=CsrfKey",
        }),
      );
      expect(response.status).toBe(403);
    });

    test("rejects a POST with no Origin/Referer header (CSRF guard, #133)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "name=NoOriginKey",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("Owner setup", () => {
    const GOOD_PASSWORD = "correct horse battery staple";

    /** Form-POSTs to /dashboard/setup; same-origin unless overridden. */
    const postSetup = (
      fields: Record<string, string>,
      headers: Record<string, string> = { origin: "http://localhost" },
    ): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/setup", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    /** The leak-hardening headers every setup response carries. */
    const expectAuthPageHeaders = (response: Response): void => {
      expect(response.headers.get("cache-control")).toBe("no-store");
      /**
       * strict-origin, never no-referrer: under no-referrer browsers send
       * `Origin: null` on the form POST and setup could never complete.
       */
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    };

    test("GET with a live token and no cookie renders the form (public route)", async () => {
      const response = await app.handle(
        new Request(`http://localhost/dashboard/setup?token=${LIVE_TOKEN}`),
      );
      expect(response.status).toBe(200);
      expectAuthPageHeaders(response);
      const html = await response.text();
      expect(html).toContain('action="/dashboard/setup"');
      expect(html).toContain(`name="token" value="${LIVE_TOKEN}"`);
      expect(html).toContain("owner@example.com");
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
    });

    test("GET without, with a malformed or with an unknown token: identical 400s", async () => {
      const calls = findLiveOwnerSetup.mock.calls.length;
      const missing = await app.handle(new Request("http://localhost/dashboard/setup"));
      const malformed = await app.handle(
        new Request("http://localhost/dashboard/setup?token=not-a-token"),
      );
      /** Neither reached the database. */
      expect(findLiveOwnerSetup.mock.calls.length).toBe(calls);

      const unknown = await app.handle(
        new Request(`http://localhost/dashboard/setup?token=${UNKNOWN_TOKEN}`),
      );
      expect(findLiveOwnerSetup.mock.calls.length).toBe(calls + 1);

      const bodies: string[] = [];
      for (const response of [missing, malformed, unknown]) {
        expect(response.status).toBe(400);
        expectAuthPageHeaders(response);
        bodies.push(await response.text());
      }
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[2]).toBe(bodies[0]);
      expect(bodies[0]).toContain("reset-owner");
      expect(bodies[1]).not.toContain("not-a-token");
      expect(bodies[2]).not.toContain(UNKNOWN_TOKEN);
    });

    test("POST with Origin: null (what a no-referrer page would send) is 403", async () => {
      /**
       * Pins why the setup pages use strict-origin: a page under
       * no-referrer makes browsers send `Origin: null`, which the
       * same-origin check rightly rejects, so setup would be impossible.
       */
      const calls = completeOwnerSetup.mock.calls.length;
      const response = await postSetup(
        {
          token: LIVE_TOKEN,
          password: "a-long-enough-password",
          confirm: "a-long-enough-password",
        },
        { origin: "null" },
      );
      expect(response.status).toBe(403);
      expect(completeOwnerSetup.mock.calls.length).toBe(calls);
    });

    test("POST from another origin, or with no origin, is 403 before any work", async () => {
      const findCalls = findLiveOwnerSetup.mock.calls.length;
      const completeCalls = completeOwnerSetup.mock.calls.length;
      const fields = {
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      };

      const evil = await postSetup(fields, { origin: "http://evil.example" });
      expect(evil.status).toBe(403);
      expectAuthPageHeaders(evil);
      expect(evil.headers.get("set-cookie")).toBeNull();

      const noOrigin = await postSetup(fields, {});
      expect(noOrigin.status).toBe(403);

      expect(findLiveOwnerSetup.mock.calls.length).toBe(findCalls);
      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
      expect(warnLog).toHaveBeenCalledWith(
        "Owner setup POST rejected: cross-origin (possible CSRF)",
        expect.objectContaining({ origin: "http://evil.example" }),
      );
    });

    test("POST with a short password or a mismatch re-renders the form, no write", async () => {
      const completeCalls = completeOwnerSetup.mock.calls.length;

      const short = await postSetup({
        token: LIVE_TOKEN,
        password: "short",
        confirm: "short",
      });
      expect(short.status).toBe(200);
      expectAuthPageHeaders(short);
      const shortHtml = await short.text();
      expect(shortHtml).toContain("at least 15 characters");
      expect(shortHtml).toContain(`name="token" value="${LIVE_TOKEN}"`);

      const mismatch = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: `${GOOD_PASSWORD}!`,
      });
      expect(mismatch.status).toBe(200);
      const mismatchHtml = await mismatch.text();
      expect(mismatchHtml).toContain("do not match");
      expect(mismatchHtml).toContain(`name="token" value="${LIVE_TOKEN}"`);
      /** The password is never echoed back. */
      expect(mismatchHtml).not.toContain(GOOD_PASSWORD);

      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
    });

    test("POST with an unknown or malformed token is the invalid page, no write", async () => {
      const completeCalls = completeOwnerSetup.mock.calls.length;
      for (const token of [UNKNOWN_TOKEN, "bad"]) {
        const response = await postSetup({
          token,
          password: GOOD_PASSWORD,
          confirm: GOOD_PASSWORD,
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("not valid");
      }
      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
    });

    test("a valid POST signs in with the session cookie and redirects to /dashboard", async () => {
      warnLog.mockClear();
      const response = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(response.status).toBe(302);
      expectAuthPageHeaders(response);
      const location = response.headers.get("location");
      expect(location).toBe("/dashboard");
      expect(location).not.toContain(LIVE_TOKEN);

      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("bm_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/dashboard");

      expect(completeOwnerSetup).toHaveBeenLastCalledWith(LIVE_TOKEN, GOOD_PASSWORD);
      expect(warnLog).toHaveBeenCalledWith(
        "Owner setup completed",
        expect.objectContaining({ owner: "owner@example.com" }),
      );

      /** The issued cookie opens the dashboard. */
      const cookie = setCookie.match(/bm_session=([^;]+)/)?.[1] ?? "";
      const home = await app.handle(
        new Request("http://localhost/dashboard", {
          headers: { cookie: `bm_session=${cookie}` },
        }),
      );
      expect(home.status).toBe(200);
    });

    test("a token spent between the check and the write gets the invalid page", async () => {
      completeOwnerSetup.mockImplementationOnce(() => Promise.resolve(null));
      const response = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("not valid");
    });

    test("with the dashboard disabled, success shows the done page and sets no cookie", async () => {
      dashboardConfig.password = "";
      try {
        const response = await postSetup({
          token: LIVE_TOKEN,
          password: GOOD_PASSWORD,
          confirm: GOOD_PASSWORD,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await response.text()).toContain("Owner password saved");
      } finally {
        dashboardConfig.password = "test123";
      }
    });

    test("protected routes still redirect to login without a cookie", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/emails"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
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
