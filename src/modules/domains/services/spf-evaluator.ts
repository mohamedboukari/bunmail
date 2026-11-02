import { resolve4, resolve6, resolveMx, resolvePtr, resolveTxt } from "dns/promises";
import type {
  SpfCheckInput,
  SpfCheckOptions,
  SpfCheckResult,
  SpfDnsResolver,
  SpfResult,
} from "../types/spf.types.ts";
import {
  clientAddress,
  inNetwork,
  parseIp,
  reverseName,
  type IpAddress,
} from "./spf-address.ts";
import {
  SpfError,
  expandMacros,
  isSpfRecord,
  isValidDomainName,
  parseSpfRecord,
  targetName,
  type MacroToken,
  type Qualifier,
  type SpfMechanism,
} from "./spf-syntax.ts";

/**
 * SPF evaluation (#373): `check_host()` of RFC 7208 in strict mode, for one
 * domain and one IP. Replaces mailauth's `spf()`.
 *
 * - Mechanisms `all`, `include`, `a`, `mx`, `ptr`, `ip4`, `ip6`, `exists`
 *   (dual CIDR on `a` and `mx`), the `redirect` modifier; `exp` is checked
 *   for syntax but never evaluated. Macros per `spf-syntax.ts`.
 * - Exactly one `v=spf1` TXT record: none is `none`, two or more are a
 *   `permerror`. Any syntax error in the record is a `permerror`.
 * - Limits (RFC 7208 4.6.4): at most 10 terms that query DNS (`include`,
 *   `a`, `mx`, `ptr`, `exists`, `redirect`, plus the PTR lookup of each
 *   `%{p}`), counted as they are evaluated, across includes and
 *   redirects; an `mx` answer of more than 10 names is a `permerror`, a
 *   `ptr` answer is cut to its first 10 names; more than 2 void lookups
 *   is a `permerror`. The whole evaluation has a deadline (10 s by
 *   default), past which the result is `temperror`.
 * - DNS errors: `ENOTFOUND` and `ENODATA` are an empty answer (Bun reports
 *   both NXDOMAIN and no data as `ENOTFOUND`); anything else (`ETIMEOUT`,
 *   `ESERVFAIL`, `ECONNREFUSED`, ...) is a `temperror`, except in the
 *   `ptr` lookups, where RFC 7208 5.5 makes it a non-match.
 */

const defaultResolver: SpfDnsResolver = {
  resolveTxt,
  resolve4,
  resolve6,
  resolveMx,
  resolvePtr,
};

/** Overall time budget of one evaluation (RFC 7208 4.6.4 asks for a limit). */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Terms that query DNS, per evaluation (RFC 7208 4.6.4). */
const MAX_DNS_TERMS = 10;
/** Lookups that find nothing, per evaluation (RFC 7208 4.6.4). */
const MAX_VOID_LOOKUPS = 2;
/** Names of one MX or PTR answer that are looked up (RFC 7208 4.6.4). */
const MAX_NAMES_PER_ANSWER = 10;

/** DNS answers meaning "nothing there" (a void lookup), as opposed to a failed lookup. */
const VOID_CODES = new Set(["ENOTFOUND", "ENODATA"]);

const QUALIFIER_RESULTS: Readonly<Record<Qualifier, SpfResult>> = {
  "+": "pass",
  "-": "fail",
  "~": "softfail",
  "?": "neutral",
};

/** The state of one `checkHost` call, shared by its includes and redirects. */
interface Evaluation {
  resolver: SpfDnsResolver;
  ip: IpAddress;
  sender: string;
  localPart: string;
  senderDomain: string;
  helo: string;
  /** DNS-querying terms so far. */
  lookups: number;
  /** Void lookups so far. */
  voids: number;
  /** Rejects with a `temperror` at the deadline. */
  deadline: Promise<never>;
  expired: { value: boolean };
}

/** One DNS answer: records, nothing (void), or a failed lookup. */
type Answer<T> =
  { status: "ok"; records: T[] } | { status: "void" } | { status: "error"; code: string };

/** The `code` of a DNS error, or an empty string. */
function dnsCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : "";
}

