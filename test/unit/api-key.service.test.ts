import { describe, test, expect, mock, beforeEach } from "bun:test";

let selectResult: unknown[] = [];
let insertResult: unknown[] = [];
let updateResult: unknown[] = [];

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
    select: mock(() => chainable(selectResult)),
    insert: mock(() => chainable(insertResult)),
    update: mock(() => chainable(updateResult)),
  },
}));

const { createApiKey, listApiKeys, revokeApiKey, findByHash } =
  await import("../../src/modules/api-keys/services/api-key.service.ts");

const baseKey = {
  id: "key_x",
  name: "test",
  keyHash: "abc123",
  keyPrefix: "bm_live_xxxx",
  isActive: true,
  lastUsedAt: null,
  createdAt: new Date(),
};

beforeEach(() => {
  selectResult = [];
  insertResult = [];
  updateResult = [];
});

describe("createApiKey", () => {
  test("returns the inserted row + a raw key with bm_live_ prefix", async () => {
    insertResult = [baseKey];
    const result = await createApiKey({ name: "test" });
    expect(result.apiKey.id).toBe("key_x");
    expect(result.rawKey.startsWith("bm_live_")).toBe(true);
  });
});

describe("listApiKeys", () => {
  test("returns the rows the chain resolves to", async () => {
    selectResult = [baseKey, { ...baseKey, id: "key_2" }];
    const list = await listApiKeys();
    expect(list).toHaveLength(2);
  });
});

describe("revokeApiKey", () => {
  test("returns the row with isActive=false on success", async () => {
    updateResult = [{ ...baseKey, isActive: false }];
    const result = await revokeApiKey("key_x");
    expect(result?.isActive).toBe(false);
  });

  test("returns undefined when the key doesn't exist", async () => {
    updateResult = [];
    expect(await revokeApiKey("key_missing")).toBeUndefined();
  });
});

describe("findByHash", () => {
  test("returns the row when the hash matches", async () => {
    selectResult = [baseKey];
    const result = await findByHash("abc123");
    expect(result?.id).toBe("key_x");
  });

  test("returns undefined when no row matches", async () => {
    selectResult = [];
    expect(await findByHash("nope")).toBeUndefined();
  });
});
