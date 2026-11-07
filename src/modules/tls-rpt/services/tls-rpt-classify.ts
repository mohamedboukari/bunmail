import { tlsaPresentation } from "../../../utils/dns-rdata.ts";
import type { DeliveryTls } from "../../emails/models/email.schema.ts";
import { mxMatchesPattern, type MtaStsDiscovery } from "../../emails/services/mta-sts.ts";
import type { DaneHost } from "../../emails/types/dane.types.ts";
import { usableTlsa } from "../../emails/services/dane-verify.ts";
import type {
  TlsRptFailureType,
  TlsRptObservation,
  TlsRptPolicy,
  TlsRptPolicyFailure,
  TlsRptReasonCode,
} from "../types/tls-rpt.types.ts";

/**
 * What BunMail reports for a session (RFC 8460 section 4.3, #345), from
 * what it actually observes. Pure, so every mapping is unit-tested.
 *
 * Only the result types BunMail can tell apart are used:
 *
 * - `starttls-not-supported`: the session ran in plaintext (the MX did not
 *   offer STARTTLS, or refused it), or STARTTLS was required (MTA-STS
 *   `enforce`) and the MX refused it.
 * - `certificate-expired`, `certificate-host-mismatch`,
 *   `certificate-not-trusted`: verified TLS (MTA-STS `enforce`) failed on
 *   the certificate. Without `enforce`, certificates are not verified, so
 *   these never appear for other sessions.
 * - `sts-policy-fetch-error`, `sts-policy-invalid`, `sts-webpki-invalid`:
 *   the domain announced an MTA-STS policy that could not be fetched.
 * - `validation-failure`, with a fixed reason code: an MX host outside the
 *   policy (`mx-not-in-policy`), a certificate not yet valid, a handshake
 *   that stalled or failed otherwise, a certificate chain no TLSA record
 *   matches (`dane-tlsa-mismatch`).
 * - DANE (#345, policy type `tlsa`): `tlsa-invalid` for every session to a
 *   host whose TLSA records are all invalid by the RFC rules (RFC 8460
 *   section 4.3.2.1: none of the records was found valid; the mail still
 *   goes over unauthenticated TLS). Records that are valid but unsupported
 *   here (DANE-TA under Bun 1.3.14) are not invalid: a host with no usable
 *   record and at least one such record is reported as without DANE
 *   ({@link danePolicyOf} returns `null`). `dnssec-invalid` for a host skipped because a
 *   DNSSEC lookup failed (no valid records from the resolver), and the
 *   certificate results above for a DANE-TA chain that does not verify
 *   (`certificate-not-trusted`), names the wrong host
 *   (`certificate-host-mismatch`) or has expired. `dane-required` is not
 *   used: BunMail has no mandatory-DANE setting (RFC 7672 section 6).
 *
 * A session that failed before TLS mattered (refused connection, timeout,
 * an SMTP reply) is not reported: RFC 8460 section 4.3 leaves transient
 * failures out.
 */

/** The `policy-string` of an applied MTA-STS policy: its fields, one per line (RFC 8460 section 4.4). */
function policyLines(policy: NonNullable<MtaStsDiscovery["policy"]>["policy"]): string[] {
  return [
    "version: STSv1",
    `mode: ${policy.mode}`,
    ...policy.mx.map((pattern) => `mx: ${pattern}`),
    `max_age: ${policy.maxAge}`,
  ];
}

/** The TLS-RPT failure of an MTA-STS fetch failure. */
const POLICY_FAILURES: Record<
  NonNullable<MtaStsDiscovery["failure"]>,
  TlsRptPolicyFailure
> = {
  "fetch-error": "sts-policy-fetch-error",
  "policy-invalid": "sts-policy-invalid",
  "webpki-invalid": "sts-webpki-invalid",
};

/**
 * The policy a domain's mail goes out under on this attempt, from its
 * MTA-STS discovery: `sts` with the policy when one is in force (a fetch
 * failure with a cached policy kept is not reported: the policy applied),
 * `sts` with the failure when one was announced but none could be fetched,
 * else `no-policy-found`.
 */
