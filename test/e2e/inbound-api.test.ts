import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";
import { readJson } from "../read-json.ts";

/**
 * E2E tests for the Inbound API (/api/v1/inbound).
 *
 * The inbound plugin now goes through `inbound.service.ts`, so we mock that
 * service directly: same pattern as the outbound emails test.
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

interface SerializedAttachment {
  position: number;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
}

interface InboundAttachmentsEmbedded {
  success: boolean;
  data: SerializedInboundEmail & { attachments: SerializedAttachment[] };
}

interface AttachmentListResponse {
  success: boolean;
  data: SerializedAttachment[];
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
    mail: { ...realConfig.config.mail, hostname: "localhost" },
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

/* ─── Mock DB (the service is mocked too, but the import graph still pulls db.ts) ─── */
void mock.module("../../src/db/index.ts", () => ({
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
  messageId: null,
  inReplyTo: null,
  references: null,
  inReplyToEmailId: null,
};

/** A received email with one PDF attachment in its raw message (#486). */
const mockInboundWithAttachment = {
  ...mockInbound,
  id: "inb_files",
  rawMessage: [
    "From: sender@gmail.com",
    "To: hello@example.com",
    "Subject: Files",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "See attached.",
    "--b",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 test").toString("base64"),
    "--b--",
    "",
  ].join("\r\n"),
};

const mockTrashedInbound = {
  ...mockInbound,
  id: "inb_trashed",
  deletedAt: new Date("2024-02-01"),
};

/* ─── Mock inbound service ─── */
void mock.module("../../src/modules/inbound/services/inbound.service.ts", () => ({
  listInboundEmails: mock(() => Promise.resolve({ data: [mockInbound], total: 1 })),
  listTrashedInboundEmails: mock(() =>
    Promise.resolve({ data: [mockTrashedInbound], total: 1 }),
  ),
  getInboundEmailById: mock((id: string) =>
    Promise.resolve(
      id === "inb_test123"
        ? mockInbound
        : id === "inb_files"
          ? mockInboundWithAttachment
          : undefined,
    ),
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
      const body = await readJson<InboundListResponse>(response);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe("inb_test123");
      expect(body.data[0]!.from).toBe("sender@gmail.com");
      expect(body.pagination.total).toBe(1);
      /** rawMessage must not be exposed */
      expect(body.data[0]).not.toHaveProperty("rawMessage");
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
      const body = await readJson<InboundResponse>(response);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("inb_test123");
    });

    test("includes attachment metadata", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_files", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<InboundAttachmentsEmbedded>(response);
      expect(body.data.attachments).toEqual([
        {
          position: 0,
          filename: "invoice.pdf",
          contentType: "application/pdf",
          size: 13,
          contentId: null,
        },
      ]);
    });

    test("returns 404 when inbound email not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_nope", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = await readJson<ErrorResponse>(response);
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
      const body = await readJson<InboundResponse>(response);
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
      const body = await readJson<BulkResponse>(response);
      expect(body.deleted).toBe(2);
    });

    test("GET /trash returns trashed inbound emails", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/trash", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<InboundListResponse>(response);
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
      const body = await readJson<InboundResponse>(response);
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
      const body = await readJson<BulkResponse>(response);
      expect(body.deleted).toBe(2);
    });
  });

  describe("GET /api/v1/inbound/:id/attachments (#486)", () => {
    test("lists the attachments", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_files/attachments", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<AttachmentListResponse>(response);
      expect(body.data.map((a) => a.filename)).toEqual(["invoice.pdf"]);
    });

    test("is empty when the raw message has none", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_test123/attachments", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      const body = await readJson<AttachmentListResponse>(response);
      expect(body.data).toEqual([]);
    });

    test("returns 404 for an unknown email", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_nope/attachments", {
          headers: { authorization: "Bearer test_key" },
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/v1/inbound/:id/attachments/:position (#486)", () => {
    test("downloads the bytes with forced-attachment headers", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_files/attachments/0", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("%PDF-1.4 test");
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename*=UTF-8''invoice.pdf",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    test("returns 404 past the last attachment or for a bad position", async () => {
      for (const position of ["1", "abc", "-1", "1000"]) {
        const response = await app.handle(
          new Request(
            `http://localhost/api/v1/inbound/inb_files/attachments/${position}`,
            {
              headers: { authorization: "Bearer test_key" },
            },
          ),
        );
        expect(response.status).toBe(404);
      }
    });

    test("returns 404 for an unknown email", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/inbound/inb_nope/attachments/0", {
          headers: { authorization: "Bearer test_key" },
        }),
      );
      expect(response.status).toBe(404);
    });
  });
});
