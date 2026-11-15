import { describe, expect, test } from "bun:test";
import {
  dmarcPrerequisite,
  lookupBimiRecord,
  parseBimiRecord,
} from "../../src/modules/domains/services/bimi-record.ts";
import { checkDmarc } from "../../src/modules/domains/services/dmarc-check.service.ts";

/**
 * The BIMI record and its DMARC prerequisite (#415). The record's text
 * comes from the domain's DNS, so a malformed one must be reported, never
 * thrown on.
 */

/** A TXT lookup answering from `answers`, NXDOMAIN otherwise. */
function txt(answers: Record<string, string[][]>) {
  return (name: string): Promise<string[][]> => {
    const answer = answers[name];
    if (answer) return Promise.resolve(answer);
    return Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
  };
}

describe("parseBimiRecord", () => {
  test("a valid record with l= and a=", () => {
    expect(
      parseBimiRecord("v=BIMI1; l=https://acme.io/logo.svg; a=https://acme.io/vmc.pem"),
    ).toEqual({
      logoUrl: "https://acme.io/logo.svg",
      authorityUrl: "https://acme.io/vmc.pem",
      problems: [],
    });
  });

  test("tag names are case-insensitive, whitespace is trimmed, unknown tags ignored", () => {
    expect(
      parseBimiRecord("v=BIMI1;  L = https://acme.io/logo.svg ; avp=brand; x=y;"),
    ).toEqual({ logoUrl: "https://acme.io/logo.svg", authorityUrl: null, problems: [] });
  });

  test("an empty l= declines: no problem, empty values", () => {
    expect(parseBimiRecord("v=BIMI1; l=; a=;")).toEqual({
      logoUrl: "",
      authorityUrl: "",
      problems: [],
    });
    expect(parseBimiRecord("v=BIMI1; l=").problems).toEqual([]);
  });

  test("an a= without l= is allowed (the logo is in the certificate)", () => {
    expect(parseBimiRecord("v=BIMI1; a=https://acme.io/vmc.pem").problems).toEqual([]);
  });

  test("missing tags: no l= and no a= is a problem", () => {
    expect(parseBimiRecord("v=BIMI1").problems).toEqual([
      "No l= tag: the record names no logo",
    ]);
    expect(parseBimiRecord("v=BIMI1; a=").problems).toEqual([
      "No l= tag: the record names no logo",
    ]);
  });

  test("an l= or a= that is not one https URL is a problem", () => {
    expect(parseBimiRecord("v=BIMI1; l=http://acme.io/logo.svg").problems).toEqual([
      "l=http://acme.io/logo.svg is not an https URL",
    ]);
    expect(parseBimiRecord("v=BIMI1; l=logo.svg").problems).toEqual([
      "l=logo.svg is not an absolute URL",
    ]);
    expect(
      parseBimiRecord("v=BIMI1; l=https://a.io/1.svg,https://a.io/2.svg").problems,
    ).toEqual(["l= must hold one URL, not a list"]);
    expect(parseBimiRecord("v=BIMI1; l=https://u:p@acme.io/logo.svg").problems).toEqual([
      "l= carries a user name or password",
    ]);
    expect(
      parseBimiRecord("v=BIMI1; l=https://acme.io/logo.svg; a=ftp://acme.io/vmc.pem")
        .problems,
    ).toEqual(["a=ftp://acme.io/vmc.pem is not an https URL"]);
  });

  test("garbage is reported, never thrown", () => {
    const parsed = parseBimiRecord(
      `v=BIMI1; garbage; l=https://acme.io/a.svg; l=https://acme.io/b.svg; ${"x".repeat(500)}`,
    );
    expect(parsed.problems).toContain("l= appears more than once");
    expect(parsed.problems.some((p) => p.startsWith('"garbage" is not'))).toBe(true);
    /** Long values are cut in findings. */
    expect(parsed.problems.every((p) => p.length < 200)).toBe(true);
  });
});

