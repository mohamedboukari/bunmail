import * as oauth from "oauth4webapi";
import { isLoopbackHost, type SsoProviderSettings } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * OpenID Connect discovery for SSO (#224), and the HTTP rules every call
 * to a provider follows.
 *
 * A provider's metadata (`<issuer>/.well-known/openid-configuration`) is
 * fetched on first use and kept for {@link SSO_DISCOVERY_TTL_MS}; a failure
 * is logged and retried on the next use, never fatal at boot.
 *
 * Every request to a provider (discovery, code exchange, JWKS) goes
 * through {@link ssoHttpOptions}: a {@link SSO_HTTP_TIMEOUT_MS} timeout, a
 * {@link SSO_HTTP_MAX_BYTES} body cap, and no redirects (a 3xx answer is
 * returned as is, and `oauth4webapi` refuses it). HTTPS is required by
 * `oauth4webapi` itself, except for a loopback `http://` issuer, which the
 * config allows for development.
 *
 * The SSRF guard (`src/utils/ssrf-guard.ts`) is deliberately not applied:
 * the issuer is chosen by the operator, not by a user, and is often on a
 * private network (Keycloak or Authentik on a LAN). THREAT_MODEL.md says so.
 */

/** Timeout of one request to a provider, in milliseconds. */
export const SSO_HTTP_TIMEOUT_MS = 5000;

/** Largest response body read from a provider, in bytes (64 KiB). */
export const SSO_HTTP_MAX_BYTES = 64 * 1024;

/** How long discovered metadata is reused, in milliseconds (1 hour). */
export const SSO_DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Why a request to a provider failed before `oauth4webapi` saw an answer. */
type SsoHttpFailure = "timeout" | "too_large" | "network";

/** A request to a provider that timed out, was too large or did not connect. */
export class SsoHttpError extends Error {
  readonly kind: SsoHttpFailure;

  constructor(kind: SsoHttpFailure) {
    super(`SSO provider request failed (${kind})`);
    this.name = "SsoHttpError";
    this.kind = kind;
  }
}

/** The request options `oauth4webapi` hands its fetch, for GET and POST alike. */
interface ProviderRequest {
  method: string;
  headers: Record<string, string>;
  body?: URLSearchParams | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Reads at most `max` bytes of a body, or throws `too_large`. The
 * declared length is checked first, so an honest oversized answer is
 * refused without reading it.
 */
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new SsoHttpError("too_large");
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new SsoHttpError("too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/**
 * The fetch `oauth4webapi` uses for every provider request: no redirects,
 * a timeout over the whole exchange (headers and body), and a capped body,
 * handed back as a fresh `Response`. Failures become {@link SsoHttpError}
 * whose message carries no URL, header or body.
 */
function makeCappedFetch(timeoutMs: number): ProviderFetch {
  return async (url, options) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: "manual",
        signal,
      });
      const body = await readCapped(response, SSO_HTTP_MAX_BYTES);
      return new Response(response.status === 204 ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error: unknown) {
      if (error instanceof SsoHttpError) throw error;
      throw new SsoHttpError(timeout.aborted ? "timeout" : "network");
    }
  };
}

/** The fetch `oauth4webapi` is handed: see {@link makeCappedFetch}. */
type ProviderFetch = (url: string, options: ProviderRequest) => Promise<Response>;

/**
 * One capped fetch per timeout, reused by every call. `oauth4webapi`
 * shares a JWKS download between concurrent callers only when they pass
 * the same fetch function, so a fresh closure per call would let a burst
 * of callbacks on a cold JWKS cache each download it.
 */
const cappedFetches = new Map<number, ProviderFetch>();

/** The capped fetch for `timeoutMs`, created once. */
function cappedFetch(timeoutMs: number): ProviderFetch {
  let fetcher = cappedFetches.get(timeoutMs);
  if (fetcher === undefined) {
    fetcher = makeCappedFetch(timeoutMs);
    cappedFetches.set(timeoutMs, fetcher);
  }
  return fetcher;
}

/** Per-call knobs; production uses the defaults. */
export interface SsoHttpSettings {
  /** Request timeout in milliseconds (tests shorten it). */
  timeoutMs?: number;
}

/**
 * The transport options of every `oauth4webapi` call to `provider`: the
 * capped fetch, and plain HTTP allowed only for an `http://` issuer, which
 * the config accepts on a loopback host only.
 */
export function ssoHttpOptions(
  provider: SsoProviderSettings,
  settings: SsoHttpSettings = {},
): {
  [oauth.customFetch]: ProviderFetch;
  [oauth.allowInsecureRequests]: boolean;
} {
  return {
    [oauth.customFetch]: cappedFetch(settings.timeoutMs ?? SSO_HTTP_TIMEOUT_MS),
    [oauth.allowInsecureRequests]: new URL(provider.issuer).protocol === "http:",
  };
}

