import { describe, test, expect } from "bun:test";
import {
  isVerifiedReport,
  signatureCanVouch,
  verifyReportDkim,
} from "../../src/modules/inbound/services/feedback-handler.service.ts";
import { signingDomainOf } from "../../src/modules/inbound/services/dkim-verifier-parse.service.ts";
import { arfReport, arfResolveTxt, signArf, signArfWith } from "../signed-arf.ts";

/**
 * The DKIM check of a feedback-loop report, on real signatures (BunMail's
 * own signer, a test key) and a TXT lookup that knows only that key:
 * `passingDomains` must list the `d=` of every signature that passed, and
 * nothing else, since it decides whether a complaint is verified.
 */

const REPORT = arfReport({
  originalMessageId: "abc@mail.example.com",
  rcptTo: "reader@example.org",
});

/** Runs the check on `message` with keys published for `domains`. */
function check(
  message: string | Buffer,
  domains: readonly string[],
  testing: readonly string[] = [],
): ReturnType<typeof verifyReportDkim> {
  const bytes = typeof message === "string" ? Buffer.from(message, "latin1") : message;
  return verifyReportDkim(bytes.toString("latin1"), bytes, {
    resolveTxt: arfResolveTxt(domains, testing),
  });
}

describe("verifyReportDkim", () => {
  test("an unsigned report: none, no passing domain, no lookup", async () => {
    let lookups = 0;
    const bytes = Buffer.from(REPORT, "latin1");
    const result = await verifyReportDkim(REPORT, bytes, {
      resolveTxt: async () => {
        lookups += 1;
        return [];
      },
    });
    expect(result).toEqual({ result: "none", signingDomain: null, passingDomains: [] });
    expect(lookups).toBe(0);
  });

  test("a passing signature lists its signing domain", async () => {
    const result = await check(signArf(REPORT, "fbl.isp.example.net"), [
      "fbl.isp.example.net",
    ]);
    expect(result).toEqual({
      result: "pass",
      signingDomain: "fbl.isp.example.net",
      passingDomains: ["fbl.isp.example.net"],
    });
  });

  test("a signature without a published key, or over altered content, does not pass", async () => {
    const unknown = await check(signArf(REPORT, "attacker.example"), []);
    expect(unknown.result).toBe("permerror");
    expect(unknown.passingDomains).toEqual([]);

    const altered = signArf(REPORT, "fbl.isp.example.net")
      .toString("latin1")
      .replace("reader@example.org", "target@example.org");
    const tampered = await check(altered, ["fbl.isp.example.net"]);
    expect(tampered.result).toBe("fail");
    expect(tampered.passingDomains).toEqual([]);
  });

  test("a key in testing mode (t=y) passes but does not count", async () => {
    const result = await check(
      signArf(REPORT, "fbl.isp.example.net"),
      ["fbl.isp.example.net"],
      ["fbl.isp.example.net"],
    );
    expect(result.result).toBe("pass");
    expect(result.passingDomains).toEqual([]);
  });

  test("several signatures: every passing one is listed, the failing ones are not", async () => {
    /** The provider signs, then a forwarder without a published key, then another passing domain. */
    const signed = signArf(
      signArf(signArf(REPORT, "fbl.isp.example.net"), "forwarder.example"),
      "relay.example.org",
    );
    const result = await check(signed, ["fbl.isp.example.net", "relay.example.org"]);
    expect(result.passingDomains.toSorted()).toEqual([
      "fbl.isp.example.net",
      "relay.example.org",
    ]);
  });

  test("a domain given in mixed case is listed in lowercase", async () => {
    const result = await check(signArf(REPORT, "FBL.ISP.Example.NET"), [
      "fbl.isp.example.net",
    ]);
    expect(result.passingDomains).toEqual(["fbl.isp.example.net"]);
  });
});

/**
 * A passing signature vouches for a report only when it covers everything
 * the handler reads: no `l=`, and `h=` with From and Content-Type.
 */
