import { describe, expect, test } from "bun:test";
import { enforcedTlsFailure } from "../../src/modules/emails/services/mx-transport.ts";
import {
  classifySession,
  classifyTlsError,
  noMatchingMxObservation,
  tlsRptPolicyOf,
} from "../../src/modules/tls-rpt/services/tls-rpt-classify.ts";
import type { TlsRptPolicy } from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";

/**
 * What a session is reported as (RFC 8460 section 4.3, #345): only the
 * result types BunMail can genuinely tell apart, from nodemailer's and
 * Bun's own error shapes, and never the peer's text.
 */

const NO_POLICY: TlsRptPolicy = tlsRptPolicyOf({ policy: null, failure: null });

const ENFORCE = tlsRptPolicyOf({
  policy: {
    id: "1",
    policy: { mode: "enforce", mx: ["*.mail.example.com"], maxAge: 86400 },
  },
  failure: null,
});

const TESTING = tlsRptPolicyOf({
  policy: {
    id: "1",
    policy: { mode: "testing", mx: ["mx.example.com"], maxAge: 604800 },
  },
  failure: null,
});

/** nodemailer's STARTTLS error for a failed TLS handshake (`Error initiating TLS - ...`). */
function initiatingTls(reason: string): Error {
  return Object.assign(new Error(`Error initiating TLS - ${reason}`), {
    code: "ETLS",
    command: "STARTTLS",
  });
}

describe("tlsRptPolicyOf", () => {
  test("no MTA-STS policy: no-policy-found", () => {
    expect(NO_POLICY).toEqual({
      type: "no-policy-found",
      policyString: [],
      mxHost: [],
      mode: null,
      policyFailure: null,
    });
  });

  test("an applied policy: sts, its lines and MX patterns (RFC 8460 section 4.4)", () => {
    expect(TESTING).toEqual({
      type: "sts",
      policyString: [
        "version: STSv1",
        "mode: testing",
        "mx: mx.example.com",
        "max_age: 604800",
      ],
      mxHost: ["mx.example.com"],
      mode: "testing",
      policyFailure: null,
    });
  });

  test.each([
    ["fetch-error", "sts-policy-fetch-error"],
    ["policy-invalid", "sts-policy-invalid"],
    ["webpki-invalid", "sts-webpki-invalid"],
  ] as const)("a %s with no policy kept: sts with %s", (failure, result) => {
    const policy = tlsRptPolicyOf({ policy: null, failure });
    expect(policy).toMatchObject({
      type: "sts",
      policyString: [],
      policyFailure: result,
    });
  });

  test("a fetch failure with a cached policy kept: the policy applied, no failure", () => {
    const policy = tlsRptPolicyOf({
      policy: {
        id: "1",
        policy: { mode: "enforce", mx: ["mx.example.com"], maxAge: 60 },
      },
      failure: "fetch-error",
    });
    expect(policy.policyFailure).toBeNull();
    expect(policy.mode).toBe("enforce");
  });
});

describe("classifyTlsError", () => {
  test.each([
    ["certificate has expired", "certificate-expired", ""],
    [
      "Hostname/IP does not match certificate's altnames: Host: a. is not in the cert's altnames",
      "certificate-host-mismatch",
      "",
    ],
    ["self signed certificate", "certificate-not-trusted", ""],
    ["self-signed certificate in certificate chain", "certificate-not-trusted", ""],
    ["unable to verify the first certificate", "certificate-not-trusted", ""],
    ["unable to get local issuer certificate", "certificate-not-trusted", ""],
    ["certificate is not yet valid", "validation-failure", "certificate-not-yet-valid"],
    ["wrong version number", "validation-failure", "tls-handshake-failed"],
  ] as const)("STARTTLS %p", (reason, result, code) => {
    expect(classifyTlsError(initiatingTls(reason))).toEqual({ result, reason: code });
    /** The same through the enforce-mode wrapper, which keeps the reason text. */
    expect(
      classifyTlsError(enforcedTlsFailure(initiatingTls(reason), "mx.example.com")),
    ).toEqual({ result, reason: code });
  });

  test("Bun's certificate error codes", () => {
    const coded = (code: string): Error => Object.assign(new Error("x"), { code });
    expect(classifyTlsError(coded("CERT_HAS_EXPIRED"))?.result).toBe(
      "certificate-expired",
    );
    expect(classifyTlsError(coded("ERR_TLS_CERT_ALTNAME_INVALID"))?.result).toBe(
      "certificate-host-mismatch",
    );
    expect(classifyTlsError(coded("DEPTH_ZERO_SELF_SIGNED_CERT"))?.result).toBe(
      "certificate-not-trusted",
    );
  });

  test("an MX that refuses STARTTLS: starttls-not-supported", () => {
    const refused = Object.assign(new Error("Error upgrading connection with STARTTLS"), {
      code: "ETLS",
      command: "STARTTLS",
      responseCode: 502,
    });
    expect(classifyTlsError(refused)).toEqual({
      result: "starttls-not-supported",
      reason: "starttls-refused",
    });
    expect(classifyTlsError(enforcedTlsFailure(refused, "mx.example.com"))?.result).toBe(
      "starttls-not-supported",
    );
  });

  test("a stalled handshake: validation-failure", () => {
    expect(
      classifyTlsError(new Error("STARTTLS handshake did not complete within 60 s")),
    ).toEqual({
      result: "validation-failure",
      reason: "starttls-handshake-timeout",
    });
  });

  test("not TLS: null (connection refused, timeouts, SMTP replies, non-errors)", () => {
    expect(
      classifyTlsError(
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      ),
    ).toBeNull();
    expect(
      classifyTlsError(new Error("SMTP session exceeded 1200 s and was closed")),
    ).toBeNull();
    expect(
      classifyTlsError(
        Object.assign(new Error("550 5.1.1 no such user"), { responseCode: 550 }),
      ),
    ).toBeNull();
    expect(classifyTlsError("certificate has expired")).toBeNull();
    expect(classifyTlsError(undefined)).toBeNull();
  });
});