/** Why discovery failed, for the log line: never a URL, a header or a body. */
type DiscoveryFailure =
  | SsoHttpFailure
  | "bad_response"
  | "issuer_mismatch"
  | "missing_endpoint"
  | "insecure_endpoint"
  | "pkce_unsupported";

/** A discovery that did not produce usable metadata. */
class SsoDiscoveryError extends Error {
  readonly failure: DiscoveryFailure;

  constructor(failure: DiscoveryFailure) {
    super(`SSO discovery failed (${failure})`);
    this.name = "SsoDiscoveryError";
    this.failure = failure;
  }
}

/** The endpoints a sign-in needs, each checked by {@link checkMetadata}. */
const REQUIRED_ENDPOINTS = [
  "authorization_endpoint",
  "token_endpoint",
  "jwks_uri",
] as const;

/**
 * Checks what `oauth4webapi` leaves to the caller:
 *
 * - The document's `issuer` equals the configured issuer exactly.
 *   `processDiscoveryResponse` compares them as parsed URLs, which lets
 *   `https://idp` match `https://idp/`; the ID token's `iss` is then
 *   compared with the document's value, so both must be the same string.
 * - The authorization, token and JWKS endpoints are present and
 *   `https:`. Plain `http:` is accepted only when the issuer itself is a
 *   loopback `http://` URL (development) and the endpoint is on a loopback
 *   host too: the client secret never crosses a network in clear.
 * - When the provider lists its PKCE methods, `S256` is among them.
 */
function checkMetadata(
  provider: SsoProviderSettings,
  as: oauth.AuthorizationServer,
): void {
  if (as.issuer !== provider.issuer) throw new SsoDiscoveryError("issuer_mismatch");
  const allowHttp = new URL(provider.issuer).protocol === "http:";
  for (const name of REQUIRED_ENDPOINTS) {
    const value = as[name];
    if (typeof value !== "string" || value === "") {
      throw new SsoDiscoveryError("missing_endpoint");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SsoDiscoveryError("missing_endpoint");
    }
    const loopbackHttp =
      allowHttp && url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !loopbackHttp) {
      throw new SsoDiscoveryError("insecure_endpoint");
    }
  }
  const methods = as.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new SsoDiscoveryError("pkce_unsupported");
  }
}

/** Fetches and checks one provider's metadata, or throws {@link SsoDiscoveryError}. */
async function discover(
  provider: SsoProviderSettings,
  settings: SsoHttpSettings,
): Promise<oauth.AuthorizationServer> {
  const issuer = new URL(provider.issuer);
  let as: oauth.AuthorizationServer;
  try {
    const response = await oauth.discoveryRequest(
      issuer,
      ssoHttpOptions(provider, settings),
    );
    as = await oauth.processDiscoveryResponse(issuer, response);
  } catch (error: unknown) {
    if (error instanceof SsoHttpError) throw new SsoDiscoveryError(error.kind);
    if (
      error instanceof oauth.OperationProcessingError &&
      error.code === oauth.JSON_ATTRIBUTE_COMPARISON
    ) {
      throw new SsoDiscoveryError("issuer_mismatch");
    }
    throw new SsoDiscoveryError("bad_response");
  }
  checkMetadata(provider, as);
  return as;
}

/** A discovery result, or the discovery in flight, per provider. */
interface CacheEntry {
  metadata: Promise<oauth.AuthorizationServer>;
  /** Epoch ms after which the metadata is fetched again. */
  expiresAt: number;
}

/**
 * Metadata by provider id and issuer. The same object is handed out for
 * the whole hour, which also lets `oauth4webapi` reuse its JWKS cache (it
 * keys that cache by this object).
 */
const cache = new Map<string, CacheEntry>();

/** Empties the metadata cache (tests). */
export function clearSsoDiscoveryCache(): void {
  cache.clear();
}

/**
 * The provider's checked metadata, from the cache or a fresh discovery;
 * `null` when discovery fails, which is logged at `warn` with the provider
 * id and a short reason. Concurrent callers share one request, and a
 * failure is not cached, so the next sign-in tries again.
 */
export async function getSsoProviderMetadata(
  provider: SsoProviderSettings,
  settings: SsoHttpSettings & { now?: number } = {},
): Promise<oauth.AuthorizationServer | null> {
  const key = `${provider.id}\n${provider.issuer}`;
  const now = settings.now ?? Date.now();
  let entry = cache.get(key);
  if (!entry || entry.expiresAt <= now) {
    entry = {
      metadata: discover(provider, settings),
      expiresAt: now + SSO_DISCOVERY_TTL_MS,
    };
    cache.set(key, entry);
  }
  const pending = entry;
  try {
    return await pending.metadata;
  } catch (error: unknown) {
    if (cache.get(key) === pending) cache.delete(key);
    logger.warn("SSO discovery failed", {
      provider: provider.id,
      reason: error instanceof SsoDiscoveryError ? error.failure : "unexpected",
    });
    return null;
  }
}
