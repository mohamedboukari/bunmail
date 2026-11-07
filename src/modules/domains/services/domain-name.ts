import { domainToASCII } from "url";
import { asciiLowerCase, isLowerAsciiDomain } from "../../../config/sso.ts";

/**
 * The name of a domain (#406): how a submitted name is normalised and which
 * names may be registered. No database: `domain.service.ts` (create and the
 * name lookups) and the boot check of stored names share these.
 */

/** Any character outside ASCII: the name is an IDN in Unicode form. */
const NON_ASCII = /[\u0080-\uffff]/;

/**
 * No ASCII space or control character: the URL host parser behind
 * `domainToASCII` may drop a tab or a newline instead of refusing it.
 */
const NO_ASCII_CONTROL = /^[!-~\u0080-\uffff]*$/;

/** A top label of digits only: the name is an IPv4 address, not a domain (RFC 3696 2). */
const NUMERIC_LABEL = /^[0-9]+$/;

/**
 * A submitted domain name in its stored form, without judging it: trimmed,
 * a Unicode IDN converted to its A-label (`bücher.example` becomes
 * `xn--bcher-kva.example`), ASCII letters lowercased (only those: see
 * `asciiLowerCase`), and one final dot dropped, as `example.com.` names the
 * same domain. A Unicode name that does not convert (it holds a space, a
 * `:` or a `/`) is kept as is, for {@link parseDomainName} to refuse.
 */
export function normalizeDomainName(input: string): string {
  const trimmed = input.trim();
  /**
   * Only a Unicode name goes through `domainToASCII`: it parses a URL host,
   * so it also turns `0x7f.1` into `127.0.0.1`. An ASCII name is kept as
   * typed, and the result is checked either way. A Unicode name with an
   * ASCII space or control character is not converted, so it is refused.
   */
  const convert = NON_ASCII.test(trimmed) && NO_ASCII_CONTROL.test(trimmed);
  const ascii = convert ? domainToASCII(trimmed) || trimmed : trimmed;
  const lower = asciiLowerCase(ascii);
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * The stored form of a submitted domain name, or `null` when it is not a
 * domain that can be registered: after {@link normalizeDomainName}, a host
 * name of at least two labels of 1 to 63 letters, digits or inner hyphens,
 * 253 characters at most, whose top label is not all digits. A URL, a port,
 * a space, an empty label (`example..com`, `example.com..`), a single label
 * (`localhost`) and an IP address are all refused.
 */
export function parseDomainName(input: string): string | null {
  const name = normalizeDomainName(input);
  if (!isLowerAsciiDomain(name)) return null;
  const topLabel = name.slice(name.lastIndexOf(".") + 1);
  return NUMERIC_LABEL.test(topLabel) ? null : name;
}
