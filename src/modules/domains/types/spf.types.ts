/**
 * Types of the built-in SPF evaluator (#373, RFC 7208 strict mode).
 */

/** The result of `check_host()` (RFC 7208 2.6). */
export type SpfResult =
  "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";

/**
 * The DNS queries SPF evaluation makes, in the shape of `dns/promises`.
 * Injectable for tests. A lookup that finds nothing rejects with an
 * `ENOTFOUND` or `ENODATA` error (Bun reports both NXDOMAIN and "no
 * records of this type" as `ENOTFOUND`); any other rejection is a failed
 * lookup.
 */
export interface SpfDnsResolver {
  resolveTxt: (name: string) => Promise<string[][]>;
  resolve4: (name: string) => Promise<string[]>;
  resolve6: (name: string) => Promise<string[]>;
  resolveMx: (name: string) => Promise<Array<{ exchange: string; priority: number }>>;
  /** PTR records of a reverse name (`4.3.2.1.in-addr.arpa`). */
  resolvePtr: (name: string) => Promise<string[]>;
}

/** The arguments of `check_host()` (RFC 7208 4.1). */
export interface SpfCheckInput {
  /** The client's IP address, IPv4 or IPv6 (an IPv4-mapped IPv6 address counts as IPv4). */
  ip: string;
  /** The domain whose SPF record is evaluated. */
  domain: string;
  /** The MAIL FROM address; without a local-part, `postmaster` is used. */
  sender: string;
  /** The HELO/EHLO name, for the `%{h}` macro. */
  helo: string;
}

/** How an evaluation runs. */
export interface SpfCheckOptions {
  /** DNS queries (default: `dns/promises`). */
  resolver?: SpfDnsResolver;
  /** Overall time budget in ms (default 10 000); past it the result is `temperror`. */
  timeoutMs?: number;
}

/** The result and why, for logs and tests. */
export interface SpfCheckResult {
  result: SpfResult;
  reason: string;
}
