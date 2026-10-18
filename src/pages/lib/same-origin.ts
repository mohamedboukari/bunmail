/**
 * CSRF origin check for state-mutating dashboard requests (#133).
 *
 * `SameSite=Lax` already blocks cross-site cookie-bearing POSTs in modern
 * browsers, but it's the *only* current defense and older/edge cases slip
 * through. As a second layer we verify that a POST's `Origin` (falling back
 * to `Referer`) host matches the request's own host. A cross-site form-POST
 * carries the attacker's Origin and is rejected; same-origin dashboard
 * forms always send a matching Origin. A POST with neither header present
 * is rejected (browsers send Origin on POST; its absence is anomalous).
 *
 * @returns true if the request is same-origin (allowed)
 */
export function isSameOrigin(request: Request): boolean {
  /**
   * The target host is taken from the request URL (always present) and
   * cross-checked against the `Host` header when it exists: behind a proxy
   * the URL host may be the internal bind address while `Host` carries the
   * public name, so a match on *either* is same-origin.
   */
  const targets = new Set<string>();
  try {
    targets.add(new URL(request.url).host);
  } catch {
    /** malformed request URL: fall through to Host header only */
  }
  const hostHeader = request.headers.get("host");
  if (hostHeader) targets.add(hostHeader);
  if (targets.size === 0) return false;

  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return false;

  try {
    return targets.has(new URL(source).host);
  } catch {
    return false;
  }
}