export function tlsRptPolicyOf(discovery: MtaStsDiscovery): TlsRptPolicy {
  if (discovery.policy !== null) {
    const policy = discovery.policy.policy;
    return {
      type: "sts",
      policyString: policyLines(policy),
      mxHost: [...policy.mx],
      mode: policy.mode,
      policyFailure: null,
    };
  }
  if (discovery.failure !== null) {
    return {
      type: "sts",
      policyString: [],
      mxHost: [],
      mode: null,
      policyFailure: POLICY_FAILURES[discovery.failure],
    };
  }
  return {
    type: "no-policy-found",
    policyString: [],
    mxHost: [],
    mode: null,
    policyFailure: null,
  };
}

/**
 * The `tlsa` policy of a session under DANE (#345): the host's TLSA
 * records in presentation form (RFC 8460 section 4.4, RFC 6698 section
 * 2.2) and its name as `mx-host`.
 *
 * With no usable record, the reading closest to RFC 8460 section 4.3.2.1
 * ("none of the records in the RRset were found to be valid"):
 *
 * - every record invalid by the RFC rules (PKIX usages, unknown selector or
 *   matching type, a digest of the wrong length, Full data that does not
 *   parse): `tlsa-invalid` as the policy failure;
 * - at least one record valid but unsupported by this implementation
 *   (DANE-TA while the runtime hides the peer chain, `PEER_CHAIN_AVAILABLE`):
 *   the set is not invalid, and BunMail did not apply it, so no `tlsa`
 *   result is claimed either way. `null`: the caller reports the session
 *   as without DANE (the domain's MTA-STS policy, or `no-policy-found`).
 */
export function danePolicyOf(host: DaneHost): TlsRptPolicy | null {
  if (host.usable.length === 0 && usableTlsa(host.records, true).length > 0) return null;
  return {
    type: "tlsa",
    policyString: host.records.map(tlsaPresentation),
    mxHost: [host.mxHost],
    mode: null,
    policyFailure: host.usable.length === 0 ? "tlsa-invalid" : null,
  };
}

/**
 * The `tlsa` policy of an MX host whose DANE lookups failed (#345): no
 * records could be obtained, so the policy string is empty.
 */
export function daneUnknownPolicyOf(mxHost: string): TlsRptPolicy {
  return {
    type: "tlsa",
    policyString: [],
    mxHost: [mxHost],
    mode: null,
    policyFailure: null,
  };
}

/** What a host skipped for a failed DNSSEC lookup is recorded as: nothing was connected to. */
export function dnssecInvalidObservation(mxHost: string): TlsRptObservation {
  return failure("dnssec-invalid", mxHost, "");
}

/** A failure observation of a session to `mxHost` at `address`. */
function failure(
  result: TlsRptFailureType,
  mxHost: string,
  address: string,
  failureReasonCode: TlsRptReasonCode = "",
): TlsRptObservation {
  return { result, receivingMxHostname: mxHost, receivingIp: address, failureReasonCode };
}

/** Error codes of a TLS failure on the socket (Node and Bun). */
const TLS_CODE_RE =
  /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH)/;

/** The error's message and its `code`/`originalCode`, for matching. */
function errorText(error: Error): string {
  const parts = [error.message];
  for (const field of ["code", "originalCode"]) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === "string") parts.push(value);
  }
  return parts.join(" ");
}

/**
 * The TLS-RPT failure a session error stands for, or `null` when it is not
 * a TLS failure. Matches nodemailer's STARTTLS errors (`ETLS`, "Error
 * initiating TLS - <reason>", "Error upgrading connection with STARTTLS"),
 * the enforce-mode wrapper (`enforcedTlsFailure`: "MTA-STS: no verified TLS
 * with <host> (<reason>)", or "DANE: no authenticated TLS with <host>
 * (<reason>)" with the fixed DANE reasons of `dane-verify.ts`), and the
 * OpenSSL reasons and codes Bun reports. Only fixed reason codes come out,
 * never the error's text.
 */
