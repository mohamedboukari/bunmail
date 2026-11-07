import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";
import { readJson } from "../read-json.ts";
import { InvalidDomainNameError } from "../../src/modules/domains/errors.ts";
import { parseDomainName } from "../../src/modules/domains/services/domain-name.ts";

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
  dnsRecords: Array<{ type: string; host: string; value: string; optional: boolean }>;
  dmarc: { status: string; policy: string | null } | null;
  mx: { status: string; hosts: string[] } | null;
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
  code?: string;
}

/* ─── Mock config ─── */
/** The real module, spread under the stub so every export exists (#293). */
const realConfig = await import("../../src/config.ts");

void mock.module("../../src/config.ts", () => ({
  ...realConfig,
  config: {
    ...realConfig.config,
    database: {
      ...realConfig.config.database,
      url: "postgres://test:test@localhost/test",
    },
    server: { ...realConfig.config.server, port: 3000, host: "0.0.0.0" },
    mail: { ...realConfig.config.mail, hostname: "localhost", publicIps: [] },
    smtp: { ...realConfig.config.smtp, enabled: false },
    dashboard: { ...realConfig.config.dashboard, ownerEmail: null },
    logLevel: "error",
  },
}));

/* ─── Mock logger ─── */
/** The real module, spread under the stub so every export exists (#293). */
const realLogger = await import("../../src/utils/logger.ts");

