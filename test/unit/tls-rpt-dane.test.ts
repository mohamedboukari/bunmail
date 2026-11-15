import { describe, expect, test } from "bun:test";
import {
  classifySession,
  classifyTlsError,
  danePolicyOf,
  sessionPolicies,
  tlsRptPolicyOf,
  type SessionOutcome,
} from "../../src/modules/tls-rpt/services/tls-rpt-classify.ts";
import {
  DANE_FAILURE_MESSAGES,
  DANE_HANDSHAKE_INCOMPLETE,
  usableTlsa,
} from "../../src/modules/emails/services/dane-verify.ts";
import { sessionTls } from "../../src/modules/emails/services/mailer-dane.service.ts";
import { enforcedTlsFailure } from "../../src/modules/emails/services/mx-transport.ts";
import type { DaneHost } from "../../src/modules/emails/types/dane.types.ts";
import type {
  TlsRptDomain,
  TlsRptFailureType,
  TlsRptObservation,
  TlsRptReasonCode,
} from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";
import type { TlsaRecord } from "../../src/utils/dns-rdata.ts";

/**
 * DANE in TLS reports (#345, RFC 8460): a session to a host under DANE is
 * reported under a `tlsa` policy whose string is the TLSA records in
 * presentation form; all-unusable records are `tlsa-invalid`; DANE-TA
 * records are applied like DANE-EE ones (#455); the DANE check's failures
 * map to fixed result types and reason codes.
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

  /** A host with `records`, usable as in production. */
  function hostWith(records: TlsaRecord[]): DaneHost {
    return { ...host(true), records, usable: usableTlsa(records) };
  }

  test("every record invalid by the RFC rules: tlsa-invalid on every session, even a delivered one", () => {
    const policy = danePolicyOf(host(false));
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
    expect(danePolicyOf(invalid).policyFailure).toBe("tlsa-invalid");
  });

  test("only DANE-TA records (#455): a tlsa policy, applied; a session is a tlsa success or failure", () => {
    const policy = danePolicyOf(hostWith([{ ...RECORD, usage: 2, selector: 0 }]));
    expect(policy).toEqual({
      type: "tlsa",
      policyString: [`2 0 1 ${"AB".repeat(32)}`],
      mxHost: ["mx.example.org"],
      mode: null,
      policyFailure: null,
    });
    expect(classifySession(policy, { ...AT, outcomes: [{ tls: "starttls" }] })).toEqual({
      result: "success",
    });
    const refused = classifySession(policy, {
      ...AT,
      outcomes: [{ tls: null, error: daneError(DANE_FAILURE_MESSAGES["chain-invalid"]) }],
    });
    expect(refused).toEqual({
      result: "certificate-not-trusted",
      receivingMxHostname: "mx.example.org",
      receivingIp: "203.0.113.4",
      failureReasonCode: "",
    });
  });

  test("RFC-invalid records beside a DANE-TA one: a tlsa policy, not tlsa-invalid", () => {
    const policy = danePolicyOf(
      hostWith([
        { ...RECORD, usage: 1 },
        { ...RECORD, usage: 2, selector: 0 },
      ]),
    );
    expect(policy.type).toBe("tlsa");
    expect(policy.policyFailure).toBeNull();
  });

  test("DANE-EE beside DANE-TA: a tlsa policy listing every record, applied", () => {
    const policy = danePolicyOf(hostWith([RECORD, { ...RECORD, usage: 2, selector: 0 }]));
    expect(policy.policyString).toEqual([
      `3 1 1 ${"AB".repeat(32)}`,
      `2 0 1 ${"AB".repeat(32)}`,
    ]);
    expect(policy.policyFailure).toBeNull();
  });

  test("an authenticated session is a success", () => {
    expect(
      classifySession(danePolicyOf(host(true)), {
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

describe("sessionPolicies: which policies a session is reported under (#473)", () => {
  /** The domain's attempt under an MTA-STS policy in `mode`, or none. */
  function target(mode: "enforce" | "testing" | null): TlsRptDomain {
    return {
      domain: "example.org",
      policy: tlsRptPolicyOf({
        policy:
          mode === null
            ? null
            : { id: "p1", policy: { mode, mx: ["*.example.org"], maxAge: 86_400 } },
        failure: null,
      }),
    };
  }

  /** A host with `records`, usable as in production. */
  function hostWith(records: TlsaRecord[]): DaneHost {
    return { ...host(true), records, usable: usableTlsa(records) };
  }

  /**
   * What one session to `dane` (or a host DANE does not apply to) is
   * recorded as for the domain, policy type by policy type: the session's
   * TLS as the mailer picks it (`sessionTls`), then `sessionPolicies`
   * and `classifySession`, as `mailer-delivery.service.ts` wires them.
   */
  function recorded(
    mode: "enforce" | "testing" | null,
    dane: DaneHost | null,
    outcomes: SessionOutcome[],
  ): Array<{ type: string; observation: TlsRptObservation | null }> {
    const tls = sessionTls(dane, mode === "enforce");
    const stsSecured = dane !== null && tls.dane === undefined;
    return sessionPolicies(target(mode), dane, stsSecured).map(({ policy }) => ({
      type: policy.type,
      observation: classifySession(policy, { ...AT, outcomes }),
    }));
  }

  const PKIX_EE = { ...RECORD, usage: 1 };
  const PKIX_TA = { ...RECORD, usage: 0 };
  const TLSA_INVALID: TlsRptObservation = {
    result: "tlsa-invalid",
    receivingMxHostname: "mx.example.org",
    receivingIp: "203.0.113.4",
    failureReasonCode: "",
  };

  /** An MTA-STS verified TLS failure as the session reports it: nodemailer's error, then the enforce wrapper. */
  function stsError(reason: string): unknown {
    const nodemailer = Object.assign(new Error(`Error initiating TLS - ${reason}`), {
      code: "ETLS",
      command: "STARTTLS",
    });
    return enforcedTlsFailure(nodemailer, "mx.example.org", "MTA-STS");
  }

  test("PKIX-only TLSA under an enforce policy, verified: an sts success, and tlsa-invalid under tlsa", () => {
    for (const records of [[PKIX_EE], [PKIX_TA], [PKIX_EE, PKIX_TA]]) {
      expect(recorded("enforce", hostWith(records), [{ tls: "starttls" }])).toEqual([
        { type: "sts", observation: { result: "success" } },
        { type: "tlsa", observation: TLSA_INVALID },
      ]);
    }
  });

  test("PKIX-only TLSA under an enforce policy, a certificate failure: the MTA-STS result under sts", () => {
    const failures: Array<[string, TlsRptFailureType, TlsRptReasonCode]> = [
      ["certificate has expired", "certificate-expired", ""],
      [
        "Hostname/IP does not match certificate's altnames",
        "certificate-host-mismatch",
        "",
      ],
      ["self-signed certificate", "certificate-not-trusted", ""],
      ["certificate is not yet valid", "validation-failure", "certificate-not-yet-valid"],
    ];
    for (const [reason, result, failureReasonCode] of failures) {
      expect(
        recorded("enforce", hostWith([PKIX_EE]), [
          { tls: null, error: stsError(reason) },
        ]),
      ).toEqual([
        {
          type: "sts",
          observation: {
            result,
            receivingMxHostname: "mx.example.org",
            receivingIp: "203.0.113.4",
            failureReasonCode,
          },
        },
        { type: "tlsa", observation: TLSA_INVALID },
      ]);
    }
  });

  test("the sts entry carries the enforce policy itself", () => {
    const [sts, tlsa] = sessionPolicies(target("enforce"), hostWith([PKIX_EE]), true);
    expect(sts).toEqual(target("enforce"));
    expect(tlsa?.policy).toMatchObject({
      type: "tlsa",
      policyString: [`1 1 1 ${"AB".repeat(32)}`],
      policyFailure: "tlsa-invalid",
    });
  });

  test("PKIX-only TLSA without an enforce policy: tlsa-invalid under tlsa only, as before", () => {
    for (const mode of ["testing", null] as const) {
      expect(recorded(mode, hostWith([PKIX_EE]), [{ tls: "starttls" }])).toEqual([
        { type: "tlsa", observation: TLSA_INVALID },
      ]);
    }
  });

  test("usable DANE-EE or DANE-TA, with or without an enforce policy: tlsa only", () => {
    const usable = [[RECORD], [{ ...RECORD, usage: 2, selector: 0 }], [PKIX_EE, RECORD]];
    for (const records of usable) {
      for (const mode of ["enforce", "testing", null] as const) {
        expect(recorded(mode, hostWith(records), [{ tls: "starttls" }])).toEqual([
          { type: "tlsa", observation: { result: "success" } },
        ]);
      }
    }
    expect(
      recorded("enforce", host(true), [
        { tls: null, error: daneError(DANE_FAILURE_MESSAGES["no-match"]) },
      ]),
    ).toEqual([
      {
        type: "tlsa",
        observation: {
          result: "validation-failure",
          receivingMxHostname: "mx.example.org",
          receivingIp: "203.0.113.4",
          failureReasonCode: "dane-tlsa-mismatch",
        },
      },
    ]);
  });

  test("no DANE for the host: the domain's own policy only", () => {
    expect(recorded("enforce", null, [{ tls: "starttls" }])).toEqual([
      { type: "sts", observation: { result: "success" } },
    ]);
    expect(recorded(null, null, [{ tls: "starttls" }])).toEqual([
      { type: "no-policy-found", observation: { result: "success" } },
    ]);
  });
});
