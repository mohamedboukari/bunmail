import { lookup } from "dns/promises";
import {
  BlockedUrlError,
  buildPinnedRequest,
  resolvePublicWebhookTarget,
  type ResolveAll,
} from "../../../utils/ssrf-guard.ts";
import type { BimiFinding } from "../types/bimi.types.ts";
import type { BimiPart } from "./bimi-record.ts";
import { svgTinyPsProblems } from "./bimi-svg.ts";

/**
 * The BIMI logo fetch (#415). The `l=` URL comes from the domain's DNS,
 * so whoever controls that DNS chooses where BunMail connects: the
 * webhook SSRF guard applies (#128), as for TLS reports (#345).
 *
 * - `https:` only. The host is resolved once and refused when any address
 *   is private, loopback, link-local, CGNAT, multicast or reserved
 *   (`resolvePublicWebhookTarget`); the request goes to that checked
 *   address (`buildPinnedRequest`), the host name as SNI, `Host` header
 *   and certificate name, the certificate verified.
 * - No redirects (a 3xx is a failure, never followed), no connection
 *   reuse, no decompression (a compressed logo is refused).
 * - One timeout over the address lookup, the request and the body, and a
 *   body cap of 32 KB (the BIMI SVG profile's size limit), checked
 *   against `Content-Length` and while reading.
 *
 * The body is checked by `bimi-svg.ts` and then dropped: never stored,
 * never rendered. Findings never quote the URL's query or a fetch error's
 * message (it can embed the URL).
 */

/** Largest logo read, in bytes. */
export const BIMI_LOGO_MAX_BYTES = 32 * 1024;

/** Longest the fetch may take: address lookup, request and body. */
export const BIMI_LOGO_TIMEOUT_MS = 10_000;

/** The fetch and the address lookup, replaceable in tests. */
export interface BimiLogoDeps {
  /** Bun's fetch: `tls`, `decompress` and `redirect: "manual"` are used. */
  fetch: (url: string, init: BunFetchRequestInit) => Promise<Response>;
  /** Every address of a host, for the SSRF guard. */
  resolver: ResolveAll;
  timeoutMs: number;
}

const realDeps: BimiLogoDeps = {
  fetch: (url, init) => fetch(url, init),
  resolver: (host) => lookup(host, { all: true }),
  timeoutMs: BIMI_LOGO_TIMEOUT_MS,
};

let currentDeps: BimiLogoDeps = realDeps;

/**
 * Replaces the fetch or the address lookup (tests), or restores the real
 * ones with `null`.
 */
export function setBimiLogoDeps(override: Partial<BimiLogoDeps> | null): void {
  currentDeps = override === null ? realDeps : { ...realDeps, ...override };
}

/** What fetching the logo gave; `reason` is fixed text, never the URL. */
type LogoFetch =
  | { kind: "fetched"; body: string; contentType: string }
  /** A definitive failure: the URL or the response breaks a rule. */
  | { kind: "refused"; reason: string }
  /** A temporary failure: DNS, the connection, a timeout, a 5xx. */
  | { kind: "failed"; reason: string };

/** Thrown inside the body read when the logo is over the cap. */
class LogoTooLargeError extends Error {
  override readonly name = "LogoTooLargeError";
}

/** Reads at most {@link BIMI_LOGO_MAX_BYTES} of the body, or throws {@link LogoTooLargeError}. */
async function readCapped(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BIMI_LOGO_MAX_BYTES) throw new LogoTooLargeError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/** The over-the-cap refusal. */
const TOO_LARGE = `The logo is larger than ${BIMI_LOGO_MAX_BYTES / 1024} KB: the BIMI SVG profile allows 32 KB at most`;

/** `promise`, or a rejection with the signal's reason once `signal` aborts. */
function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

/** True for the abort of {@link within}'s or fetch's timeout signal. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Fetches the logo at `url` under the rules above. Never throws.
 * Exported for the tests.
 */
