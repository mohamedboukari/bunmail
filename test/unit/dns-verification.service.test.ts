import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { DNSResolver } from "mailauth";
import type { VerificationDeps } from "../../src/modules/domains/services/dns-verification.service.ts";

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
void mock.module("dns/promises", () => ({
  resolveTxt: mock(async (hostname: string) => {
    if (hostname in txtRecords) return txtRecords[hostname];
    const err = Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    throw err;
  }),
  resolveMx: mock(async () => []),
  resolve4: mock(async () => []),
  resolve6: mock(async () => []),
  reverse: mock(async () => []),
  lookup: mock(async () => []),
}));

/** The domain row the fake transaction locks and reads. */
let currentRow: Record<string, unknown> = {};
/** Statements `enqueueEvent` ran on the fake transaction. */
let executed = 0;

/** The parts of a drizzle transaction `applyDomainCheck` uses. */
const fakeTx = {
  select: () => ({
    from: () => ({ where: () => ({ for: () => Promise.resolve([currentRow]) }) }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => {
      dbUpdates.push(values);
      return {
        where: () => ({
          returning: () => Promise.resolve([{ ...currentRow, ...values }]),
        }),
      };
    },
  }),
  execute: () => {
    executed++;
    return Promise.resolve([]);
  },
};

void mock.module("../../src/db/index.ts", () => ({
  db: {
    transaction: mock((fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx)),
  },
}));

const { verifyDomain } =
  await import("../../src/modules/domains/services/dns-verification.service.ts");
const { spf: mailauthSpf } = await import("mailauth/lib/spf");

const baseDomain = {
  id: "dom_test",
  name: "example.com",
  dkimSelector: "bunmail",
  dkimPendingSelector: null,
  dkimPendingPrivateKey: null,
  dkimPendingPublicKey: null,
  dkimPendingCreatedAt: null,
  dkimPreviousSelector: null,
  dkimPreviousPublicKey: null,
  dkimRotatedAt: null,
  dkimPublicKey:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----",
  dkimPrivateKey: null,
  spfVerified: false,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null as Date | null,
  lastCheckedAt: null,
  nextCheckAt: null,
  consecutiveFailures: 0,
  lastCheckResult: null,
  unsubscribeEmail: null as string | null,
  unsubscribeUrl: null as string | null,
  notifyEmail: null as string | null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdByUserId: null,
};

const expectedPubKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";

beforeEach(() => {
  txtRecords = {};
  dbUpdates.length = 0;
  currentRow = { ...baseDomain };
  executed = 0;
});

/** A and AAAA records for the fake SPF resolver. */
let addressRecords: Record<string, string[]> = {};

/** DNS for mailauth: TXT from `txtRecords`, A/AAAA from `addressRecords`. */
const fakeResolver: DNSResolver = async (name, rrtype) => {
  if (rrtype === "TXT" && name in txtRecords) return txtRecords[name] ?? [];
  if ((rrtype === "A" || rrtype === "AAAA") && name in addressRecords) {
    return addressRecords[name] ?? [];
  }
  throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" });
};

/** Real RFC 7208 evaluation (mailauth, strict) over the fake DNS, for the given sending IPs. */
function spfDeps(ips: string[]): VerificationDeps {
  return {
    resolveTxt: async (hostname) => {
      if (hostname in txtRecords) return txtRecords[hostname] ?? [];
      throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    },
    evaluateSpf: async (domain, ip) =>
      (
        await mailauthSpf({
          sender: `postmaster@${domain}`,
          ip,
          helo: "mail.example.com",
          mta: "test",
          strict: true,
          resolver: fakeResolver,
        })
      ).status.result,
    sendingIps: async () => ({ ips, source: "MAIL_PUBLIC_IP" }),
  };
}

describe("verifyDomain: SPF (#247)", () => {
  beforeEach(() => {
    addressRecords = {};
  });

  test("passes when the record authorizes every sending IP", async () => {
    txtRecords["example.com"] = [["v=spf1 ip4:203.0.113.10 ip6:2001:db8::/32 -all"]];
    const result = await verifyDomain(
      baseDomain,
      spfDeps(["203.0.113.10", "2001:db8::5"]),
    );
    expect(result.spf).toBe(true);
    expect(result.spfReason).toContain("passes");
  });

  test("follows include and a mechanisms", async () => {
    txtRecords["example.com"] = [["v=spf1 include:_spf.example.com -all"]];
    txtRecords["_spf.example.com"] = [["v=spf1 a:mail.example.com -all"]];
    addressRecords["mail.example.com"] = ["203.0.113.10"];
    expect((await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]))).spf).toBe(true);
  });

  test("a record that only exists is not enough: v=spf1 -all fails", async () => {
    txtRecords["example.com"] = [["v=spf1 -all"]];
    const result = await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));
    expect(result.spf).toBe(false);
    expect(result.spfReason).toContain("SPF fail for 203.0.113.10");
  });

  test("another provider's record that omits this server soft-fails", async () => {
    txtRecords["example.com"] = [["v=spf1 include:_spf.provider.example ~all"]];
    txtRecords["_spf.provider.example"] = [["v=spf1 ip4:198.51.100.0/24 ~all"]];
    const result = await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));
    expect(result.spf).toBe(false);
    expect(result.spfReason).toContain("softfail");
  });

  test("every sending IP must pass", async () => {
    txtRecords["example.com"] = [["v=spf1 ip4:203.0.113.10 -all"]];
    const result = await verifyDomain(
      baseDomain,
      spfDeps(["203.0.113.10", "203.0.113.11"]),
    );
    expect(result.spf).toBe(false);
    expect(result.spfReason).toContain("203.0.113.11");
  });

  test("two SPF records are a permerror", async () => {
    txtRecords["example.com"] = [
      ["v=spf1 ip4:203.0.113.10 -all"],
      ["v=spf1 include:x.example -all"],
    ];
    const result = await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));
    expect(result.spf).toBe(false);
    expect(result.spfReason).toContain("More than one SPF record");
  });

  test("a pasted placeholder is refused", async () => {
    txtRecords["example.com"] = [["v=spf1 a mx ip4:<YOUR_SERVER_IP> -all"]];
    const result = await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));
    expect(result.spf).toBe(false);
    expect(result.spfReason).toContain("placeholder");
  });

  test("more than 10 DNS lookups is a permerror", async () => {
    const includes = Array.from({ length: 11 }, (_, i) => `include:i${i}.example`).join(
      " ",
    );
    txtRecords["example.com"] = [[`v=spf1 ${includes} ip4:203.0.113.10 -all`]];
    for (let i = 0; i < 11; i++) txtRecords[`i${i}.example`] = [["v=spf1 -all"]];
    const result = await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));
    expect(result.spf).toBe(false);
    expect(result.spfReason).toContain("permerror");
  });

  test("no SPF record", async () => {
    txtRecords["example.com"] = [["google-site-verification=abc"]];
    const result = await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));
    expect(result.spf).toBe(false);
    expect(result.spfReason).toBe("No SPF record");
  });

  test("a failed DNS lookup is reported as temporary, not as a missing record", async () => {
    const deps = spfDeps(["203.0.113.10"]);
    deps.resolveTxt = async () => {
      throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
    };
    const result = await verifyDomain(baseDomain, deps);
    expect(result.spf).toBe(false);
    expect(result.spfReason).toContain("temporary");
  });

  test("unknown sending IPs fail with a hint", async () => {
    txtRecords["example.com"] = [["v=spf1 ip4:203.0.113.10 -all"]];
    const result = await verifyDomain(baseDomain, spfDeps([]));
    expect(result.spf).toBe(false);
    expect(result.spfReason).toContain("MAIL_PUBLIC_IP");
  });
});

