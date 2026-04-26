import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the Inbound API (/api/v1/inbound).
 *
 * The inbound plugin now goes through `inbound.service.ts`, so we mock that
 * service directly — same pattern as the outbound emails test.
 */

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

interface BulkResponse {
  success: boolean;
  deleted: number;
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

/* ─── Mock DB (the service is mocked too, but the import graph still pulls db.ts) ─── */
mock.module("../../src/db/index.ts", () => ({
  db: {},
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
  deletedAt: null as Date | null,
};

const mockTrashedInbound = {
  ...mockInbound,
  id: "inb_trashed",
  deletedAt: new Date("2024-02-01"),
};

/* ─── Mock inbound service ─── */
mock.module("../../src/modules/inbound/services/inbound.service.ts", () => ({
  listInboundEmails: mock(() => Promise.resolve({ data: [mockInbound], total: 1 })),
  listTrashedInboundEmails: mock(() =>
    Promise.resolve({ data: [mockTrashedInbound], total: 1 }),
  ),
  getInboundEmailById: mock((id: string) =>
    Promise.resolve(id === "inb_test123" ? mockInbound : undefined),
  ),
  getTrashedInboundEmailById: mock((id: string) =>
    Promise.resolve(id === "inb_trashed" ? mockTrashedInbound : undefined),
  ),
  trashInboundEmail: mock((id: string) =>
    Promise.resolve(id === "inb_test123" ? mockTrashedInbound : undefined),
  ),
  trashInboundEmails: mock((ids: string[]) => Promise.resolve(ids.length)),
  restoreInboundEmail: mock((id: string) =>
    Promise.resolve(id === "inb_trashed" ? mockInbound : undefined),
  ),
  permanentDeleteInboundEmail: mock((id: string) =>
    Promise.resolve(id === "inb_trashed" ? mockTrashedInbound : undefined),
  ),
  emptyInboundTrash: mock(() => Promise.resolve(2)),
}));

/* ─── Mock auth + rate limit ─── */
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
    });

    test("returns 404 when inbound email not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_nope", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("Inbound email not found");
    });
  });

  describe("Trash endpoints", () => {
    test("DELETE /:id moves inbound to trash", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_test123", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as InboundResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("inb_trashed");
    });

    test("POST /bulk-delete returns the count trashed", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/bulk-delete", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ ids: ["a", "b"] }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as BulkResponse;
      expect(body.deleted).toBe(2);
    });

    test("GET /trash returns trashed inbound emails", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/trash", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as InboundListResponse;
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe("inb_trashed");
    });

    test("POST /:id/restore restores a trashed inbound", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_trashed/restore", {
          method: "POST",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as InboundResponse;
      expect(body.data.id).toBe("inb_test123");
    });

    test("DELETE /:id/permanent removes a trashed inbound", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_trashed/permanent", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
    });

    test("POST /trash/empty returns total purged", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/trash/empty", {
          method: "POST",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as BulkResponse;
      expect(body.deleted).toBe(2);
    });
  });
});
