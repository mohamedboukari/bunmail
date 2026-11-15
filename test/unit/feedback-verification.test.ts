import { describe, test, expect } from "bun:test";
import type { DkimCheck } from "../../src/modules/inbound/services/feedback-handler.service.ts";
import {
  isAligned,
  senderListed,
  verifyFeedbackReport,
  type FeedbackLoopPolicy,
  type FeedbackVerificationInput,
} from "../../src/modules/inbound/services/feedback-verification.service.ts";

/**
 * The verified-complaint rule (`verifyFeedbackReport`): a complaint may be
 * shared across API keys only when a DKIM signature passed for one of
 * `FEEDBACK_LOOP_DOMAINS` (exactly), the report comes from one of
 * `FEEDBACK_LOOP_SENDERS`, that signature belongs to the sender's domain,
 * and a non-empty envelope sender is listed too.
 */

/** A DKIM verdict whose passing signatures are `passingDomains`. */
function dkimOf(passingDomains: string[], result = "pass"): DkimCheck {
  return { result, signingDomain: passingDomains[0] ?? null, passingDomains };
}

const LISTED = ["fbl.isp.example.net", "complaints.example.org"];
const SENDER = "feedback@fbl.isp.example.net";
const POLICY: FeedbackLoopPolicy = { domains: LISTED, senders: [SENDER] };

/** The signed header fields of a well-formed report from {@link SENDER}. */
const HEADERS = { from: SENDER, contentTypeSingle: true };

/** What a test may change: the signed `From`, the `Content-Type` count, the envelope. */
interface Overrides {
  reporterAddress?: string | null;
  contentTypeSingle?: boolean;
  envelopeFrom?: FeedbackVerificationInput["envelopeFrom"];
}

/** The rule's verdict for a report from `reporterAddress`, signed by `passing`. */
function verdict(
  passing: string[],
  overrides: Overrides = {},
  policy: FeedbackLoopPolicy = POLICY,
): ReturnType<typeof verifyFeedbackReport> {
  return verifyFeedbackReport(
    {
      dkim: dkimOf(passing),
      headers: {
        from:
          overrides.reporterAddress === undefined ? SENDER : overrides.reporterAddress,
        contentTypeSingle: overrides.contentTypeSingle ?? true,
      },
      envelopeFrom: overrides.envelopeFrom ?? null,
    },
    policy,
  );
}

/** Just whether the report is verified. */
function verified(
  passing: string[],
  overrides: Overrides = {},
  policy: FeedbackLoopPolicy = POLICY,
): boolean {
  return verdict(passing, overrides, policy).verified;
}

describe("verifyFeedbackReport: the signing domain", () => {
  test("no signature, or none that passed: not verified", () => {
    for (const result of ["none", "fail", "temperror"]) {
      expect(
        verifyFeedbackReport(
          { dkim: dkimOf([], result), headers: HEADERS, envelopeFrom: null },
          POLICY,
        ),
      ).toEqual({ verified: false, reason: "domain_not_listed" });
    }
    /** A failing signature of a listed domain is not in `passingDomains`. */
    expect(
      verifyFeedbackReport(
        {
          dkim: {
            result: "fail",
            signingDomain: "fbl.isp.example.net",
            passingDomains: [],
          },
          headers: HEADERS,
          envelopeFrom: null,
        },
        POLICY,
      ).verified,
    ).toBe(false);
  });

  test("a passing signature of a domain not listed: not verified", () => {
    expect(verdict(["attacker.example"])).toEqual({
      verified: false,
      reason: "domain_not_listed",
    });
  });

  test("a passing signature of a listed domain, from the listed sender: verified, ASCII case and a final dot ignored", () => {
    expect(verdict(["fbl.isp.example.net"])).toEqual({
      verified: true,
      signingDomain: "fbl.isp.example.net",
    });
    expect(verified(["FBL.ISP.Example.NET"])).toBe(true);
    expect(verified(["fbl.isp.example.net."])).toBe(true);
    expect(
      verified(
        ["fbl.isp.example.net"],
        {},
        { domains: ["FBL.isp.example.net"], senders: [SENDER] },
      ),
    ).toBe(true);
  });

  test("exact match only: no subdomain, no parent, no look-alike suffix", () => {
    const fromSub = { reporterAddress: "feedback@x.fbl.isp.example.net" };
    const subPolicy = { domains: LISTED, senders: ["@x.fbl.isp.example.net"] };
    /** A subdomain of a listed domain does not count. */
    expect(verdict(["x.fbl.isp.example.net"], fromSub, subPolicy)).toEqual({
      verified: false,
      reason: "domain_not_listed",
    });
    /** Nor does its parent. */
    expect(verified(["isp.example.net"])).toBe(false);
    /** Nor a name that merely ends with the same characters. */
    expect(verified(["evilfbl.isp.example.net"])).toBe(false);
  });

  test("several signatures: a passing one of a listed domain aligned with the sender is enough", () => {
    expect(verified(["forwarder.example", "fbl.isp.example.net"])).toBe(true);
    expect(verified(["forwarder.example", "attacker.example"])).toBe(false);
    /** Listed but belonging to another domain than the sender's: not enough. */
    expect(verdict(["forwarder.example", "complaints.example.org"])).toEqual({
      verified: false,
      reason: "not_aligned",
    });
  });
});

