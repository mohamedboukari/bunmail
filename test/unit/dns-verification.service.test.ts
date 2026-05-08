import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for the DNS verification service.
 *
 * Mocks `dns/promises.resolveTxt` to feed synthetic TXT records and
 * mocks the `db` import so the persistence step writes to a recorded
 * spy instead of Postgres. Verifies SPF / DKIM / DMARC parsing rules
 * including the multi-record DKIM concatenation case.
 */

let txtRecords: Record<string, string[][]> = {};
const dbUpdates: Array<Record<string, unknown>> = [];

/**
 * Both `resolveTxt` (used here) and `resolveMx` (used by mailer.service
 * tests in the same process) need to be exported so cross-file
 * `mock.module` calls don't shadow each other's missing exports.
 */
mock.module("dns/promises", () => ({
  resolveTxt: mock(async (hostname: string) => {
    if (hostname in txtRecords) return txtRecords[hostname];
    const err = new Error(`ENOTFOUND ${hostname}`) as Error & { code: string };
    err.code = "ENOTFOUND";
    throw err;
  }),
  resolveMx: mock(async () => []),
}));

mock.module("../../src/db/index.ts", () => ({
  db: {
    update: mock(() => ({
      set: mock((values: Record<string, unknown>) => {
        dbUpdates.push(values);
        return { where: mock(() => Promise.resolve()) };
      }),
    })),
  },
}));

const { verifyDomain } =
  await import("../../src/modules/domains/services/dns-verification.service.ts");

const baseDomain = {
  id: "dom_test",
  name: "example.com",
  dkimSelector: "bunmail",
  dkimPublicKey:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----",
  dkimPrivateKey: null,
  spfVerified: false,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null as Date | null,
  unsubscribeEmail: null as string | null,
  unsubscribeUrl: null as string | null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const expectedPubKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";

beforeEach(() => {
  txtRecords = {};
  dbUpdates.length = 0;
});

describe("verifyDomain — SPF", () => {
  test("returns true when an SPF record is present", async () => {
    txtRecords["example.com"] = [["v=spf1 a mx ip4:1.2.3.4 -all"]];
    txtRecords["bunmail._domainkey.example.com"] = [];
    txtRecords["_dmarc.example.com"] = [];

    const result = await verifyDomain(baseDomain);
    expect(result.spf).toBe(true);
  });

  test("returns false when no TXT records start with v=spf1", async () => {
    txtRecords["example.com"] = [["google-site-verification=abc"], ["another=record"]];
    const result = await verifyDomain(baseDomain);
    expect(result.spf).toBe(false);
  });

  test("returns false when DNS lookup throws (NOTFOUND, etc.)", async () => {
    /** No txtRecords set → resolveTxt throws → verifySPF catches and
     *  returns []. */
    const result = await verifyDomain(baseDomain);
    expect(result.spf).toBe(false);
  });
});

describe("verifyDomain — DKIM", () => {
  test("returns true when the DKIM record contains the expected public key", async () => {
    txtRecords["bunmail._domainkey.example.com"] = [
      [`v=DKIM1; k=rsa; p=${expectedPubKey}`],
    ];
    const result = await verifyDomain(baseDomain);
    expect(result.dkim).toBe(true);
  });

  test("handles split TXT records that need concatenation", async () => {
    /** Real-world: some DNS providers split long TXT values across
     *  multiple records. The verifier joins all records and tries the
     *  concatenated form. */
    const half1 = expectedPubKey.slice(0, 20);
    const half2 = expectedPubKey.slice(20);
    txtRecords["bunmail._domainkey.example.com"] = [
      [`v=DKIM1; k=rsa; p=${half1}`],
      [half2],
    ];
    const result = await verifyDomain(baseDomain);
    expect(result.dkim).toBe(true);
  });

  test("returns false when the published key doesn't match", async () => {
    txtRecords["bunmail._domainkey.example.com"] = [
      ["v=DKIM1; k=rsa; p=DIFFERENT_KEY_VALUE"],
    ];
    const result = await verifyDomain(baseDomain);
    expect(result.dkim).toBe(false);
  });

  test("returns false when the domain has no public key on file", async () => {
    txtRecords["bunmail._domainkey.example.com"] = [
      [`v=DKIM1; k=rsa; p=${expectedPubKey}`],
    ];
    const result = await verifyDomain({ ...baseDomain, dkimPublicKey: null });
    expect(result.dkim).toBe(false);
  });
});

describe("verifyDomain — DMARC", () => {
  test("returns true when a v=DMARC1 record is present at _dmarc.<domain>", async () => {
    txtRecords["_dmarc.example.com"] = [
      ["v=DMARC1; p=quarantine; rua=mailto:x@example.com"],
    ];
    const result = await verifyDomain(baseDomain);
    expect(result.dmarc).toBe(true);
  });

  test("returns false when no DMARC record exists", async () => {
    const result = await verifyDomain(baseDomain);
    expect(result.dmarc).toBe(false);
  });
});

describe("verifyDomain — persistence", () => {
  test("writes the verification result to the domains row with a fresh verifiedAt", async () => {
    txtRecords["example.com"] = [["v=spf1 -all"]];
    txtRecords["_dmarc.example.com"] = [["v=DMARC1; p=none"]];

    await verifyDomain(baseDomain);

    expect(dbUpdates).toHaveLength(1);
    const update = dbUpdates[0]!;
    expect(update.spfVerified).toBe(true);
    expect(update.dkimVerified).toBe(false);
    expect(update.dmarcVerified).toBe(true);
    expect(update.verifiedAt).toBeInstanceOf(Date);
  });
});
