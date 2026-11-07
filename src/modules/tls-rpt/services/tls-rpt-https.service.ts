import {
  BlockedUrlError,
  buildPinnedRequest,
  resolvePublicWebhookTarget,
  type ResolveAll,
} from "../../../utils/ssrf-guard.ts";

/**
 * Sends a TLS report by HTTPS POST (RFC 8460 section 5.4, #345).
 *
 * The URL comes from the recipient domain's `_smtp._tls` record, so whoever
 * controls that domain chooses where BunMail connects: the same SSRF
 * protections as webhook delivery (#128) apply, on every attempt.
 *
 * - `https:` only, never `http:`, whatever `WEBHOOK_ALLOW_INSECURE_HTTP` says.
 * - The host is resolved once and refused when any address is private,
 *   loopback, link-local, CGNAT, multicast or reserved
 *   (`resolvePublicWebhookTarget`); the request then goes to that checked
 *   address (`buildPinnedRequest`), the host name as SNI, the `Host`
 *   header and the certificate name. The certificate is verified (RFC 8460
 *   lets a submitter skip that; BunMail does not).
 * - No redirects (a 3xx is a failure), no connection reuse, no response
 *   decompression, and the response body is never read: only the status.
 * - One timeout over the whole request; the body is the gzipped report,
 *   already capped by the caller.
 */

/** Longest one POST may take, connection to response headers. */
export const TLSRPT_HTTPS_TIMEOUT_MS = 30_000;

/** What a send attempt did; `reason` is fixed text or a status, never the URL or the body. */
export type ReportSendOutcome =
  | { kind: "sent" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/** The fetch and the DNS lookup, replaceable in tests. */
export interface TlsRptHttpsDeps {
  fetch: (url: string, init: BunFetchRequestInit) => Promise<Response>;
  /** Address lookup for the SSRF guard; the system resolver by default. */
  resolver?: ResolveAll;
  timeoutMs: number;
}

const realDeps: TlsRptHttpsDeps = {
  fetch: (url, init) => fetch(url, init),
  timeoutMs: TLSRPT_HTTPS_TIMEOUT_MS,
};

/**
 * POSTs `body` (`application/tlsrpt+gzip`) to `url`. `sent` on any 2xx
 * (RFC 8460 section 5.4); `failed` with a short reason otherwise. Never
 * throws.
 */
export async function postReport(
  url: string,
  body: Uint8Array,
  deps: TlsRptHttpsDeps = realDeps,
): Promise<ReportSendOutcome> {
  let pinned: ReturnType<typeof buildPinnedRequest>;
  try {
    const target = await resolvePublicWebhookTarget(url, false, deps.resolver);
    pinned = buildPinnedRequest(target);
  } catch (error) {
    return {
      kind: "failed",
      reason:
        error instanceof BlockedUrlError
          ? "target refused (not a public https address)"
          : "target could not be checked",
    };
  }

  let response: Response;
  try {
    response = await deps.fetch(pinned.url, {
      method: "POST",
      headers: {
        Host: pinned.host,
        "Content-Type": "application/tlsrpt+gzip",
        "Accept-Encoding": "identity",
      },
      body,
      /** SNI and the certificate checked against the host name. */
      tls: { ...pinned.tls, rejectUnauthorized: true },
      /** A redirect into an internal address would bypass the address check. */
      redirect: "manual",
      /** A pooled connection could have been verified for another name. */
      keepalive: false,
      /** Never inflate an untrusted body. */
      decompress: false,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { kind: "failed", reason: timedOut ? "timed out" : "connection failed" };
  }
  /** Only the status matters: the body is never read. */
  await response.body?.cancel().catch(() => undefined);
  if (response.status >= 200 && response.status < 300) return { kind: "sent" };
  return { kind: "failed", reason: `HTTP ${response.status}` };
}
