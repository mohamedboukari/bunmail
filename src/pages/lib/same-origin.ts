import { config } from "../../config.ts";

/**
 * CSRF origin check for state-mutating dashboard requests (#133, #420).
 *
 * `SameSite=Lax` already blocks cross-site cookie-bearing POSTs in modern
 * browsers, but it's the *only* current defense and older/edge cases slip
 * through. As a second layer we verify that a POST's `Origin` (falling back
 * to `Referer` only when `Origin` is absent) names this server. A
 * cross-site form-POST carries the attacker's Origin and is rejected;
 * same-origin dashboard forms always send a matching Origin. A POST with
 * neither header present is rejected (browsers send Origin on POST; its
 * absence is anomalous).
 *
 * What "this server" means depends on `APP_BASE_URL` (#420):
 *
 * - **Set to a usable `http(s)://` URL**: the full origin (scheme, host and
 *   port, as `new URL(x).origin` serializes it, so `https://x` and
 *   `https://x:443` are the same) must equal the `APP_BASE_URL` origin.
 *   The request URL and `Host` header do not make an origin acceptable
 *   (outside the loopback exception below): behind a reverse
 *   proxy the container sees `http://127.0.0.1:3000` while the browser is
 *   on `https://mail.example.com`, and only the configured public URL
 *   knows the real scheme. This refuses `Origin: http://mail.example.com`
 *   on an `https://` deployment (a page a network attacker serves over
 *   plain HTTP before HSTS is stored) and any other port on the host.
 *   One narrow exception keeps the SSH-tunnel break-glass working
 *   (`ssh -L 3000:127.0.0.1:3000`, then `http://localhost:3000`): a
 *   loopback origin is also accepted when it is exactly the origin this
 *   process was reached at (see {@link isLoopbackSelf}).
 * - **Unset, or not an `http(s)://` URL** (local and dev setups; the same
 *   "no usable APP_BASE_URL" case the invite and setup links fall back
 *   on): the host (name and port, no scheme) must match the request's own
 *   host, as before #420.
 *
 * Fails closed: an `Origin: null` (opaque origin), a malformed header, or
 * a header whose origin is opaque is refused, and a present `Origin` is
 * never overridden by a `Referer`.
 *
 * @param request The incoming request.
 * @param appBaseUrl The configured public base URL; read from `config` on
 *   every call by default (tests change it at runtime).
 * @returns true if the request is same-origin (allowed)
 */
export function isSameOrigin(
  request: Request,
  appBaseUrl: string = config.appBaseUrl,
): boolean {
  /**
   * The header that names where the request came from. `Origin` wins
   * whenever it is present, even as the literal `null` (which then fails
   * to parse and is refused): a `Referer` is only a fallback for clients
   * that omit `Origin`, never a way around a bad one.
   */
  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return false;

  /** The configured public origin, when `APP_BASE_URL` gives one. */
  const expected = appBaseOrigin(appBaseUrl);
  if (expected === null) return hostMatchesRequest(request, source);

  /** The origin the header names; null when malformed or opaque. */
  const actual = originOf(source);
  if (actual === null) return false;
  return actual === expected || isLoopbackSelf(request, actual);
}

/**
 * What the same-origin check compares with, for the refusal logs: the
 * `APP_BASE_URL` origin, or `"request host"` without a usable one. An
 * origin only, never a path or a secret.
 *
 * @param appBaseUrl The configured public base URL; `config` by default.
 * @returns The expected origin, or `"request host"`.
 */
export function expectedOriginLabel(appBaseUrl: string = config.appBaseUrl): string {
  return appBaseOrigin(appBaseUrl) ?? "request host";
}

/**
 * The origin (scheme, host, port) of `APP_BASE_URL` when it is a usable
 * `http(s)://` URL, else null (then the legacy host comparison applies).
 * Boot uses it too, to warn once about a set but unusable value.
 *
 * @param appBaseUrl The configured public base URL, possibly empty.
 * @returns The serialized origin, e.g. `https://mail.example.com`, or null.
 */