export function classifyTlsError(
  error: unknown,
): { result: TlsRptFailureType; reason: TlsRptReasonCode } | null {
  if (!(error instanceof Error)) return null;
  const text = errorText(error);
  if (
    /Error upgrading connection with STARTTLS|does not support required STARTTLS/.test(
      text,
    )
  ) {
    return { result: "starttls-not-supported", reason: "starttls-refused" };
  }
  if (/STARTTLS handshake did not complete/.test(text)) {
    return { result: "validation-failure", reason: "starttls-handshake-timeout" };
  }
  const tls =
    /\bETLS\b|Error initiating TLS|MTA-STS: no verified TLS|DANE: no authenticated TLS/.test(
      text,
    ) ||
    TLS_CODE_RE.test(String(Reflect.get(error, "code") ?? "")) ||
    TLS_CODE_RE.test(String(Reflect.get(error, "originalCode") ?? ""));
  if (!tls) return null;
  if (/DANE: no TLSA record matches/.test(text)) {
    return { result: "validation-failure", reason: "dane-tlsa-mismatch" };
  }
  if (/DANE: certificate chain does not verify/.test(text)) {
    return { result: "certificate-not-trusted", reason: "" };
  }
  if (/DANE: certificate name mismatch/.test(text)) {
    return { result: "certificate-host-mismatch", reason: "" };
  }
  if (/certificate has expired|CERT_HAS_EXPIRED/i.test(text)) {
    return { result: "certificate-expired", reason: "" };
  }
  if (/not yet valid|CERT_NOT_YET_VALID/i.test(text)) {
    return { result: "validation-failure", reason: "certificate-not-yet-valid" };
  }
  if (
    /altnames|ALTNAME_INVALID|HOSTNAME_MISMATCH|does not match certificate/i.test(text)
  ) {
    return { result: "certificate-host-mismatch", reason: "" };
  }
  if (
    /self[- ]signed|unable to (get|verify)|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED|CERT_UNTRUSTED|CERT_REVOKED|certificate (is )?(not trusted|revoked)/i.test(
      text,
    )
  ) {
    return { result: "certificate-not-trusted", reason: "" };
  }
  return { result: "validation-failure", reason: "tls-handshake-failed" };
}

/** One transaction outcome of a session, as the mailer reports it. */
export interface SessionOutcome {
  error?: unknown;
  tls: DeliveryTls | null;
  /** Not attempted (rate budget): not part of the session. */
  deferredMs?: number;
}

/**
 * What one SMTP session to `mxHost` at `address` is recorded as for a
 * domain under `policy`, or `null` when it is not reported (nothing was
 * attempted, or it failed for a reason that is not TLS). See the module
 * comment for the mapping. The order matters: a policy that could not be
 * fetched, then an MX host outside the policy (in `testing` mode BunMail
 * still connects), then what the session itself showed.
 */
export function classifySession(
  policy: TlsRptPolicy,
  session: { mxHost: string; address: string; outcomes: readonly SessionOutcome[] },
): TlsRptObservation | null {
  const attempted = session.outcomes.filter((o) => o.deferredMs === undefined);
  if (attempted.length === 0) return null;
  const { mxHost, address } = session;
  if (policy.policyFailure !== null)
    return failure(policy.policyFailure, mxHost, address);
  if (
    (policy.mode === "enforce" || policy.mode === "testing") &&
    !policy.mxHost.some((pattern) => mxMatchesPattern(mxHost, pattern))
  ) {
    return failure("validation-failure", mxHost, address, "mx-not-in-policy");
  }
  const tls = attempted.find((o) => o.tls !== null)?.tls ?? null;
  if (tls === "starttls") return { result: "success" };
  if (tls === "plaintext") return failure("starttls-not-supported", mxHost, address);
  for (const outcome of attempted) {
    const tlsFailure = classifyTlsError(outcome.error);
    if (tlsFailure !== null) {
      return failure(tlsFailure.result, mxHost, address, tlsFailure.reason);
    }
  }
  return null;
}

/**
 * What an enforce-mode attempt with no MX host matching the policy is
 * recorded as: nothing was connected to (#250 leaves the email in `retry`).
 */
export function noMatchingMxObservation(): TlsRptObservation {
  return failure("validation-failure", "", "", "mx-not-in-policy");
}