describe("verifyDomain: DKIM", () => {
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

describe("verifyDomain: DMARC", () => {
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
    expect(result.dmarcReason).toBe("No DMARC record at _dmarc.example.com");
  });

  test("two DMARC records fail (#250)", async () => {
    txtRecords["_dmarc.example.com"] = [["v=DMARC1; p=reject"], ["v=DMARC1; p=none"]];
    const result = await verifyDomain(baseDomain);
    expect(result.dmarc).toBe(false);
    expect(result.dmarcReason).toContain("2 DMARC records");
  });

  test("a record without a valid p fails (#250)", async () => {
    txtRecords["_dmarc.example.com"] = [["v=DMARC1; rua=mailto:x@example.com"]];
    expect((await verifyDomain(baseDomain)).dmarc).toBe(false);
  });

  test("a subdomain inherits the organizational domain's record (#250)", async () => {
    txtRecords["_dmarc.example.com"] = [["v=DMARC1; p=reject"]];
    const result = await verifyDomain({ ...baseDomain, name: "mail.example.com" });
    expect(result.dmarc).toBe(true);
    expect(result.dmarcReason).toContain("organizational domain");
  });
});

describe("verifyDomain: persistence (#250)", () => {
  /** SPF, DKIM and DMARC all published and correct. */
  function publishAll(): void {
    txtRecords["example.com"] = [["v=spf1 ip4:203.0.113.10 -all"]];
    txtRecords["bunmail._domainkey.example.com"] = [
      [`v=DKIM1; k=rsa; p=${expectedPubKey}`],
    ];
    txtRecords["_dmarc.example.com"] = [["v=DMARC1; p=none"]];
  }

  test("sets verifiedAt only when every check passes", async () => {
    publishAll();
    await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));

    expect(dbUpdates).toHaveLength(1);
    const update = dbUpdates[0]!;
    expect(update.spfVerified).toBe(true);
    expect(update.dkimVerified).toBe(true);
    expect(update.dmarcVerified).toBe(true);
    expect(update.verifiedAt).toBeInstanceOf(Date);
    expect(update.consecutiveFailures).toBe(0);
    expect(update.lastCheckedAt).toBeInstanceOf(Date);
    /** The domain became verified: `domain.verified` is enqueued in the transaction. */
    expect(executed).toBe(1);
  });

  test("a partial result no longer sets verifiedAt", async () => {
    txtRecords["example.com"] = [["v=spf1 ip4:203.0.113.10 -all"]];
    txtRecords["_dmarc.example.com"] = [["v=DMARC1; p=none"]];

    const result = await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));

    expect(result.checks?.dkim.status).toBe("fail");
    const update = dbUpdates[0]!;
    expect(update.spfVerified).toBe(true);
    expect(update.dkimVerified).toBe(false);
    expect(update.dmarcVerified).toBe(true);
    expect(update.verifiedAt).toBeNull();
    expect(update.consecutiveFailures).toBe(1);
    expect(update.lastCheckedAt).toBeInstanceOf(Date);
    expect(executed).toBe(0);
  });

  test("stores the per-check result with reasons", async () => {
    publishAll();
    await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));
    const stored = dbUpdates[0]!.lastCheckResult;
    expect(stored).toMatchObject({
      spf: { status: "pass" },
      dkim: {
        status: "pass",
        reason: "The DKIM key is published at bunmail._domainkey.example.com",
      },
      dmarc: { status: "pass" },
    });
  });
});