export function appBaseOrigin(appBaseUrl: string): string | null {
  if (appBaseUrl.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

/**
 * The serialized origin of an `Origin` or `Referer` header value, or null
 * when it does not parse or names an opaque origin (`null`, `data:`,
 * `file:` and the like serialize as the string `"null"`), so it can never
 * equal a real origin.
 *
 * @param value The raw header value.
 * @returns The origin, e.g. `https://mail.example.com:8443`, or null.
 */
function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Headers a proxy adds and a browser cannot: their presence rules out a tunnel. */
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host"] as const;

/**
 * The SSH-tunnel exception (#420): true when `origin` is a loopback origin
 * AND exactly the origin this process was reached at, i.e. the request URL's
 * scheme (always `http:` inside the container) with the `Host` header the
 * browser sent (through `ssh -L 3000:127.0.0.1:3000` that is
 * `localhost:3000`). Both must hold:
 *
 * - A hostile site cannot make a browser send a loopback `Origin` (the
 *   browser sends the origin of the page that posts), so CSRF protection is
 *   unchanged: only a page served from loopback can pass.
 * - A request through the reverse proxy carries the public `Host`
 *   (`mail.example.com`), so `Origin: http://localhost` never equals the
 *   request's origin there and is refused; an `Origin: https://evil` is not
 *   loopback at all.
 *
 * - A request that came through any proxy (it carries `Forwarded`,
 *   `X-Forwarded-For` or `X-Forwarded-Host`, which a browser form or
 *   `fetch` can never set) never takes this path, so a proxy that forwards
 *   with an internal `Host` (nginx's default `127.0.0.1:3000`) does not
 *   open it to a page served from the operator's own loopback either. A
 *   tunnel reaches the process directly and adds none of them.
 *
 * Without a `Host` header the request URL's host stands in (an HTTP/1.1
 * browser always sends one).
 *
 * @param request The incoming request.
 * @param origin The serialized origin of the `Origin` or `Referer` header.
 * @returns true when the browser is talking to this process over loopback.
 */
function isLoopbackSelf(request: Request, origin: string): boolean {
  let requestUrl: URL;
  let candidate: URL;
  try {
    requestUrl = new URL(request.url);
    candidate = new URL(origin);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(candidate.hostname)) return false;
  for (const header of FORWARDING_HEADERS) {
    if (request.headers.has(header)) return false;
  }

  /** The origin the browser addressed: request scheme plus its `Host`. */
  const host = request.headers.get("host") ?? requestUrl.host;
  return originOf(`${requestUrl.protocol}//${host}`) === origin;
}

/**
 * A loopback host as the URL parser serializes it: `localhost`, an IPv4
 * address in `127.0.0.0/8` (the parser already turned shorthand such as
 * `127.1` into dotted quads), or `[::1]`. Nothing else, not even a
 * `*.localhost` name.
 *
 * @param hostname `URL.hostname` of a parsed origin.
 * @returns true for a loopback name or literal.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The comparison used without a usable `APP_BASE_URL` (as before #420):
 * the host (name and port) of `source` must match the request's own host.
 *
 * The target host is taken from the request URL (always present) and
 * cross-checked against the `Host` header when it exists: behind a proxy
 * the URL host may be the internal bind address while `Host` carries the
 * public name, so a match on *either* is same-origin.
 *
 * @param request The incoming request.
 * @param source The `Origin` or `Referer` header value.
 * @returns true when the hosts match.
 */
function hostMatchesRequest(request: Request, source: string): boolean {
  const targets = new Set<string>();
  try {
    targets.add(new URL(request.url).host);
  } catch {
    /** malformed request URL: fall through to Host header only */
  }
  const hostHeader = request.headers.get("host");
  if (hostHeader) targets.add(hostHeader);
  if (targets.size === 0) return false;

  try {
    return targets.has(new URL(source).host);
  } catch {
    return false;
  }
}