export async function fetchBimiLogo(url: string, deps: BimiLogoDeps): Promise<LogoFetch> {
  const signal = AbortSignal.timeout(deps.timeoutMs);
  /** Whether the address lookup itself failed, to tell it from a refused address. */
  let unresolved = false;
  const resolver: ResolveAll = async (host) => {
    try {
      const addresses = await within(deps.resolver(host), signal);
      if (addresses.length === 0) unresolved = true;
      return addresses;
    } catch (error) {
      unresolved = true;
      throw error;
    }
  };

  let pinned: ReturnType<typeof buildPinnedRequest>;
  try {
    pinned = buildPinnedRequest(await resolvePublicWebhookTarget(url, false, resolver));
  } catch (error) {
    if (!(error instanceof BlockedUrlError)) {
      return { kind: "failed", reason: "The logo URL could not be checked" };
    }
    if (unresolved) {
      return { kind: "failed", reason: "The logo host could not be resolved" };
    }
    return {
      kind: "refused",
      reason:
        "The logo URL was refused: it must be https on a public address (not private, loopback or reserved)",
    };
  }

  let response: Response;
  try {
    response = await deps.fetch(pinned.url, {
      method: "GET",
      headers: {
        Host: pinned.host,
        Accept: "image/svg+xml",
        "Accept-Encoding": "identity",
      },
      /** SNI and the certificate checked against the host name. */
      tls: { ...pinned.tls, rejectUnauthorized: true },
      /** A redirect into an internal address would bypass the address check. */
      redirect: "manual",
      /** A pooled connection could have been verified for another name. */
      keepalive: false,
      /** Never inflate an untrusted body. */
      decompress: false,
      signal,
    });
  } catch (error) {
    return {
      kind: "failed",
      reason: isTimeout(error)
        ? "The logo fetch timed out"
        : "The logo fetch failed (connection or TLS certificate)",
    };
  }

  try {
    const status = response.status;
    if (status >= 300 && status < 400) {
      return {
        kind: "refused",
        reason: `The logo URL redirects (HTTP ${status}): serve the logo at the l= URL itself, redirects are not followed`,
      };
    }
    if (status >= 500) {
      return { kind: "failed", reason: `The logo server answered HTTP ${status}` };
    }
    if (status !== 200) {
      return { kind: "refused", reason: `The logo URL answered HTTP ${status}` };
    }
    const encoding = (response.headers.get("content-encoding") ?? "")
      .trim()
      .toLowerCase();
    if (encoding !== "" && encoding !== "identity") {
      return {
        kind: "refused",
        reason: "The logo is served compressed: BIMI logos must be plain SVG, not SVGZ",
      };
    }
    const length = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > BIMI_LOGO_MAX_BYTES) {
      return { kind: "refused", reason: TOO_LARGE };
    }
    const bytes = await readCapped(response);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return { kind: "refused", reason: "The logo is not UTF-8 text" };
    }
    const contentType =
      (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ??
      "";
    return { kind: "fetched", body, contentType };
  } catch (error) {
    if (error instanceof LogoTooLargeError) return { kind: "refused", reason: TOO_LARGE };
    return {
      kind: "failed",
      reason: isTimeout(error)
        ? "The logo fetch timed out"
        : "The logo could not be read to the end",
    };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** A finding about the logo. */
function logoFinding(severity: BimiFinding["severity"], text: string): BimiFinding {
  return { area: "logo", severity, text };
}

/**
 * Fetches the logo at `url` and checks it against SVG Tiny PS (#415).
 * `unknown` when the fetch failed for a temporary reason. Never throws.
 */
export async function checkBimiLogo(
  url: string,
  deps: BimiLogoDeps = currentDeps,
): Promise<BimiPart & { fetch: LogoFetch["kind"] }> {
  const fetched = await fetchBimiLogo(url, deps);
  if (fetched.kind === "failed") {
    return {
      fetch: fetched.kind,
      outcome: "unknown",
      findings: [logoFinding("warn", `${fetched.reason}: try again later`)],
    };
  }
  if (fetched.kind === "refused") {
    return {
      fetch: fetched.kind,
      outcome: "fail",
      findings: [logoFinding("fail", fetched.reason)],
    };
  }
  const findings: BimiFinding[] = [];
  if (fetched.contentType !== "image/svg+xml") {
    findings.push(
      logoFinding(
        "warn",
        fetched.contentType === ""
          ? "The logo is served without a Content-Type: serve it as image/svg+xml"
          : `The logo is served as ${fetched.contentType.slice(0, 64)}: serve it as image/svg+xml`,
      ),
    );
  }
  const problems = svgTinyPsProblems(fetched.body);
  if (problems.length === 0) {
    findings.unshift(
      logoFinding(
        "pass",
        `The logo is an SVG Tiny PS document (${Buffer.byteLength(fetched.body)} bytes)`,
      ),
    );
    return { fetch: fetched.kind, outcome: "pass", findings };
  }
  return {
    fetch: fetched.kind,
    outcome: "fail",
    findings: [...problems.map((problem) => logoFinding("fail", problem)), ...findings],
  };
}