describe("verifyDomain: a failed lookup is unknown, not a failure (#250)", () => {
  const servfail = (): Promise<never> =>
    Promise.reject(Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" }));

  test("SERVFAIL on every lookup gives unknown for all three checks", async () => {
    const deps = spfDeps(["203.0.113.10"]);
    deps.resolveTxt = servfail;
    const result = await verifyDomain(baseDomain, deps);
    expect(result.checks?.spf.status).toBe("unknown");
    expect(result.checks?.dkim.status).toBe("unknown");
    expect(result.checks?.dmarc.status).toBe("unknown");
    /** Nothing counted. */
    expect(dbUpdates[0]!.consecutiveFailures).toBe(0);
  });

  test("an SPF temperror is unknown", async () => {
    txtRecords["example.com"] = [["v=spf1 ip4:203.0.113.10 -all"]];
    const deps = spfDeps(["203.0.113.10"]);
    deps.evaluateSpf = () => Promise.resolve("temperror");
    expect((await verifyDomain(baseDomain, deps)).checks?.spf.status).toBe("unknown");
  });

  test("unknown sending IPs are unknown: this server's DNS, not the domain's record", async () => {
    txtRecords["example.com"] = [["v=spf1 ip4:203.0.113.10 -all"]];
    expect((await verifyDomain(baseDomain, spfDeps([]))).checks?.spf.status).toBe(
      "unknown",
    );
  });

  test("NXDOMAIN is a definitive failure", async () => {
    const result = await verifyDomain(baseDomain, spfDeps(["203.0.113.10"]));
    expect(result.checks?.spf.status).toBe("fail");
    expect(result.checks?.dkim.status).toBe("fail");
    expect(result.checks?.dmarc.status).toBe("fail");
  });
});
