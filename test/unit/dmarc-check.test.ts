import { describe, test, expect } from "bun:test";
import {
  checkDmarc,
  organizationalDomain,
  parseDmarcRecord,
} from "../../src/modules/domains/services/dmarc-check.service.ts";

/**
 * DMARC checks done properly (#250): exactly one `v=DMARC1` record, the
 * organizational-domain fallback, and strict tag parsing. DNS is a stub.
 */

/** TXT answers by name; a name not listed is NXDOMAIN. */
function dns(
  answers: Record<string, string[][] | { code: string } | "hang">,
): Parameters<typeof checkDmarc>[1] & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    timeoutMs: 50,
    resolveTxt: (hostname) => {
      queries.push(hostname);
      const answer = answers[hostname];
      if (answer === "hang") return new Promise(() => {});
      if (answer === undefined || !Array.isArray(answer)) {
        const code = answer === undefined ? "ENOTFOUND" : answer.code;
        return Promise.reject(Object.assign(new Error(code), { code }));
      }
      return Promise.resolve(answer);
    },
  };
}

describe("organizationalDomain: the registrable-domain heuristic", () => {
  test("keeps the last two labels", () => {
    expect(organizationalDomain("example.com")).toBe("example.com");
    expect(organizationalDomain("mail.example.com")).toBe("example.com");
    expect(organizationalDomain("a.b.example.org")).toBe("example.org");
  });

  test("keeps three under a common second-level label of a two-letter TLD", () => {
    expect(organizationalDomain("mail.example.co.uk")).toBe("example.co.uk");
    expect(organizationalDomain("example.co.uk")).toBe("example.co.uk");
    expect(organizationalDomain("x.shop.com.au")).toBe("shop.com.au");
    expect(organizationalDomain("news.example.ac.jp")).toBe("example.ac.jp");
  });

  test("only under a two-letter TLD, and case and trailing dot are ignored", () => {
    /** `.co` under a three-letter TLD is an ordinary label. */
    expect(organizationalDomain("mail.co.com")).toBe("co.com");
    expect(organizationalDomain("Mail.Example.COM.")).toBe("example.com");
  });
});

describe("parseDmarcRecord: strict tags", () => {
  test("parses every tag, case and whitespace insensitive", () => {
    const parsed = parseDmarcRecord(
      "V = dmarc1 ; P = Reject ; SP=quarantine;pct = 50; ADKIM=s; aspf = S ; rua = mailto:a@example.com , mailto:b@example.net!10m",
    );
    expect(parsed).toEqual({
      policy: "reject",
      subdomainPolicy: "quarantine",
      pct: 50,
      adkim: "s",
      aspf: "s",
      rua: ["mailto:a@example.com", "mailto:b@example.net!10m"],
      problems: [],
    });
  });

  test("defaults: pct 100, relaxed alignment, no sp, no rua", () => {
    expect(parseDmarcRecord("v=DMARC1; p=none")).toEqual({
      policy: "none",
      subdomainPolicy: null,
      pct: 100,
      adkim: "r",
      aspf: "r",
      rua: [],
      problems: [],
    });
  });

  test("an invalid p leaves the policy null and is reported", () => {
    const parsed = parseDmarcRecord("v=DMARC1; p=block");
    expect(parsed.policy).toBeNull();
    expect(parsed.problems).toEqual(["p=block is not none, quarantine or reject"]);
    expect(parseDmarcRecord("v=DMARC1; rua=mailto:a@example.com").policy).toBeNull();
  });

  test("pct must be an integer from 0 to 100", () => {
    expect(parseDmarcRecord("v=DMARC1; p=reject; pct=0").pct).toBe(0);
    expect(parseDmarcRecord("v=DMARC1; p=reject; pct=100").pct).toBe(100);
    for (const bad of ["101", "-1", "50.5", "abc", "", "1000"]) {
      const parsed = parseDmarcRecord(`v=DMARC1; p=reject; pct=${bad}`);
      expect(parsed.pct).toBe(100);
      expect(parsed.problems[0]).toContain("is not an integer from 0 to 100");
    }
  });

  test("invalid sp, adkim, aspf and rua values are reported and ignored", () => {
    const parsed = parseDmarcRecord(
      "v=DMARC1; p=quarantine; sp=maybe; adkim=x; aspf=relaxed; rua=https://example.com/r, mailto:ok@example.com, mailto:nope",
    );
    expect(parsed.subdomainPolicy).toBeNull();
    expect(parsed.adkim).toBe("r");
    expect(parsed.aspf).toBe("r");
    expect(parsed.rua).toEqual(["mailto:ok@example.com"]);
    expect(parsed.problems).toHaveLength(5);
  });

  test("unknown tags are ignored silently; junk segments and duplicates are reported", () => {
    const parsed = parseDmarcRecord(
      "v=DMARC1; p=reject; ruf=mailto:f@example.com; fo=1; x-custom=1; garbage; p=none;;",
    );
    expect(parsed.policy).toBe("reject");
    expect(parsed.problems).toEqual([
      '"garbage" is not a tag=value pair: ignored',
      "p= appears more than once: the first is used",
    ]);
  });

  test("a long hostile value is shortened in the problem text", () => {
    const parsed = parseDmarcRecord(`v=DMARC1; p=${"<script>".repeat(40)}`);
    expect(parsed.problems[0]!.length).toBeLessThan(120);
  });
});

