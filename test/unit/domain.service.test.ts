import { describe, test, expect, mock, beforeEach } from "bun:test";

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

mock.module("../../src/db/index.ts", () => ({
  db: {
    select: mock(() => chainable(selectResult)),
    insert: mock(() => chainable(insertResult)),
    delete: mock(() => chainable(deleteResult)),
  },
}));

const { listDomains, getDomainById, domainExistsByName, deleteDomain, getDkimDnsRecord } =
  await import("../../src/modules/domains/services/domain.service.ts");

const baseDomain = {
  id: "dom_x",
  name: "example.com",
  dkimPrivateKey: "v1:abc:def:ghi",
  dkimPublicKey:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----",
  dkimSelector: "bunmail",
  unsubscribeEmail: null,
  unsubscribeUrl: null,
  spfVerified: false,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  selectResult = [];
  insertResult = [];
  deleteResult = [];
});

describe("listDomains / getDomainById / domainExistsByName / deleteDomain", () => {
  test("listDomains returns the rows the chain resolves to", async () => {
    selectResult = [baseDomain, { ...baseDomain, id: "dom_2" }];
    const list = await listDomains();
    expect(list).toHaveLength(2);
  });

  test("getDomainById returns undefined when no row matches", async () => {
    selectResult = [];
    expect(await getDomainById("dom_missing")).toBeUndefined();
  });

  test("domainExistsByName returns true when a match exists", async () => {
    selectResult = [{ id: "dom_x" }];
    expect(await domainExistsByName("example.com")).toBe(true);
  });

  test("domainExistsByName returns false when no match", async () => {
    selectResult = [];
    expect(await domainExistsByName("missing.com")).toBe(false);
  });

  test("deleteDomain returns the deleted row when present", async () => {
    deleteResult = [baseDomain];
    expect((await deleteDomain("dom_x"))?.id).toBe("dom_x");
  });

  test("deleteDomain returns undefined when no row matched", async () => {
    deleteResult = [];
    expect(await deleteDomain("dom_missing")).toBeUndefined();
  });
});

describe("getDkimDnsRecord", () => {
  test("returns the v=DKIM1 string with the extracted public key", () => {
    const rec = getDkimDnsRecord(baseDomain);
    expect(rec).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
  });

  test("returns null when the domain has no public key", () => {
    expect(getDkimDnsRecord({ ...baseDomain, dkimPublicKey: null })).toBeNull();
  });
});