describe("verifyReportDkim: signatures that cover too little", () => {
  const LISTED = ["fbl.isp.example.net"];

  test("both conditions met (custom signer, no l=, h= with From and Content-Type): counted", async () => {
    const result = await check(
      signArfWith(REPORT, "fbl.isp.example.net", {
        headers: ["From", "To", "Subject", "Date", "Content-Type", "MIME-Version"],
      }),
      LISTED,
    );
    expect(result.result).toBe("pass");
    expect(result.passingDomains).toEqual(["fbl.isp.example.net"]);
    expect(isVerifiedReport(result, LISTED)).toBe(true);
  });

  test("an l= tag: passes, not counted, even when l= covers the whole body", async () => {
    for (const bodyLength of ["all", 40] as const) {
      const result = await check(
        signArfWith(REPORT, "fbl.isp.example.net", { bodyLength }),
        LISTED,
      );
      expect(result.result).toBe("pass");
      expect(result.passingDomains).toEqual([]);
      expect(isVerifiedReport(result, LISTED)).toBe(false);
    }
  });

  test("an h= without Content-Type: passes, not counted", async () => {
    const result = await check(
      signArfWith(REPORT, "fbl.isp.example.net", {
        headers: ["From", "To", "Subject", "Date", "MIME-Version"],
      }),
      LISTED,
    );
    expect(result.result).toBe("pass");
    expect(result.passingDomains).toEqual([]);
    expect(isVerifiedReport(result, LISTED)).toBe(false);
  });

  test("a report altered after the signed length still verifies with l=, so it cannot count", async () => {
    const signed = signArfWith(REPORT, "fbl.isp.example.net", { bodyLength: "all" });
    const appended = Buffer.concat([signed, Buffer.from("\r\nappended part\r\n")]);
    const result = await check(appended, LISTED);
    expect(result.result).toBe("pass");
    expect(result.passingDomains).toEqual([]);
  });

  test("a covering signature after a weak one still verifies the report", async () => {
    const signed = signArf(
      signArfWith(REPORT, "fbl.isp.example.net", { bodyLength: "all" }),
      "complaints.example.org",
    );
    const result = await check(signed, ["fbl.isp.example.net", "complaints.example.org"]);
    expect(result.passingDomains).toEqual(["complaints.example.org"]);
  });
});

describe("signatureCanVouch", () => {
  const COVERING = {
    testing: false,
    hasLengthLimit: false,
    signedHeaders: ["from", "content-type"],
  };

  test("a covering signature outside testing mode can vouch", () => {
    expect(signatureCanVouch(COVERING)).toBeNull();
    /** Case-insensitive, whatever the caller passes. */
    expect(
      signatureCanVouch({ ...COVERING, signedHeaders: ["From", "Content-Type", "To"] }),
    ).toBeNull();
  });

  test("testing mode, l=, or a missing From or Content-Type: cannot", () => {
    expect(signatureCanVouch({ ...COVERING, testing: true })).toMatch(/testing/);
    expect(signatureCanVouch({ ...COVERING, hasLengthLimit: true })).toMatch(/l=/);
    expect(signatureCanVouch({ ...COVERING, signedHeaders: ["from"] })).toMatch(
      /content-type/,
    );
    expect(signatureCanVouch({ ...COVERING, signedHeaders: ["content-type"] })).toMatch(
      /from/,
    );
    expect(signatureCanVouch({ ...COVERING, signedHeaders: [] })).toMatch(
      /from, content-type/,
    );
  });
});

/** The `d=` normalisation behind `passingDomains`: the name the key was looked up under. */
describe("signingDomainOf", () => {
  test("a lowercase A-label, or null for anything that is not a domain name", () => {
    expect(signingDomainOf("FBL.Example.NET")).toBe("fbl.example.net");
    /** A UTF-8 U-label, read as latin1 bytes as the verifier reads the message. */
    expect(
      signingDomainOf(Buffer.from("bücher.example", "utf8").toString("latin1")),
    ).toBe("xn--bcher-kva.example");
    expect(signingDomainOf("localhost")).toBeNull();
    expect(signingDomainOf("")).toBeNull();
    expect(signingDomainOf("evil.example;")).toBeNull();
  });
});
