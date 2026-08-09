import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for webhook.service.ts CRUD methods + the
 * `findWebhooksForEvent` filter (event membership over the JSON
 * array column).
 */

let selectResult: unknown[] = [];
let insertResult: unknown[] = [];
let deleteResult: unknown[] = [];

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

/**
 * Own the config mock (complete enough) so a leaked partial stub from an
 * earlier unit file can't shadow `config.webhookDelivery` — `createWebhook`
 * reads `config.webhookDelivery.allowInsecureHttp` for the SSRF guard (#128).
 * Bun's `mock.module` leaks across files; registering ours here (before the
 * import below) makes it the active one for this file. See the #121 fix.
 */
mock.module("../../src/config.ts", () => ({
  config: {
    env: "test",
    database: { url: "postgres://test:test@localhost:5432/test" },
    server: { port: 3000, host: "0.0.0.0" },
    mail: { hostname: "localhost" },
    dashboard: { password: "", sessionSecret: "test-secret" },
    webhookDelivery: { retentionDays: 30, allowInsecureHttp: false },
    logLevel: "error",
    logRedactPii: false,
  },
}));

mock.module("../../src/db/index.ts", () => ({
  db: {
    select: mock(() => chainable(selectResult)),
    insert: mock(() => chainable(insertResult)),
    delete: mock(() => chainable(deleteResult)),
  },
}));

const {
  createWebhook,
  listWebhooks,
  listAllWebhooks,
  deleteWebhook,
  findWebhooksForEvent,
} = await import("../../src/modules/webhooks/services/webhook.service.ts");

const baseHook = {
  id: "whk_x",
  apiKeyId: "key_owner",
  url: "https://93.184.216.34/hook",
  events: ["email.sent"],
  secret: "test-secret-32-bytes-padding-padding",
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  selectResult = [];
  insertResult = [];
  deleteResult = [];
});

describe("createWebhook", () => {
  test("returns the inserted row + a 64-char hex secret", async () => {
    insertResult = [baseHook];
    const result = await createWebhook(
      { url: "https://93.184.216.34/hook", events: ["email.sent"] },
      "key_owner",
    );
    expect(result.webhook.id).toBe("whk_x");
    expect(result.secret).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("listWebhooks / listAllWebhooks", () => {
  test("listWebhooks returns the rows the chain resolves to", async () => {
    selectResult = [baseHook, { ...baseHook, id: "whk_2" }];
    const list = await listWebhooks("key_owner");
    expect(list).toHaveLength(2);
  });

  test("listAllWebhooks returns rows unscoped", async () => {
    selectResult = [baseHook];
    const list = await listAllWebhooks();
    expect(list).toHaveLength(1);
  });
});

describe("deleteWebhook", () => {
  test("returns the deleted row when present", async () => {
    deleteResult = [baseHook];
    const result = await deleteWebhook("whk_x", "key_owner");
    expect(result?.id).toBe("whk_x");
  });

  test("returns undefined when the scoped delete matched nothing", async () => {
    deleteResult = [];
    expect(await deleteWebhook("whk_missing", "key_owner")).toBeUndefined();
  });
});

describe("findWebhooksForEvent", () => {
  test("returns only hooks whose events array includes the requested event", async () => {
    /** The service does the JSON-array filter in JS after the DB returns
     *  every active hook — we mimic that by feeding a varied list. */
    selectResult = [
      { ...baseHook, id: "w1", events: ["email.sent", "email.failed"] },
      { ...baseHook, id: "w2", events: ["email.bounced"] },
      { ...baseHook, id: "w3", events: ["email.sent"] },
    ];
    const sent = await findWebhooksForEvent("email.sent");
    expect(sent.map((h) => h.id).sort()).toEqual(["w1", "w3"]);
    selectResult = [
      { ...baseHook, id: "w1", events: ["email.sent", "email.failed"] },
      { ...baseHook, id: "w2", events: ["email.bounced"] },
      { ...baseHook, id: "w3", events: ["email.sent"] },
    ];
    const bounced = await findWebhooksForEvent("email.bounced");
    expect(bounced.map((h) => h.id)).toEqual(["w2"]);
  });

  test("returns empty array when no hooks subscribe to the event", async () => {
    selectResult = [{ ...baseHook, events: ["email.sent"] }];
    const result = await findWebhooksForEvent("email.queued");
    expect(result).toHaveLength(0);
  });
});