describe("lookupBimiRecord", () => {
  test("a valid record at default._bimi.<domain>", async () => {
    const result = await lookupBimiRecord("acme.io", {
      resolveTxt: txt({
        "default._bimi.acme.io": [["v=BIMI1; l=https://acme.io/", "logo.svg"]],
      }),
      timeoutMs: 1_000,
    });
    expect(result.record).toEqual({
      status: "valid",
      host: "default._bimi.acme.io",
      inherited: false,
      logoUrl: "https://acme.io/logo.svg",
      authorityUrl: null,
    });
    expect(result.findings.every((f) => f.severity !== "fail")).toBe(true);
  });

  test("no record: missing, after the organizational domain's fallback", async () => {
    const result = await lookupBimiRecord("mail.acme.io", {
      resolveTxt: txt({ "mail.acme.io": [["v=spf1 -all"]] }),
      timeoutMs: 1_000,
    });
    expect(result.record.status).toBe("missing");
    expect(result.findings[0]?.text).toBe(
      "No BIMI record at default._bimi.mail.acme.io or default._bimi.acme.io",
    );
  });

  test("the organizational domain's record applies to a subdomain", async () => {
    const result = await lookupBimiRecord("mail.acme.io", {
      resolveTxt: txt({
        "default._bimi.acme.io": [["v=BIMI1; l=https://acme.io/l.svg"]],
      }),
      timeoutMs: 1_000,
    });
    expect(result.record).toMatchObject({
      status: "valid",
      host: "default._bimi.acme.io",
      inherited: true,
    });
  });

  test("other TXT records at the name are ignored; two BIMI records are multiple", async () => {
    const only = await lookupBimiRecord("acme.io", {
      resolveTxt: txt({
        "default._bimi.acme.io": [["hello"], ["v=BIMI1; l=https://acme.io/l.svg"]],
      }),
      timeoutMs: 1_000,
    });
    expect(only.record.status).toBe("valid");
    const two = await lookupBimiRecord("acme.io", {
      resolveTxt: txt({
        "default._bimi.acme.io": [
          ["v=BIMI1; l=https://acme.io/a.svg"],
          ["v=BIMI1; l=https://acme.io/b.svg"],
        ],
      }),
      timeoutMs: 1_000,
    });
    expect(two.record.status).toBe("multiple");
  });

  test("declined and invalid records", async () => {
    const declined = await lookupBimiRecord("acme.io", {
      resolveTxt: txt({ "default._bimi.acme.io": [["v=BIMI1; l=; a=;"]] }),
      timeoutMs: 1_000,
    });
    expect(declined.record.status).toBe("declined");
    const invalid = await lookupBimiRecord("acme.io", {
      resolveTxt: txt({ "default._bimi.acme.io": [["v=BIMI1; l=http://acme.io/l.svg"]] }),
      timeoutMs: 1_000,
    });
    expect(invalid.record.status).toBe("invalid");
    expect(invalid.record.logoUrl).toBeNull();
    expect(invalid.findings.filter((f) => f.severity === "fail")).toHaveLength(2);
  });

  test("a failed or hanging lookup is error, within the budget", async () => {
    const failed = await lookupBimiRecord("acme.io", {
      resolveTxt: () =>
        Promise.reject(Object.assign(new Error("dns"), { code: "ESERVFAIL" })),
      timeoutMs: 1_000,
    });
    expect(failed.record.status).toBe("error");
    expect(failed.findings[0]?.text).toContain("ESERVFAIL");
    const started = performance.now();
    const hung = await lookupBimiRecord("acme.io", {
      resolveTxt: () => new Promise<never>(() => {}),
      timeoutMs: 50,
    });
    expect(hung.record.status).toBe("error");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("dmarcPrerequisite", () => {
  /** The DMARC check of one record at `_dmarc.acme.io` (or none). */
  async function prerequisite(record: string | null, domain = "acme.io") {
    const dmarc = await checkDmarc(domain, {
      resolveTxt: txt(record === null ? {} : { "_dmarc.acme.io": [[record]] }),
    });
    return dmarcPrerequisite(dmarc);
  }

  test("p=reject or p=quarantine with pct=100 passes", async () => {
    expect((await prerequisite("v=DMARC1; p=reject")).outcome).toBe("pass");
    expect((await prerequisite("v=DMARC1; p=quarantine; pct=100")).outcome).toBe("pass");
    expect((await prerequisite("v=DMARC1; p=reject; sp=quarantine")).outcome).toBe(
      "pass",
    );
  });

  test("p=none fails", async () => {
    const part = await prerequisite("v=DMARC1; p=none");
    expect(part.outcome).toBe("fail");
    expect(part.findings.some((f) => f.text.includes("BIMI needs p=quarantine"))).toBe(
      true,
    );
  });

  test("pct below 100 fails", async () => {
    const part = await prerequisite("v=DMARC1; p=reject; pct=50");
    expect(part.outcome).toBe("fail");
    expect(part.findings.some((f) => f.text.startsWith("pct=50"))).toBe(true);
  });

  test("sp=none fails, even with p=reject", async () => {
    const part = await prerequisite("v=DMARC1; p=reject; sp=none");
    expect(part.outcome).toBe("fail");
    expect(part.findings.some((f) => f.text.startsWith("sp=none"))).toBe(true);
  });

  test("an inherited record needs its p= to enforce as well", async () => {
    const part = await prerequisite("v=DMARC1; p=none; sp=reject", "mail.acme.io");
    expect(part.outcome).toBe("fail");
  });

  test("no DMARC record fails; a failed lookup is unknown", async () => {
    expect((await prerequisite(null)).outcome).toBe("fail");
    const dmarc = await checkDmarc("acme.io", {
      resolveTxt: () =>
        Promise.reject(Object.assign(new Error("dns"), { code: "ESERVFAIL" })),
    });
    expect(dmarcPrerequisite(dmarc).outcome).toBe("unknown");
  });
});