void mock.module("../../src/utils/logger.ts", () => ({
  ...realLogger,
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

/* ─── Mock DB ─── */
void mock.module("../../src/db/index.ts", () => ({
  db: {},
}));

/* ─── Test data ─── */
const mockDomain = {
  id: "dom_test123",
  name: "example.com",
  dkimPrivateKey:
    "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
  dkimPublicKey: "-----BEGIN PUBLIC KEY-----\nPUBLIC\n-----END PUBLIC KEY-----",
  dkimSelector: "bunmail",
  dkimPendingSelector: null,
  dkimPendingPrivateKey: null,
  dkimPendingPublicKey: null,
  dkimPendingCreatedAt: null,
  dkimPreviousSelector: null,
  dkimPreviousPublicKey: null,
  dkimRotatedAt: null,
  spfVerified: false,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null,
  lastCheckedAt: null,
  nextCheckAt: null,
  consecutiveFailures: 0,
  lastCheckResult: null,
  unsubscribeEmail: null as string | null,
  unsubscribeUrl: null as string | null,
  notifyEmail: null as string | null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

/* ─── Mock domain service ─── */
void mock.module("../../src/modules/domains/services/domain.service.ts", () => ({
  /** Refuses a name as the real service does (#406), so the 422 path is exercised. */
  createDomain: mock((input: { name: string }) =>
    parseDomainName(input.name) === null
      ? Promise.reject(new InvalidDomainNameError())
      : Promise.resolve(mockDomain),
  ),
  suggestedSpfRecord: mock(() => "v=spf1 a:mail.example.com -all"),
  spfAuthorizationTerm: mock(() => "a:mail.example.com"),
  listDomains: mock(() => Promise.resolve([mockDomain])),
  getDomainById: mock((id: string) =>
    Promise.resolve(id === "dom_test123" ? mockDomain : undefined),
  ),
  deleteDomain: mock((id: string) =>
    Promise.resolve(id === "dom_test123" ? mockDomain : undefined),
  ),
  getDkimDnsRecord: mock(() => null),
  /** Not on these routes; present so a leak of this mock has no holes (#293). */
  getDomainByName: mock(() => Promise.resolve(undefined)),
  domainExistsByName: mock(() => Promise.resolve(false)),
  updateDomainNotifyEmail: mock(() => Promise.resolve(undefined)),
  updateDomainSettings: mock(() => Promise.resolve(undefined)),
  domainNameIs: mock(() => undefined),
  findNonCanonicalDomainNames: mock(() => Promise.resolve([])),
}));

/* ─── Mock the live DNS status (#250): no real DNS in e2e ─── */
const dnsStatus = {
  dmarc: {
    status: "pass",
    ok: true,
    reason: "DMARC policy reject at _dmarc.example.com",
    warnings: [],
    problems: [],
    recordDomain: "example.com",
    inherited: false,
    policy: "reject",
    subdomainPolicy: null,
    effectivePolicy: "reject",
    pct: 100,
    adkim: "r",
    aspf: "r",
    rua: [],
  },
  mx: { status: "elsewhere", hosts: ["aspmx.l.google.com"] },
};
/** Every export: mock.module leaks across files. */
void mock.module(
  "../../src/modules/domains/services/domain-dns-status.service.ts",
  () => ({
    getDomainDnsStatus: mock(() => Promise.resolve(dnsStatus)),
    getDomainsDnsStatus: mock((names: string[]) =>
      Promise.resolve(names.map(() => dnsStatus)),
    ),
    DNS_STATUS_CONCURRENCY: 8,
    resolveDomainTxt: mock(() =>
      Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" })),
    ),
    rememberDmarcCheck: mock(() => {}),
    setDomainDnsDeps: mock(() => {}),
    mailFlowFeatures: mock(() => []),
  }),
);

/* ─── Mock auth + rate limit middleware ─── */
void mock.module("../../src/middleware/auth.ts", () => ({
  authMiddleware: new Elysia({ name: "auth-middleware" }).derive(() => ({
    apiKeyId: "key_test",
    apiKeyName: "Test Key",
  })),
  adminMiddleware: new Elysia({ name: "admin-middleware" }),
}));

void mock.module("../../src/middleware/rate-limit.ts", () => ({
  rateLimitMiddleware: new Elysia({ name: "rate-limit-middleware" }),
  startRateLimitCleanup: () => {},
  stopRateLimitCleanup: () => {},
}));

/* ─── Import plugin after mocking ─── */
const { domainsPlugin } = await import("../../src/modules/domains/domains.plugin.ts");

/**
 * Test app instance with the domains plugin, and the invalid domain name
 * branch of the global onError in `src/app.ts` (#406).
 */
const app = new Elysia()
  .onError(({ error, set }) => {
    if (error instanceof InvalidDomainNameError) {
      set.status = 422;
      return { success: false, error: error.message, code: error.code };
    }
  })
  .use(domainsPlugin);

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
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<DomainResponse>(response);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("dom_test123");
      expect(body.data.name).toBe("example.com");
      /** Private key must not be exposed */
      expect(body.data.dkimPrivateKey).toBeUndefined();
      expect(body.data.dkimPublicKey).toBeUndefined();
    });

    test.each(["https://example.com", "localhost", "example.com:25", "exa mple.com"])(
      "returns 422 INVALID_DOMAIN_NAME for %p, without echoing it (#406)",
      async (name) => {
        const response = await app.handle(
          new Request("http://localhost/api/v1/domains", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test_key",
            },
            body: JSON.stringify({ name }),
          }),
        );
        expect(response.status).toBe(422);
        const body = await readJson<ErrorResponse>(response);
        expect(body).toEqual({
          success: false,
          error: new InvalidDomainNameError().message,
          code: "INVALID_DOMAIN_NAME",
        });
        expect(body.error).not.toContain(name);
      },
    );

    test("returns 422 on missing name", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains", {
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
  });

  describe("GET /api/v1/domains", () => {
    test("returns list of domains", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<DomainListResponse>(response);
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
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<DomainResponse>(response);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("dom_test123");
      /** DNS guidance and status (#250). */
      expect(body.data.dnsRecords.map((r) => r.type)).toEqual([
        "TXT",
        "TXT",
        "A",
        "PTR",
        "MX",
      ]);
      expect(body.data.dmarc?.policy).toBe("reject");
      expect(body.data.mx).toEqual({
        status: "elsewhere",
        hosts: ["aspmx.l.google.com"],
      });
    });

    test("returns 404 when domain not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains/dom_nonexistent", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = await readJson<ErrorResponse>(response);
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
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<DomainResponse>(response);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("dom_test123");
      /** A deleted domain is not looked up. */
      expect(body.data.dmarc).toBeNull();
      expect(body.data.mx).toBeNull();
    });

    test("returns 404 when domain not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/domains/dom_nonexistent", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = await readJson<ErrorResponse>(response);
      expect(body.success).toBe(false);
    });
  });
});
