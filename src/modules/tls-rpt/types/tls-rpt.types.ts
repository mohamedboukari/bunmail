/**
 * Types of SMTP TLS reporting (RFC 8460, #345): what a session to a
 * recipient domain is recorded as, and the policy it was made under.
 */

/** The `policy-type` values BunMail reports (RFC 8460 section 4.4): no DANE. */
export type TlsRptPolicyType = "sts" | "no-policy-found";

/**
 * The failure `result-type` values BunMail can tell apart (RFC 8460 section
 * 4.3). Anything else it sees is `validation-failure` with a reason code.
 */
export type TlsRptFailureType =
  | "starttls-not-supported"
  | "certificate-host-mismatch"
  | "certificate-expired"
  | "certificate-not-trusted"
  | "validation-failure"
  | "sts-policy-fetch-error"
  | "sts-policy-invalid"
  | "sts-webpki-invalid";

/** Every failure result type, in a fixed order (validation of stored rows). */
export const TLSRPT_FAILURE_TYPES: readonly TlsRptFailureType[] = [
  "starttls-not-supported",
  "certificate-host-mismatch",
  "certificate-expired",
  "certificate-not-trusted",
  "validation-failure",
  "sts-policy-fetch-error",
  "sts-policy-invalid",
  "sts-webpki-invalid",
];

/** The MTA-STS failures of the policy itself, not of a session (RFC 8460 section 4.3.2.1). */
export type TlsRptPolicyFailure =
  "sts-policy-fetch-error" | "sts-policy-invalid" | "sts-webpki-invalid";

/** What a stored counter counts: successful sessions, or one failure type. */
export type TlsRptResultType = "success" | TlsRptFailureType;

/**
 * The `failure-reason-code` values BunMail writes: a fixed set, never text
 * from the receiving server (a report must not carry what a peer sent).
 */
export type TlsRptReasonCode =
  | ""
  | "mx-not-in-policy"
  | "starttls-refused"
  | "certificate-not-yet-valid"
  | "starttls-handshake-timeout"
  | "tls-handshake-failed";

/**
 * The policy a recipient domain's mail went out under on one attempt.
 *
 * - `no-policy-found`: no MTA-STS policy (opportunistic TLS).
 * - `sts`: an MTA-STS policy applied (`mode`, `mx`, `policyString`), or
 *   one was announced but could not be fetched (`policyFailure`, and no
 *   policy fields): every session of the attempt counts as that failure.
 */
export interface TlsRptPolicy {
  type: TlsRptPolicyType;
  /** `policy-string`: the applied policy, one line per entry; empty without one. */
  policyString: string[];
  /** `mx-host`: the policy's MX patterns; empty without a policy. */
  mxHost: string[];
  /** The MTA-STS mode, for the MX match of a session; `null` without a policy. */
  mode: "enforce" | "testing" | "none" | null;
  /** A policy announced but not fetched or not valid on this attempt. */
  policyFailure: TlsRptPolicyFailure | null;
}

/** A recipient domain of an MX session and the policy its mail went under. */
export interface TlsRptDomain {
  domain: string;
  policy: TlsRptPolicy;
}

/** What one session (or one attempt that never connected) is recorded as. */
export type TlsRptObservation =
  | { result: "success" }
  | {
      result: TlsRptFailureType;
      /** `receiving-mx-hostname`; empty when no MX host was connected to. */
      receivingMxHostname: string;
      /** `receiving-ip`; empty when no address was connected to. */
      receivingIp: string;
      failureReasonCode: TlsRptReasonCode;
    };

/** A reporting address of a `_smtp._tls` record (RFC 8460 section 3). */
export type TlsRptRua = (
  | {
      scheme: "mailto";
      /** The decoded address, domain lower-cased; logged only through `redactEmail`. */
      address: string;
    }
  | {
      scheme: "https";
      /** The URL; logged only through `redactUrl` (its path may carry a token). */
      url: string;
    }
) & {
  /** The URI as published. */
  uri: string;
  /**
   * The normalised form, for de-duplication and the delivered-set hash:
   * `mailto:` and the whole address lower-cased, or the URL's `href`.
   */
  key: string;
  /**
   * Who receives it, for the per-destination daily cap: the address
   * lower-cased, or the URL's origin.
   */
  destination: string;
};

/** One stored counter of a report: a policy, a result and, for a failure, its detail. */
export interface TlsRptResultRow {
  policyType: TlsRptPolicyType;
  policyHash: string;
  /** `policy-string` lines joined by `\n`. */
  policyString: string;
  /** `mx-host` patterns joined by `\n`. */
  mxHost: string;
  resultType: TlsRptResultType;
  receivingMxHostname: string;
  receivingIp: string;
  failureReasonCode: string;
  sessionCount: number;
}