describe("verifyFeedbackReport: the configured lists", () => {
  test("an empty FEEDBACK_LOOP_DOMAINS verifies nothing", () => {
    expect(
      verdict(["fbl.isp.example.net"], {}, { domains: [], senders: [SENDER] }),
    ).toEqual({
      verified: false,
      reason: "no_feedback_loop_domains",
    });
  });

  test("an empty FEEDBACK_LOOP_SENDERS verifies nothing (fails closed)", () => {
    expect(
      verdict(["fbl.isp.example.net"], {}, { domains: LISTED, senders: [] }),
    ).toEqual({
      verified: false,
      reason: "no_feedback_loop_senders",
    });
  });
});

describe("verifyFeedbackReport: the sender", () => {
  test("signed by a listed domain but sent by an unlisted address: sender_not_listed", () => {
    expect(
      verdict(["fbl.isp.example.net"], {
        reporterAddress: "someone@fbl.isp.example.net",
      }),
    ).toEqual({ verified: false, reason: "sender_not_listed" });
  });

  test("no single From address: sender_missing", () => {
    expect(verdict(["fbl.isp.example.net"], { reporterAddress: null })).toEqual({
      verified: false,
      reason: "sender_missing",
    });
  });

  test("an @domain entry accepts any address at exactly that domain", () => {
    const policy = { domains: LISTED, senders: ["@fbl.isp.example.net"] };
    expect(
      verified(
        ["fbl.isp.example.net"],
        { reporterAddress: "anyone@fbl.isp.example.net" },
        policy,
      ),
    ).toBe(true);
  });

  test("a listed sender the signature does not belong to: not_aligned", () => {
    const policy = { domains: LISTED, senders: [SENDER, "feedback@other.example"] };
    expect(
      verdict(
        ["fbl.isp.example.net"],
        { reporterAddress: "feedback@other.example" },
        policy,
      ),
    ).toEqual({ verified: false, reason: "not_aligned" });
  });

  test("a sender on a subdomain of the signing domain is aligned, a parent is not", () => {
    const policy = {
      domains: ["isp.example.net"],
      senders: ["feedback@arf.isp.example.net"],
    };
    expect(
      verified(
        ["isp.example.net"],
        { reporterAddress: "feedback@arf.isp.example.net" },
        policy,
      ),
    ).toBe(true);
    const parent = { domains: LISTED, senders: ["feedback@isp.example.net"] };
    expect(
      verdict(
        ["fbl.isp.example.net"],
        { reporterAddress: "feedback@isp.example.net" },
        parent,
      ),
    ).toEqual({ verified: false, reason: "not_aligned" });
  });
});

describe("verifyFeedbackReport: the envelope sender", () => {
  test("empty (`<>`): accepted", () => {
    expect(verified(["fbl.isp.example.net"], { envelopeFrom: null })).toBe(true);
  });

  test("listed: accepted, case ignored", () => {
    expect(
      verified(["fbl.isp.example.net"], { envelopeFrom: "Feedback@FBL.isp.example.net" }),
    ).toBe(true);
  });

  test("not listed: envelope_not_listed", () => {
    expect(
      verdict(["fbl.isp.example.net"], { envelopeFrom: "bounce@elsewhere.example" }),
    ).toEqual({ verified: false, reason: "envelope_not_listed" });
  });
});

describe("verifyFeedbackReport: the signed header fields", () => {
  test("no single top-level Content-Type: content_type_ambiguous, before the sender is looked at", () => {
    expect(verdict(["fbl.isp.example.net"], { contentTypeSingle: false })).toEqual({
      verified: false,
      reason: "content_type_ambiguous",
    });
  });

  test("the address is compared in ASCII case only: a non-ASCII letter that folds to a listed one does not match", () => {
    /** U+212A KELVIN SIGN lowercases to "k" with `toLowerCase`. */
    const policy = { domains: LISTED, senders: ["feedback@fbl.isp.example.net"] };
    expect(
      verdict(
        ["fbl.isp.example.net"],
        { reporterAddress: "feedbac\u212a@fbl.isp.example.net" },
        policy,
      ),
    ).toEqual({ verified: false, reason: "sender_missing" });
    expect(
      senderListed("feedbac\u212a@fbl.isp.example.net", ["feedback@fbl.isp.example.net"]),
    ).toBe(false);
    expect(
      senderListed("FEEDBACK@fbl.isp.example.net", ["feedback@fbl.isp.example.net"]),
    ).toBe(true);
  });
});

describe("senderListed", () => {
  const SENDERS = ["feedback@fbl.isp.example.net", "@arf.example.org"];

  test.each([
    ["feedback@fbl.isp.example.net", true],
    ["FEEDBACK@Fbl.Isp.Example.Net", true],
    ["feedback@fbl.isp.example.net.", true],
    ["other@fbl.isp.example.net", false],
    ["feedback@isp.example.net", false],
    ["anyone@arf.example.org", true],
    ["anyone@sub.arf.example.org", false],
    ["anyone@example.org", false],
    ["not-an-address", false],
    ["@arf.example.org", false],
  ] as const)("%p: %p", (address, expected) => {
    expect(senderListed(address, SENDERS)).toBe(expected);
  });
});

describe("isAligned", () => {
  test.each([
    ["fbl.example.net", "fbl.example.net", true],
    ["arf.fbl.example.net", "fbl.example.net", true],
    ["FBL.Example.NET", "fbl.example.net.", true],
    ["example.net", "fbl.example.net", false],
    ["evilfbl.example.net", "fbl.example.net", false],
    ["fbl.example.org", "fbl.example.net", false],
  ] as const)("From %p, d=%p: %p", (from, signer, expected) => {
    expect(isAligned(from, signer)).toBe(expected);
  });
});