describe("classifySession", () => {
  const at = { mxHost: "mx.example.com", address: "203.0.113.5" };

  test("STARTTLS negotiated: success", () => {
    expect(
      classifySession(NO_POLICY, { ...at, outcomes: [{ tls: "starttls" }] }),
    ).toEqual({
      result: "success",
    });
  });

  test("a delivery that failed after TLS (an SMTP reply) still negotiated TLS: success", () => {
    const outcomes = [
      {
        tls: "starttls" as const,
        error: Object.assign(new Error("550"), { responseCode: 550 }),
      },
    ];
    expect(classifySession(NO_POLICY, { ...at, outcomes })?.result).toBe("success");
  });

  test("plaintext: starttls-not-supported, with the MX host and address", () => {
    expect(
      classifySession(NO_POLICY, { ...at, outcomes: [{ tls: "plaintext" }] }),
    ).toEqual({
      result: "starttls-not-supported",
      receivingMxHostname: "mx.example.com",
      receivingIp: "203.0.113.5",
      failureReasonCode: "",
    });
  });

  test("an enforce-mode certificate failure: its result type", () => {
    const error = enforcedTlsFailure(
      initiatingTls("certificate has expired"),
      "a.mail.example.com",
    );
    expect(
      classifySession(ENFORCE, {
        mxHost: "a.mail.example.com",
        address: "198.51.100.1",
        outcomes: [{ tls: null, error }],
      }),
    ).toMatchObject({
      result: "certificate-expired",
      receivingMxHostname: "a.mail.example.com",
    });
  });

  test("a testing-mode session to an MX outside the policy: validation-failure", () => {
    expect(
      classifySession(TESTING, {
        mxHost: "other.example.net",
        address: "203.0.113.9",
        outcomes: [{ tls: "starttls" }],
      }),
    ).toEqual({
      result: "validation-failure",
      receivingMxHostname: "other.example.net",
      receivingIp: "203.0.113.9",
      failureReasonCode: "mx-not-in-policy",
    });
  });

  test("a policy that could not be fetched: every session is that failure", () => {
    const policy = tlsRptPolicyOf({ policy: null, failure: "webpki-invalid" });
    expect(
      classifySession(policy, { ...at, outcomes: [{ tls: "starttls" }] })?.result,
    ).toBe("sts-webpki-invalid");
  });

  test("not reported: nothing attempted (rate budget), or a non-TLS failure", () => {
    expect(classifySession(NO_POLICY, { ...at, outcomes: [] })).toBeNull();
    expect(
      classifySession(NO_POLICY, { ...at, outcomes: [{ tls: null, deferredMs: 1000 }] }),
    ).toBeNull();
    expect(
      classifySession(NO_POLICY, {
        ...at,
        outcomes: [
          {
            tls: null,
            error: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
          },
        ],
      }),
    ).toBeNull();
  });

  test("an attempt with no matching MX at all: validation-failure without host", () => {
    expect(noMatchingMxObservation()).toEqual({
      result: "validation-failure",
      receivingMxHostname: "",
      receivingIp: "",
      failureReasonCode: "mx-not-in-policy",
    });
  });
});
