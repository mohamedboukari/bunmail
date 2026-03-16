import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the Inbound API (/api/v1/inbound).
 *
 * Tests the full HTTP request/response cycle for inbound email endpoints.
 * The inbound plugin accesses the DB directly (no service layer), so we
 * mock `db` with chainable Drizzle-style query builder methods.
 */

/** Serialized inbound email shape returned by the API */
interface SerializedInboundEmail {
  id: string;
  from: string;
  to: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  receivedAt: string;
}

interface InboundResponse {
  success: boolean;
  error?: string;
  data: SerializedInboundEmail;
}

interface InboundListResponse {
  success: boolean;
  data: SerializedInboundEmail[];
  pagination: { page: number; limit: number; total: number };
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

/* ─── Test data ─── */
const mockInbound = {
  id: "inb_test123",
  fromAddress: "sender@gmail.com",
  toAddress: "hello@example.com",
  subject: "Test inbound",
  html: "<p>Inbound test</p>",
  textContent: "Inbound test",
  rawMessage: "raw...",
  receivedAt: new Date("2024-01-01"),
  createdAt: new Date("2024-01-01"),
};

/**
 * Build a chainable mock that mimics Drizzle's select().from().where().orderBy().limit().offset().
 *
 * The list endpoint runs two parallel queries (data + count) via Promise.all.
 * We track which call is which by checking if `where` was called (single item)
 * or if `orderBy` was called (list query). The count query calls neither.
 */
function createChainableSelect() {
  let hasWhere = false;
  let hasOrderBy = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {
    from: mock(() => chain),
    where: mock((_condition: unknown) => {
      hasWhere = true;
      return chain;
    }),
    orderBy: mock(() => {
      hasOrderBy = true;
      return chain;
    }),
    limit: mock(() => chain),
    offset: mock(() => chain),
    then: (resolve: (value: unknown) => void) => {
      if (hasWhere) {
        resolve([mockInbound]);
      } else if (hasOrderBy) {
        resolve([mockInbound]);
      } else {
        resolve([{ count: 1 }]);
      }
    },
  };

  return chain;
}

/* ─── Mock DB with chainable query builder ─── */
mock.module("../../src/db/index.ts", () => ({
  db: {
    select: mock(() => createChainableSelect()),
  },
}));

/* ─── Mock drizzle-orm functions used by the plugin ─── */
mock.module("drizzle-orm", () => ({
  desc: mock(() => "desc"),
  sql: Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => "sql-tag",
    { raw: (s: string) => s },
  ),
  eq: mock(() => "eq-condition"),
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
const { inboundPlugin } = await import("../../src/modules/inbound/inbound.plugin.ts");

const app = new Elysia().use(inboundPlugin);

/* ─── Tests ─── */

describe("Inbound API E2E", () => {
  describe("GET /api/v1/inbound", () => {
    test("returns paginated list of inbound emails", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as InboundListResponse;
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe("inb_test123");
      expect(body.data[0]!.from).toBe("sender@gmail.com");
      expect(body.data[0]!.to).toBe("hello@example.com");
      expect(body.pagination.total).toBe(1);
      /** rawMessage must not be exposed */
      expect(
        (body.data[0] as unknown as Record<string, unknown>).rawMessage,
      ).toBeUndefined();
    });
  });

  describe("GET /api/v1/inbound/:id", () => {
    test("returns inbound email when found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_test123", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as InboundResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("inb_test123");
      expect(body.data.subject).toBe("Test inbound");
    });

    test("returns 404 when inbound email not found", async () => {
      /** Override db mock for the not-found case */
      const { db } = await import("../../src/db/index.ts");
      (db as unknown as Record<string, unknown>).select = mock(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: Record<string, any> = {
          from: mock(() => chain),
          where: mock(() => chain),
          orderBy: mock(() => chain),
          limit: mock(() => chain),
          offset: mock(() => chain),
          then: (resolve: (value: unknown) => void) => {
            resolve([]);
          },
        };
        return chain;
      });

      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_nonexistent", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("Inbound email not found");
    });
  });
});
