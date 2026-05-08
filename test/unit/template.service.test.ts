import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for the template service.
 *
 * The DB is mocked via a chain-proxy that returns a configurable
 * fixture per test. The tests verify return-value plumbing and the
 * `getTemplateById` early-return short-circuit in `updateTemplate`.
 *
 * Real CRUD against Postgres is also exercised in integration tests
 * (when the template integration spec is added) — those catch the
 * actual SQL bugs Drizzle would emit. These mocked tests catch
 * argument shape and return-value branching.
 */

interface FixtureConfig {
  selectResult?: unknown[];
  insertResult?: unknown[];
  updateResult?: unknown[];
  deleteResult?: unknown[];
}

let fixture: FixtureConfig = {};

/**
 * Builds a Drizzle-shaped chainable proxy that resolves to the supplied
 * fixture when awaited. Every method call returns the same proxy so the
 * full chain (`.from().where().limit()` etc.) composes without errors.
 */
function chainable<T>(result: T): T {
  const handler: ProxyHandler<object> = {
    get(_, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(result);
      }
      return () => proxy;
    },
  };
  const proxy = new Proxy({}, handler);
  return proxy as T;
}

mock.module("../../src/db/index.ts", () => ({
  db: {
    select: mock(() => chainable(fixture.selectResult ?? [])),
    insert: mock(() => chainable(fixture.insertResult ?? [])),
    update: mock(() => chainable(fixture.updateResult ?? [])),
    delete: mock(() => chainable(fixture.deleteResult ?? [])),
  },
}));

const {
  createTemplate,
  listTemplates,
  listAllTemplates,
  getTemplateById,
  getTemplateByIdUnscoped,
  updateTemplate,
  deleteTemplate,
} = await import("../../src/modules/templates/services/template.service.ts");

const tplFixture = {
  id: "tpl_test",
  apiKeyId: "key_owner",
  name: "welcome",
  subject: "Hi {{name}}",
  html: "<p>Hi {{name}}</p>",
  textContent: "Hi {{name}}",
  variables: ["name"],
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  fixture = {};
});

describe("createTemplate", () => {
  test("returns the inserted row", async () => {
    fixture.insertResult = [tplFixture];
    const result = await createTemplate(
      { name: "welcome", subject: "Hi {{name}}", variables: ["name"] },
      "key_owner",
    );
    expect(result.id).toBe("tpl_test");
    expect(result.subject).toBe("Hi {{name}}");
  });

  test("defaults html / text / variables to nullable / empty when not provided", async () => {
    /** Mostly verifies the call doesn't throw on missing optional fields. */
    fixture.insertResult = [
      { ...tplFixture, html: null, textContent: null, variables: [] },
    ];
    const result = await createTemplate({ name: "noop", subject: "x" }, "key_owner");
    expect(result.html).toBeNull();
    expect(result.variables).toEqual([]);
  });
});

describe("listTemplates / listAllTemplates", () => {
  test("listTemplates returns the rows the chain resolves to", async () => {
    fixture.selectResult = [tplFixture, { ...tplFixture, id: "tpl_2" }];
    const list = await listTemplates("key_owner");
    expect(list).toHaveLength(2);
  });

  test("listAllTemplates returns the rows (unscoped)", async () => {
    fixture.selectResult = [tplFixture];
    const list = await listAllTemplates();
    expect(list).toHaveLength(1);
  });
});

describe("getTemplateById / getTemplateByIdUnscoped", () => {
  test("returns the row when present", async () => {
    fixture.selectResult = [tplFixture];
    const t = await getTemplateById("tpl_test", "key_owner");
    expect(t?.id).toBe("tpl_test");
  });

  test("returns undefined when no rows match", async () => {
    fixture.selectResult = [];
    const t = await getTemplateById("tpl_missing", "key_owner");
    expect(t).toBeUndefined();
  });

  test("getTemplateByIdUnscoped behaves the same shape", async () => {
    fixture.selectResult = [tplFixture];
    const t = await getTemplateByIdUnscoped("tpl_test");
    expect(t?.id).toBe("tpl_test");
  });
});

describe("updateTemplate", () => {
  test("returns undefined when the template doesn't exist (early return)", async () => {
    fixture.selectResult = [];
    const result = await updateTemplate("tpl_missing", "key_owner", { name: "new-name" });
    expect(result).toBeUndefined();
  });

  test("returns the updated row when the template exists", async () => {
    fixture.selectResult = [tplFixture];
    fixture.updateResult = [{ ...tplFixture, name: "updated" }];
    const result = await updateTemplate("tpl_test", "key_owner", { name: "updated" });
    expect(result?.name).toBe("updated");
  });

  test("supports partial updates with html only", async () => {
    fixture.selectResult = [tplFixture];
    fixture.updateResult = [{ ...tplFixture, html: "<p>new</p>" }];
    const result = await updateTemplate("tpl_test", "key_owner", { html: "<p>new</p>" });
    expect(result?.html).toBe("<p>new</p>");
  });
});

describe("deleteTemplate", () => {
  test("returns the deleted row when present", async () => {
    fixture.deleteResult = [tplFixture];
    const result = await deleteTemplate("tpl_test", "key_owner");
    expect(result?.id).toBe("tpl_test");
  });

  test("returns undefined when no row matched the scoped delete", async () => {
    fixture.deleteResult = [];
    const result = await deleteTemplate("tpl_missing", "key_owner");
    expect(result).toBeUndefined();
  });
});
