import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the Emails API (/api/v1/emails).
 *
 * Tests the full HTTP request/response cycle for email endpoints.
 * Mocks the DB, auth middleware, and services to avoid requiring
 * a running database or valid API key.
 */

/** Serialized email shape returned by the API */
interface SerializedEmail {
  id: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  messageId: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface EmailResponse {
  success: boolean;
  error?: string;
  data: SerializedEmail;
}

interface EmailListResponse {
  success: boolean;
  data: SerializedEmail[];
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

/* ─── Mock DB ─── */
mock.module("../../src/db/index.ts", () => ({
  db: {},
}));

/* ─── Test data ─── */
const mockEmail = {
  id: "msg_test123",
  apiKeyId: "key_test",
  domainId: "dom_test",
  fromAddress: "hello@example.com",
  toAddress: "user@test.com",
  cc: null,
  bcc: null,
  subject: "Test",
  html: "<p>Test</p>",
  textContent: "Test",
  status: "queued",
  attempts: 0,
  lastError: null,
  messageId: null,
  sentAt: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  deletedAt: null as Date | null,
};

const mockTrashedEmail = {
  ...mockEmail,
  id: "msg_trashed",
  deletedAt: new Date("2024-02-01"),
};

/* ─── Mock email service ─── */
mock.module("../../src/modules/emails/services/email.service.ts", () => ({
  createEmail: mock(() => Promise.resolve(mockEmail)),
  listEmails: mock(() => Promise.resolve({ data: [mockEmail], total: 1 })),
  listAllEmails: mock(() => Promise.resolve({ data: [mockEmail], total: 1 })),
  getEmailById: mock((id: string) =>
    Promise.resolve(id === "msg_test123" ? mockEmail : undefined),
  ),
  getEmailByIdUnscoped: mock((id: string) =>
    Promise.resolve(id === "msg_test123" ? mockEmail : undefined),
  ),
  getTrashedEmailByIdUnscoped: mock((id: string) =>
    Promise.resolve(id === "msg_trashed" ? mockTrashedEmail : undefined),
  ),
  trashEmail: mock((id: string) =>
    Promise.resolve(id === "msg_test123" ? mockTrashedEmail : undefined),
  ),
  trashEmails: mock((ids: string[]) => Promise.resolve(ids.length)),
  listTrashedEmails: mock(() => Promise.resolve({ data: [mockTrashedEmail], total: 1 })),
  listTrashedEmailsUnscoped: mock(() =>
    Promise.resolve({ data: [mockTrashedEmail], total: 1 }),
  ),
  restoreEmail: mock((id: string) =>
    Promise.resolve(id === "msg_trashed" ? mockEmail : undefined),
  ),
  restoreEmailUnscoped: mock((id: string) =>
    Promise.resolve(id === "msg_trashed" ? mockEmail : undefined),
  ),
  permanentDeleteEmail: mock((id: string) =>
    Promise.resolve(id === "msg_trashed" ? mockTrashedEmail : undefined),
  ),
  permanentDeleteEmailUnscoped: mock((id: string) =>
    Promise.resolve(id === "msg_trashed" ? mockTrashedEmail : undefined),
  ),
  emptyEmailsTrash: mock(() => Promise.resolve(3)),
  emptyEmailsTrashUnscoped: mock(() => Promise.resolve(3)),
  trashEmailUnscoped: mock((id: string) =>
    Promise.resolve(id === "msg_test123" ? mockTrashedEmail : undefined),
  ),
  trashEmailsUnscoped: mock((ids: string[]) => Promise.resolve(ids.length)),
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
const { emailsPlugin } = await import("../../src/modules/emails/emails.plugin.ts");

const app = new Elysia().use(emailsPlugin);

/* ─── Tests ─── */

describe("Emails API E2E", () => {
  describe("POST /api/v1/emails/send", () => {
    test("creates an email and returns serialized response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({
            from: "hello@example.com",
            to: "user@test.com",
            subject: "Test",
            html: "<p>Test</p>",
          }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmailResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("msg_test123");
      expect(body.data.from).toBe("hello@example.com");
      expect(body.data.to).toBe("user@test.com");
      expect(body.data.subject).toBe("Test");
      expect(body.data.status).toBe("queued");
    });

    test("returns 422 on missing required fields", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/send", {
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

  describe("GET /api/v1/emails", () => {
    test("returns paginated list of emails", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmailListResponse;
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe("msg_test123");
      expect(body.pagination.total).toBe(1);
    });
  });

  describe("GET /api/v1/emails/:id", () => {
    test("returns email when found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/msg_test123", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmailResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("msg_test123");
    });

    test("returns 404 when email not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/msg_nonexistent", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("Email not found");
    });
  });

  describe("Trash endpoints", () => {
    test("DELETE /:id moves email to trash and returns it", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/msg_test123", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmailResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("msg_trashed");
    });

    test("DELETE /:id returns 404 when email not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/msg_nope", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
    });

    test("POST /bulk-delete returns the count trashed", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/bulk-delete", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ ids: ["a", "b", "c"] }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; deleted: number };
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(3);
    });

    test("GET /trash returns trashed emails", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/trash", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmailListResponse;
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe("msg_trashed");
    });

    test("POST /:id/restore restores a trashed email", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/msg_trashed/restore", {
          method: "POST",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmailResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("msg_test123");
    });

    test("POST /:id/restore returns 404 when not in trash", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/msg_test123/restore", {
          method: "POST",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
    });

    test("DELETE /:id/permanent removes a trashed email", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/msg_trashed/permanent", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as EmailResponse;
      expect(body.success).toBe(true);
    });

    test("POST /trash/empty returns total purged", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/emails/trash/empty", {
          method: "POST",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean; deleted: number };
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(3);
    });
  });
});
