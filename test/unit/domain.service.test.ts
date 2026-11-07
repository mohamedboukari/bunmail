import { describe, test, expect, mock, beforeEach } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  DomainAlreadyRegisteredError,
  InvalidDomainNameError,
} from "../../src/modules/domains/errors.ts";

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
  /** The Proxy answers any property chain the service builds, so it stands in for T by design. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return proxy as T;
}

void mock.module("../../src/db/index.ts", () => ({
  db: {
    select: mock(() => chainable(selectResult)),
    insert: mock(() => chainable(insertResult)),
    delete: mock(() => chainable(deleteResult)),
  },
}));

const {
  listDomains,
  getDomainById,
  domainExistsByName,
  deleteDomain,
  getDkimDnsRecord,
  createDomain,
  domainNameIs,
  findNonCanonicalDomainNames,
} = await import("../../src/modules/domains/services/domain.service.ts");

const baseDomain = {
  id: "dom_x",
  name: "example.com",
  dkimPrivateKey: "v1:abc:def:ghi",
  dkimPublicKey:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----",
  dkimSelector: "bunmail",
  unsubscribeEmail: null,
  unsubscribeUrl: null,
  notifyEmail: null,
  spfVerified: false,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null,
  lastCheckedAt: null,
  nextCheckAt: null,
  consecutiveFailures: 0,
  lastCheckResult: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdByUserId: null,
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

/** The bound values of a `domainNameIs` condition. */
function boundNames(name: string): unknown[] {
  return new PgDialect().sqlToQuery(domainNameIs(name)).params;
}

/** The error `createDomain` rejects with, or undefined when it resolves. */
async function createError(name: string): Promise<unknown> {
  try {
    await createDomain({ name });
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe("createDomain: the name (#406)", () => {
  test.each(["", "localhost", "https://example.com", "example.com:25", "-bad.com"])(
    "refuses %p with InvalidDomainNameError before any lookup",
    async (name) => {
      /** A row that would make it a duplicate: never reached. */
      selectResult = [{ id: "dom_x" }];
      const error = await createError(name);
      expect(error).toBeInstanceOf(InvalidDomainNameError);
      expect(error).toMatchObject({ code: "INVALID_DOMAIN_NAME" });
    },
  );

  test.each(["example.com", "Example.COM.", "  EXAMPLE.com  "])(
    "%p is a duplicate of a registered example.com, named in its stored form",
    async (name) => {
      selectResult = [{ id: "dom_x" }];
      const error = await createError(name);
      expect(error).toBeInstanceOf(DomainAlreadyRegisteredError);
      expect(error).toMatchObject({
        message: 'Domain "example.com" is already registered.',
      });
    },
  );

  test("an IDN is a duplicate of its A-label", async () => {
    selectResult = [{ id: "dom_x" }];
    const error = await createError("bücher.example");
    expect(error).toMatchObject({
      message: 'Domain "xn--bcher-kva.example" is already registered.',
    });
  });
});

describe("domainNameIs (#406)", () => {
  test("compares the normalised name", () => {
    expect(boundNames("example.com")).toEqual(["example.com"]);
    expect(boundNames("  Example.COM ")).toEqual(["example.com"]);
  });

  test("a final dot or a Unicode IDN also matches its form from before #406", () => {
    expect(boundNames("Example.COM.")).toEqual(["example.com", "example.com."]);
    expect(boundNames("bücher.example")).toEqual([
      "xn--bcher-kva.example",
      "bücher.example",
    ]);
  });
});

describe("findNonCanonicalDomainNames (#406)", () => {
  test("reports the names creation would refuse or store differently, not a case difference", async () => {
    selectResult = [
      { id: "dom_ok", name: "example.com" },
      { id: "dom_case", name: "Legacy.Example.com" },
      { id: "dom_dot", name: "example.org." },
      { id: "dom_idn", name: "bücher.example" },
      { id: "dom_bad", name: "localhost" },
      { id: "dom_url", name: "https://example.net" },
    ];
    expect(await findNonCanonicalDomainNames()).toEqual([
      { id: "dom_dot", name: "example.org.", normalized: "example.org" },
      { id: "dom_idn", name: "bücher.example", normalized: "xn--bcher-kva.example" },
      { id: "dom_bad", name: "localhost", normalized: null },
      { id: "dom_url", name: "https://example.net", normalized: null },
    ]);
  });

  test("reports nothing when every name is in normalised form", async () => {
    selectResult = [{ id: "dom_ok", name: "example.com" }];
    expect(await findNonCanonicalDomainNames()).toEqual([]);
  });
});