describe("checkDmarc: discovery", () => {
  test("one valid record passes", async () => {
    const check = await checkDmarc(
      "example.com",
      dns({ "_dmarc.example.com": [["v=DMARC1; p=reject; rua=mailto:d@example.com"]] }),
    );
    expect(check).toMatchObject({
      status: "pass",
      ok: true,
      recordDomain: "example.com",
      inherited: false,
      policy: "reject",
      effectivePolicy: "reject",
      warnings: [],
    });
  });

  test("chunks of one TXT record are joined before matching", async () => {
    const check = await checkDmarc(
      "example.com",
      dns({ "_dmarc.example.com": [["v=DMAR", "C1; p=quar", "antine"]] }),
    );
    expect(check.status).toBe("pass");
    expect(check.policy).toBe("quarantine");
  });

  test("two DMARC records fail with their own reason", async () => {
    const check = await checkDmarc(
      "example.com",
      dns({
        "_dmarc.example.com": [["v=DMARC1; p=reject"], ["v=DMARC1; p=none"]],
      }),
    );
    expect(check.status).toBe("multiple");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("2 DMARC records");
  });

  test("non-DMARC TXT records next to one DMARC record do not count", async () => {
    const check = await checkDmarc(
      "example.com",
      dns({
        "_dmarc.example.com": [["v=DMARC1; p=reject"], ["google-site-verification=x"]],
      }),
    );
    expect(check.status).toBe("pass");
  });

  test("the version tag must start the record", async () => {
    for (const record of [
      "xv=DMARC1; p=reject",
      " p=reject; v=DMARC1",
      "v=DMARC10; p=reject",
      "v=DMARC2; p=reject",
    ]) {
      const check = await checkDmarc(
        "example.com",
        dns({ "_dmarc.example.com": [[record]] }),
      );
      expect(check.status).toBe("missing");
    }
  });

  test("case and whitespace variants of the version tag match", async () => {
    for (const record of [
      "v=dmarc1; p=reject",
      "V = DMARC1 ;p=reject",
      "v=DMARC1;p=reject",
    ]) {
      const check = await checkDmarc(
        "example.com",
        dns({ "_dmarc.example.com": [[record]] }),
      );
      expect(check.status).toBe("pass");
    }
  });

  test("no record anywhere is missing", async () => {
    const stub = dns({});
    const check = await checkDmarc("mail.example.com", stub);
    expect(check.status).toBe("missing");
    expect(check.reason).toBe(
      "No DMARC record at _dmarc.mail.example.com or _dmarc.example.com",
    );
    expect(stub.queries).toEqual(["_dmarc.mail.example.com", "_dmarc.example.com"]);
  });

  test("an organizational domain is not looked up twice", async () => {
    const stub = dns({});
    expect((await checkDmarc("example.com", stub)).reason).toBe(
      "No DMARC record at _dmarc.example.com",
    );
    expect(stub.queries).toEqual(["_dmarc.example.com"]);
  });

  test("a subdomain without a record inherits the organizational domain's sp", async () => {
    const check = await checkDmarc(
      "mail.example.com",
      dns({
        "_dmarc.example.com": [
          ["v=DMARC1; p=reject; sp=quarantine; rua=mailto:d@example.com"],
        ],
      }),
    );
    expect(check).toMatchObject({
      status: "pass",
      inherited: true,
      recordDomain: "example.com",
      policy: "reject",
      subdomainPolicy: "quarantine",
      effectivePolicy: "quarantine",
    });
  });

  test("without sp, the inherited policy is p", async () => {
    const check = await checkDmarc(
      "mail.example.com",
      dns({ "_dmarc.example.com": [["v=DMARC1; p=reject; rua=mailto:d@example.com"]] }),
    );
    expect(check.effectivePolicy).toBe("reject");
  });

  test("the domain's own record wins, and its sp does not apply to itself", async () => {
    const check = await checkDmarc(
      "mail.example.com",
      dns({
        "_dmarc.mail.example.com": [["v=DMARC1; p=reject; sp=none"]],
        "_dmarc.example.com": [["v=DMARC1; p=none"]],
      }),
    );
    expect(check.inherited).toBe(false);
    expect(check.effectivePolicy).toBe("reject");
  });

  test("a .co.uk-style domain falls back to the right organizational domain", async () => {
    const stub = dns({
      "_dmarc.shop.example.co.uk": [["v=DMARC1; p=quarantine"]],
      "_dmarc.co.uk": [["v=DMARC1; p=reject"]],
    });
    const check = await checkDmarc("news.shop.example.co.uk", stub);
    expect(check.status).toBe("missing");
    expect(stub.queries).toEqual([
      "_dmarc.news.shop.example.co.uk",
      "_dmarc.example.co.uk",
    ]);

    const inherited = await checkDmarc(
      "mail.example.co.uk",
      dns({ "_dmarc.example.co.uk": [["v=DMARC1; p=quarantine"]] }),
    );
    expect(inherited).toMatchObject({ status: "pass", recordDomain: "example.co.uk" });
  });

  test("two records at the organizational domain fail too", async () => {
    const check = await checkDmarc(
      "mail.example.com",
      dns({ "_dmarc.example.com": [["v=DMARC1; p=reject"], ["v=DMARC1; p=reject"]] }),
    );
    expect(check).toMatchObject({ status: "multiple", inherited: true });
  });

  test("an invalid p fails, keeping the parsed tags", async () => {
    const check = await checkDmarc(
      "example.com",
      dns({ "_dmarc.example.com": [["v=DMARC1; p=bogus; rua=mailto:d@example.com"]] }),
    );
    expect(check.status).toBe("invalid");
    expect(check.ok).toBe(false);
    expect(check.rua).toEqual(["mailto:d@example.com"]);
    expect(check.problems).toHaveLength(1);
  });

  test("p=none passes with a warning that it does not protect", async () => {
    const check = await checkDmarc(
      "example.com",
      dns({ "_dmarc.example.com": [["v=DMARC1; p=none; rua=mailto:d@example.com"]] }),
    );
    expect(check.ok).toBe(true);
    expect(check.warnings).toHaveLength(1);
    expect(check.warnings[0]).toContain("p=none only monitors");
  });

  test("an inherited sp=none warns about sp", async () => {
    const check = await checkDmarc(
      "mail.example.com",
      dns({
        "_dmarc.example.com": [["v=DMARC1; p=reject; sp=none; rua=mailto:d@example.com"]],
      }),
    );
    expect(check.warnings[0]).toContain("sp=none only monitors");
  });

  test("pct below 100 and a missing rua warn", async () => {
    const check = await checkDmarc(
      "example.com",
      dns({ "_dmarc.example.com": [["v=DMARC1; p=reject; pct=25"]] }),
    );
    expect(check.ok).toBe(true);
    expect(check.pct).toBe(25);
    expect(check.warnings).toEqual([
      "pct=25: the reject policy applies to 25% of failing mail only",
      "No rua= address: receivers send no aggregate reports",
    ]);
  });

  test("multiple rua addresses are kept", async () => {
    const check = await checkDmarc(
      "example.com",
      dns({
        "_dmarc.example.com": [
          ["v=DMARC1; p=reject; rua=mailto:a@example.com,mailto:b@reports.example.net"],
        ],
      }),
    );
    expect(check.rua).toEqual(["mailto:a@example.com", "mailto:b@reports.example.net"]);
  });

  test("a DNS error or timeout is an error, without a fallback lookup", async () => {
    const failing = dns({ "_dmarc.mail.example.com": { code: "ESERVFAIL" } });
    const check = await checkDmarc("mail.example.com", failing);
    expect(check.status).toBe("error");
    expect(check.reason).toContain("ESERVFAIL");
    expect(failing.queries).toHaveLength(1);

    const hung = await checkDmarc("example.com", dns({ "_dmarc.example.com": "hang" }));
    expect(hung.status).toBe("error");
    expect(hung.reason).toContain("ETIMEOUT");
  });

  test("NODATA counts as no record", async () => {
    const check = await checkDmarc(
      "mail.example.com",
      dns({
        "_dmarc.mail.example.com": { code: "ENODATA" },
        "_dmarc.example.com": [["v=DMARC1; p=reject"]],
      }),
    );
    expect(check).toMatchObject({ status: "pass", inherited: true });
  });
});
