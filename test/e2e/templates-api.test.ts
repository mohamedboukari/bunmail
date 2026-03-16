import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";

/**
 * E2E tests for the Templates API (/api/v1/templates).
 *
 * Tests the full HTTP request/response cycle for template CRUD endpoints.
 * Mocks the DB, auth middleware, and services to avoid requiring
 * a running database or valid API key.
 */

/** Serialized template shape returned by the API */
interface SerializedTemplate {
  id: string;
  name: string;
  subject: string;
  html: string | null;
  text: string | null;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

interface TemplateResponse {
  success: boolean;
  error?: string;
  data: SerializedTemplate;
}

interface TemplateListResponse {
  success: boolean;
  data: SerializedTemplate[];
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
const mockTemplate = {
  id: "tpl_test123",
  apiKeyId: "key_test",
  name: "Welcome",
  subject: "Welcome {{name}}",
  html: "<p>Hi {{name}}</p>",
  textContent: "Hi {{name}}",
  variables: ["name"],
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const updatedTemplate = {
  ...mockTemplate,
  name: "Updated Welcome",
  subject: "Updated Welcome {{name}}",
};

/* ─── Mock template service ─── */
mock.module("../../src/modules/templates/services/template.service.ts", () => ({
  createTemplate: mock(() => Promise.resolve(mockTemplate)),
  listTemplates: mock(() => Promise.resolve([mockTemplate])),
  getTemplateById: mock((id: string) =>
    Promise.resolve(id === "tpl_test123" ? mockTemplate : undefined),
  ),
  updateTemplate: mock((id: string) =>
    Promise.resolve(id === "tpl_test123" ? updatedTemplate : undefined),
  ),
  deleteTemplate: mock((id: string) =>
    Promise.resolve(id === "tpl_test123" ? mockTemplate : undefined),
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
const { templatesPlugin } =
  await import("../../src/modules/templates/templates.plugin.ts");

const app = new Elysia().use(templatesPlugin);

/* ─── Tests ─── */

describe("Templates API E2E", () => {
  describe("POST /api/v1/templates", () => {
    test("creates a template and returns serialized response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({
            name: "Welcome",
            subject: "Welcome {{name}}",
            html: "<p>Hi {{name}}</p>",
            text: "Hi {{name}}",
            variables: ["name"],
          }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as TemplateResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("tpl_test123");
      expect(body.data.name).toBe("Welcome");
      expect(body.data.subject).toBe("Welcome {{name}}");
      expect(body.data.variables).toEqual(["name"]);
    });

    test("returns 422 on missing required fields", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates", {
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

  describe("GET /api/v1/templates", () => {
    test("returns list of templates", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as TemplateListResponse;
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.name).toBe("Welcome");
    });
  });

  describe("GET /api/v1/templates/:id", () => {
    test("returns template when found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates/tpl_test123", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as TemplateResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("tpl_test123");
    });

    test("returns 404 when template not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates/tpl_nonexistent", {
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("Template not found");
    });
  });

  describe("PUT /api/v1/templates/:id", () => {
    test("updates template and returns serialized response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates/tpl_test123", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({
            name: "Updated Welcome",
            subject: "Updated Welcome {{name}}",
          }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as TemplateResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("tpl_test123");
      expect(body.data.name).toBe("Updated Welcome");
    });

    test("returns 404 when template not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates/tpl_nonexistent", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test_key",
          },
          body: JSON.stringify({ name: "Nope" }),
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("Template not found");
    });
  });

  describe("DELETE /api/v1/templates/:id", () => {
    test("deletes template and returns serialized response", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates/tpl_test123", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as TemplateResponse;
      expect(body.success).toBe(true);
      expect(body.data.id).toBe("tpl_test123");
    });

    test("returns 404 when template not found", async () => {
      const response = await app.handle(
        new Request("http://localhost/api/v1/templates/tpl_nonexistent", {
          method: "DELETE",
          headers: { authorization: "Bearer test_key" },
        }),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error).toBe("Template not found");
    });
  });
});
