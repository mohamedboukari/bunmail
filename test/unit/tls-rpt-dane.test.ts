import { describe, expect, test } from "bun:test";
import {
  classifySession,
  classifyTlsError,
  danePolicyOf,
} from "../../src/modules/tls-rpt/services/tls-rpt-classify.ts";
import {
  DANE_FAILURE_MESSAGES,
  DANE_HANDSHAKE_INCOMPLETE,
  usableTlsa,
} from "../../src/modules/emails/services/dane-verify.ts";
import { enforcedTlsFailure } from "../../src/modules/emails/services/mx-transport.ts";
import type { DaneHost } from "../../src/modules/emails/types/dane.types.ts";
import type { TlsRptPolicy } from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";
import type { TlsaRecord } from "../../src/utils/dns-rdata.ts";

/**
 * DANE in TLS reports (#345, RFC 8460): a session to a host under DANE is
 * reported under a `tlsa` policy whose string is the TLSA records in
 * presentation form; all-unusable records are `tlsa-invalid`; the DANE
 * check's failures map to fixed result types and reason codes.
 */

const RECORD = {
  usage: 3,
  selector: 1,
  matchingType: 1,
  data: new Uint8Array(32).fill(0xab),
};

/** A DANE host with `usable` records. */
function host(usable: boolean): DaneHost {
  const unusable = { ...RECORD, usage: 1 };
  return {
    mxHost: "mx.example.org",
    baseDomain: "mx.example.org",
    referenceIds: ["mx.example.org", "example.org"],
    records: usable ? [RECORD] : [unusable],
    usable: usable ? [RECORD] : [],
  };
}

/** A DANE session failure as the session reports it: nodemailer's error, then the DANE wrapper. */
function daneError(reason: string): unknown {
  const nodemailer = Object.assign(new Error(`Error initiating TLS - ${reason}`), {
    code: "ETLS",
    command: "STARTTLS",
  });
  return enforcedTlsFailure(nodemailer, "mx.example.org", "DANE");
}

const AT = { mxHost: "mx.example.org", address: "203.0.113.4" };

describe("danePolicyOf", () => {
  test("policy type tlsa, the records in presentation form, the MX host", () => {
    expect(danePolicyOf(host(true))).toEqual({
      type: "tlsa",
      policyString: [`3 1 1 ${"AB".repeat(32)}`],
      mxHost: ["mx.example.org"],
      mode: null,
      policyFailure: null,
    });
  });

  /** The policy of `host`, which must be one. */
  function policyOf(daneHost: DaneHost): TlsRptPolicy {
    const policy = danePolicyOf(daneHost);
    if (policy === null) throw new Error("expected a tlsa policy");
    return policy;
  }

  /** A host with `records`, usable as in production. */
  function hostWith(records: TlsaRecord[]): DaneHost {
    return { ...host(true), records, usable: usableTlsa(records) };
  }

  test("every record invalid by the RFC rules: tlsa-invalid on every session, even a delivered one", () => {
    const policy = policyOf(host(false));
    expect(policy.policyFailure).toBe("tlsa-invalid");
    expect(classifySession(policy, { ...AT, outcomes: [{ tls: "starttls" }] })).toEqual({
      result: "tlsa-invalid",
      receivingMxHostname: "mx.example.org",
      receivingIp: "203.0.113.4",
      failureReasonCode: "",
    });
    /** A wrong digest length and an unknown matching type are invalid too. */
    const invalid = hostWith([
      { ...RECORD, data: RECORD.data.subarray(0, 20) },
      { ...RECORD, matchingType: 9 },
    ]);
    expect(policyOf(invalid).policyFailure).toBe("tlsa-invalid");
  });

  test("only DANE-TA records (valid, unsupported under Bun 1.3.14): no tlsa result claimed", () => {
    expect(danePolicyOf(hostWith([{ ...RECORD, usage: 2, selector: 0 }]))).toBeNull();
  });

  test("RFC-invalid records beside a merely unsupported one: still no tlsa-invalid", () => {
    expect(
      danePolicyOf(
        hostWith([
          { ...RECORD, usage: 1 },
          { ...RECORD, usage: 2, selector: 0 },
        ]),
      ),
    ).toBeNull();
  });

  test("DANE-EE beside DANE-TA: a tlsa policy listing every record, applied", () => {
    const policy = policyOf(hostWith([RECORD, { ...RECORD, usage: 2, selector: 0 }]));
    expect(policy.policyString).toEqual([
      `3 1 1 ${"AB".repeat(32)}`,
      `2 0 1 ${"AB".repeat(32)}`,
    ]);
    expect(policy.policyFailure).toBeNull();
  });

  test("an authenticated session is a success", () => {
    expect(
      classifySession(policyOf(host(true)), {
        ...AT,
        outcomes: [{ tls: "starttls" }],
      }),
    ).toEqual({ result: "success" });
  });
});

describe("classifyTlsError: DANE failures", () => {
  test("each DANE check failure maps to a fixed result", () => {
    expect(classifyTlsError(daneError(DANE_FAILURE_MESSAGES["no-match"]))).toEqual({
      result: "validation-failure",
      reason: "dane-tlsa-mismatch",
    });
    expect(classifyTlsError(daneError(DANE_FAILURE_MESSAGES["no-certificate"]))).toEqual({
      result: "validation-failure",
      reason: "dane-tlsa-mismatch",
    });
    expect(classifyTlsError(daneError(DANE_FAILURE_MESSAGES["chain-invalid"]))).toEqual({
      result: "certificate-not-trusted",
      reason: "",
    });
    expect(classifyTlsError(daneError(DANE_FAILURE_MESSAGES["name-mismatch"]))).toEqual({
      result: "certificate-host-mismatch",
      reason: "",
    });
    expect(classifyTlsError(daneError(DANE_FAILURE_MESSAGES.expired))).toEqual({
      result: "certificate-expired",
      reason: "",
    });
    expect(classifyTlsError(daneError(DANE_FAILURE_MESSAGES["not-yet-valid"]))).toEqual({
      result: "validation-failure",
      reason: "certificate-not-yet-valid",
    });
  });

  test("a handshake that did not complete is a handshake failure", () => {
    expect(classifyTlsError(daneError(DANE_HANDSHAKE_INCOMPLETE))).toEqual({
      result: "validation-failure",
      reason: "tls-handshake-failed",
    });
  });

  test("a refused STARTTLS under DANE is starttls-not-supported", () => {
    const refused = Object.assign(new Error("Error upgrading connection with STARTTLS"), {
      code: "ETLS",
      responseCode: 502,
      command: "STARTTLS",
    });
    const mapped = enforcedTlsFailure(refused, "mx.example.org", "DANE");
    expect(classifyTlsError(mapped)).toEqual({
      result: "starttls-not-supported",
      reason: "starttls-refused",
    });
  });
});