/** The deadline error. */
function deadlineError(): SpfError {
  return new SpfError("temperror", "SPF evaluation time limit exceeded");
}

/**
 * Runs one DNS query against the deadline. Never rejects for a DNS error
 * (the caller decides what it means); rejects with a `temperror` once the
 * deadline has passed.
 */
async function query<T>(ev: Evaluation, lookup: () => Promise<T[]>): Promise<Answer<T>> {
  if (ev.expired.value) throw deadlineError();
  try {
    const records = await Promise.race([lookup(), ev.deadline]);
    return records.length > 0 ? { status: "ok", records } : { status: "void" };
  } catch (error: unknown) {
    if (error instanceof SpfError) throw error;
    const code = dnsCode(error);
    return VOID_CODES.has(code)
      ? { status: "void" }
      : { status: "error", code: code || "unknown error" };
  }
}

/** Counts one DNS-querying term: past 10 is a `permerror`. */
function countLookup(ev: Evaluation, what: string): void {
  ev.lookups++;
  if (ev.lookups > MAX_DNS_TERMS) {
    throw new SpfError(
      "permerror",
      `more than ${MAX_DNS_TERMS} DNS lookups (at ${what})`,
    );
  }
}

/** Counts one void lookup: past 2 is a `permerror`. */
function countVoid(ev: Evaluation, name: string): void {
  ev.voids++;
  if (ev.voids > MAX_VOID_LOOKUPS) {
    throw new SpfError(
      "permerror",
      `more than ${MAX_VOID_LOOKUPS} void DNS lookups (at ${name})`,
    );
  }
}

/**
 * The records of a counted term's query: a void answer counts toward the
 * void limit and gives none, a failed lookup is a `temperror`.
 */
function recordsOf<T>(ev: Evaluation, answer: Answer<T>, name: string): T[] {
  if (answer.status === "ok") return answer.records;
  if (answer.status === "error") {
    throw new SpfError("temperror", `DNS lookup of ${name} failed (${answer.code})`);
  }
  countVoid(ev, name);
  return [];
}

/** A name without its trailing dot, lowercased for comparison. */
function canonicalName(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

/** The A (IPv4 client) or AAAA (IPv6 client) records of `name`. */
function addressQuery(ev: Evaluation, name: string): Promise<Answer<string>> {
  return query(ev, () =>
    ev.ip.family === 4 ? ev.resolver.resolve4(name) : ev.resolver.resolve6(name),
  );
}

/** Whether one of `addresses` puts the client in its `/prefix` network. */
function matchesAddress(ev: Evaluation, addresses: string[], prefix: number): boolean {
  return addresses.some((text) => {
    const network = parseIp(text);
    return network !== null && inNetwork(ev.ip, network, prefix);
  });
}

/**
 * The validated names of the client IP (RFC 7208 5.5): the first 10 PTR
 * names whose A or AAAA records include the IP. A failed PTR lookup gives
 * none; a failed or empty address lookup skips that name. The PTR query
 * itself counts toward the void limit, the address lookups do not.
 */
async function validatedNames(ev: Evaluation): Promise<string[]> {
  const reverse = reverseName(ev.ip);
  const answer = await query(ev, () => ev.resolver.resolvePtr(reverse));
  if (answer.status === "error") return [];
  if (answer.status === "void") {
    countVoid(ev, reverse);
    return [];
  }
  const names = answer.records
    .slice(0, MAX_NAMES_PER_ANSWER)
    .map(canonicalName)
    .filter((name) => name !== "");
  const prefix = ev.ip.family === 4 ? 32 : 128;
  const valid = await Promise.all(
    names.map(async (name) => {
      const addresses = await addressQuery(ev, name);
      return addresses.status === "ok" && matchesAddress(ev, addresses.records, prefix);
    }),
  );
  return names.filter((_, index) => valid[index]);
}

/**
 * The `%{p}` value (RFC 7208 7.3): `<domain>` itself if validated, else a
 * validated subdomain of it, else any validated name, else `unknown`. Its
 * PTR lookup counts as a DNS-querying term.
 */
async function ptrMacroValue(ev: Evaluation, domain: string): Promise<string> {
  countLookup(ev, "%{p}");
  const names = await validatedNames(ev);
  const target = canonicalName(domain);
  return (
    names.find((name) => name === target) ??
    names.find((name) => name.endsWith(`.${target}`)) ??
    names[0] ??
    "unknown"
  );
}

/**
 * Expands a domain-spec into the name to query, `null` when the result is
 * not a valid domain name (the caller decides what that means).
 */
async function expandTarget(
  ev: Evaluation,
  tokens: MacroToken[],
  domain: string,
): Promise<string | null> {
  const usesPtr = tokens.some((token) => token.kind === "macro" && token.letter === "p");
  const ptrName = usesPtr ? await ptrMacroValue(ev, domain) : undefined;
  const expanded = expandMacros(tokens, {
    sender: ev.sender,
    localPart: ev.localPart,
    senderDomain: ev.senderDomain,
    domain,
    ip: ev.ip,
    helo: ev.helo,
    ptrName,
  });
  return targetName(expanded);
}

/**
 * The target of `a`, `mx`, `ptr` or `exists`: the current domain without a
 * domain-spec. An expansion that is not a valid name makes the mechanism
 * not match (`null`), like a name that does not exist (RFC 7208 4.3).
 */
function mechanismTarget(
  ev: Evaluation,
  domainSpec: MacroToken[] | null,
  domain: string,
): Promise<string | null> {
  return domainSpec ? expandTarget(ev, domainSpec, domain) : Promise.resolve(domain);
}

/** `mx` (RFC 7208 5.4): an address of one of the MX hosts, in priority order. */
async function matchesMx(
  ev: Evaluation,
  target: string,
  prefix: number,
): Promise<boolean> {
  const answer = await query(ev, () => ev.resolver.resolveMx(target));
  const hosts = recordsOf(ev, answer, target)
    .toSorted((left, right) => left.priority - right.priority)
    .map((mx) => mx.exchange.replace(/\.$/, ""))
    /** A null MX (`.`, RFC 7505) names no host. */
    .filter((host) => host !== "");
  if (hosts.length > MAX_NAMES_PER_ANSWER) {
    throw new SpfError(
      "permerror",
      `${target} has more than ${MAX_NAMES_PER_ANSWER} MX records`,
    );
  }
  for (const host of hosts) {
    const addresses = await addressQuery(ev, host);
    if (addresses.status === "error") {
      throw new SpfError("temperror", `DNS lookup of ${host} failed (${addresses.code})`);
    }
    if (addresses.status === "ok" && matchesAddress(ev, addresses.records, prefix)) {
      return true;
    }
  }
  return false;
}

/** Whether a mechanism matches the client (RFC 7208 5). */
async function matches(
  ev: Evaluation,
  mechanism: SpfMechanism,
  domain: string,
): Promise<boolean> {
  switch (mechanism.kind) {
    case "all":
      return true;

    case "ip4":
    case "ip6":
      return inNetwork(ev.ip, mechanism.network, mechanism.prefix);

    case "a":
    case "mx": {
      countLookup(ev, mechanism.term);
      const target = await mechanismTarget(ev, mechanism.domainSpec, domain);
      if (target === null) return false;
      const prefix = ev.ip.family === 4 ? mechanism.cidr4 : mechanism.cidr6;
      if (mechanism.kind === "mx") return matchesMx(ev, target, prefix);
      return matchesAddress(
        ev,
        recordsOf(ev, await addressQuery(ev, target), target),
        prefix,
      );
    }

    case "ptr": {
      countLookup(ev, mechanism.term);
      const target = await mechanismTarget(ev, mechanism.domainSpec, domain);
      if (target === null) return false;
      const wanted = canonicalName(target);
      const names = await validatedNames(ev);
      return names.some((name) => name === wanted || name.endsWith(`.${wanted}`));
    }

    case "exists": {
      countLookup(ev, mechanism.term);
      const target = await expandTarget(ev, mechanism.domainSpec, domain);
      if (target === null) return false;
      /** Always an A query, whatever the client's family (RFC 7208 5.7). */
      const answer = await query(ev, () => ev.resolver.resolve4(target));
      return recordsOf(ev, answer, target).length > 0;
    }

    case "include": {
      countLookup(ev, mechanism.term);
      const target = await expandTarget(ev, mechanism.domainSpec, domain);
      if (target === null) {
        throw new SpfError("permerror", `${mechanism.term}: not a valid domain name`);
      }
      /** RFC 7208 5.2: pass matches; fail, softfail, neutral do not; none is a permerror. */
      const inner = await checkDomain(ev, target);
      switch (inner.result) {
        case "pass":
          return true;
        case "fail":
        case "softfail":
        case "neutral":
          return false;
        case "none":
          throw new SpfError("permerror", `${mechanism.term}: ${inner.reason}`);
        default:
          throw new SpfError(inner.result, inner.reason);
      }
    }
  }
}

/** `check_host()` of one domain, recursing for include and redirect. */
async function checkDomain(ev: Evaluation, domain: string): Promise<SpfCheckResult> {
  try {
    const answer = await query(ev, () => ev.resolver.resolveTxt(domain));
    if (answer.status === "error") {
      return {
        result: "temperror",
        reason: `TXT lookup of ${domain} failed (${answer.code})`,
      };
    }
    const records =
      answer.status === "ok"
        ? answer.records.map((chunks) => chunks.join("")).filter(isSpfRecord)
        : [];
    const [text] = records;
    if (text === undefined) {
      return { result: "none", reason: `no SPF record at ${domain}` };
    }
    if (records.length > 1) {
      return { result: "permerror", reason: `more than one SPF record at ${domain}` };
    }

    const record = parseSpfRecord(text);
    for (const mechanism of record.mechanisms) {
      if (await matches(ev, mechanism, domain)) {
        return {
          result: QUALIFIER_RESULTS[mechanism.qualifier],
          reason: `${mechanism.term} matched at ${domain}`,
        };
      }
    }

    if (record.redirect) {
      countLookup(ev, "redirect");
      const target = await expandTarget(ev, record.redirect, domain);
      if (target === null) {
        return { result: "permerror", reason: "redirect: not a valid domain name" };
      }
      /** RFC 7208 6.1: the target's result, with none as a permerror. */
      const inner = await checkDomain(ev, target);
      return inner.result === "none"
        ? { result: "permerror", reason: `redirect=${target}: ${inner.reason}` }
        : inner;
    }
    return { result: "neutral", reason: `no mechanism matched at ${domain}` };
  } catch (error: unknown) {
    if (error instanceof SpfError) return { result: error.result, reason: error.message };
    throw error;
  }
}

/**
 * Evaluates the SPF record of `input.domain` for mail from `input.ip`
 * (RFC 7208 `check_host()`, strict). A domain that is not a valid
 * multi-label name is `none` (RFC 7208 4.3), an invalid IP a `temperror`.
 * Never rejects for DNS errors: they become results.
 */
export async function checkHost(
  input: SpfCheckInput,
  options: SpfCheckOptions = {},
): Promise<SpfCheckResult> {
  const ip = clientAddress(input.ip);
  if (!ip) return { result: "temperror", reason: "invalid client IP address" };
  const domain = input.domain.replace(/\.$/, "");
  if (!isValidDomainName(domain)) {
    return { result: "none", reason: "the domain is not a valid domain name" };
  }

  /** RFC 7208 4.3: a sender without a local-part gets `postmaster`. */
  const at = input.sender.lastIndexOf("@");
  const localPart = (at >= 0 ? input.sender.slice(0, at) : "") || "postmaster";
  const senderDomain = at >= 0 ? input.sender.slice(at + 1) : input.sender;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expired = { value: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired.value = true;
      reject(deadlineError());
    }, timeoutMs);
  });
  /** Raced by every query; a deadline nobody is waiting on must not go unhandled. */
  void deadline.catch(() => undefined);

  const ev: Evaluation = {
    resolver: options.resolver ?? defaultResolver,
    ip,
    sender: `${localPart}@${senderDomain}`,
    localPart,
    senderDomain,
    helo: input.helo,
    lookups: 0,
    voids: 0,
    deadline,
    expired,
  };
  try {
    return await checkDomain(ev, domain);
  } finally {
    clearTimeout(timer);
  }
}
