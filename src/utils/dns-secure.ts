import { randomInt } from "crypto";
import {
  dottedName,
  parseDnsResponse,
  type DnsRecord,
  type DnsResponseOutcome,
} from "./dns-rdata.ts";
import {
  exchangeTcp,
  exchangeUdp,
  type DnsServer,
  type Exchange,
  type ReplyCheck,
} from "./dns-transport.ts";
import {
  TYPE_A,
  TYPE_AAAA,
  TYPE_CNAME,
  TYPE_MX,
  TYPE_TLSA,
  encodeQuery,
  nameLabels,
  type DnsQuestion,
  type DnsTxtErrorCode,
} from "./dns-wire.ts";
import { logger } from "./logger.ts";

/**
 * DNSSEC-aware lookups against one trusted, validating resolver (#345,
 * DANE): `DANE_RESOLVER`, normally the local Unbound of the compose
 * `dane` profile.
 *
 * DANE depends on knowing whether an answer was validated (RFC 7672
 * section 2.1.1). BunMail does not validate signatures itself: it asks a
 * validating recursive resolver, with the AD bit set in the query (RFC
 * 6840 section 5.7), and reads the AD bit of the answer. That bit is only
 * worth something from a resolver BunMail trusts over a path it trusts
 * (RFC 4035 section 4.9.3, quoted by RFC 7672 section 2.1.1; RFC 6698
 * section 4.1), which is why this module only ever talks to the one
 * configured resolver, never the system list: a public resolver's AD bit
 * crosses the internet unprotected and an on-path attacker could set it.
 *
 * Each lookup gives one of:
 *
 * - `records`: the records of the type asked, `secure` when the answer
 *   carried AD. `name` is the fully CNAME-expanded name, `aliased` whether
 *   the name asked was an alias.
 * - `nodata` / `nxdomain`: no such records, or no such name. With `secure`
 *   this is an authenticated denial, which is an answer, not an error
 *   (RFC 7672 section 2.1.1).
 * - `failure`: SERVFAIL (a "bogus" or "indeterminate" answer, from a
 *   validating resolver), a timeout, REFUSED, a malformed reply, no
 *   resolver reachable. RFC 7672 sections 2.1.1 and 2.1.2 treat all of
 *   them alike: the information could not be obtained right now.
 *
 * **CNAME chains** (RFC 7672 section 2.1.3): a validating recursive
 * resolver follows the chain itself and returns it with the target's
 * records in one answer, whose AD bit covers the whole answer. When an
 * answer ends on an alias without records of the type asked, the query is
 * repeated at the end of the chain (at most {@link MAX_ALIAS_FOLLOWS}
 * times); the result is `secure` only if every answer on the way was.
 *
 * **Transport** (`dns-transport.ts`): UDP from a fresh socket with a random
 * ID and source port, EDNS0, once more without EDNS0 after a FORMERR, TCP
 * when the answer is truncated; replies from another address, port, ID or
 * question are dropped. A lookup that gets no answer tries once more,
 * within an overall cap, so a lost datagram does not fail it.
 *
 * Logs only at `debug`: the resolver, the type and the error code.
 */

/** The record types a secure lookup asks for. */
export type SecureType = DnsRecord["type"];

/** The record of type `K`. */
type RecordOf<K extends SecureType> = Extract<DnsRecord, { type: K }>;

/** What one secure lookup gave, see the module comment. */
export type SecureAnswer<T> =
  | { kind: "records"; secure: boolean; records: T[]; name: string; aliased: boolean }
  | { kind: "nodata"; secure: boolean; name: string; aliased: boolean }
  | { kind: "nxdomain"; secure: boolean }
  | { kind: "failure"; code: DnsTxtErrorCode };

/** How a secure lookup runs; the defaults suit production. */
export interface SecureLookupOptions {
  /** The trusted validating resolver (`DANE_RESOLVER`). */
  resolver: DnsServer;
  /** Longest one attempt may take: UDP, the retry without EDNS0, TCP. */
  attemptTimeoutMs?: number;
  /** Longest the whole lookup may take, aliases followed included. */
  timeoutMs?: number;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Attempts at the resolver when it does not answer. */
const ATTEMPTS = 2;
/** Repeated queries at the end of a CNAME chain the resolver did not finish. */
export const MAX_ALIAS_FOLLOWS = 4;

/** The QTYPE of each record type. */
const QTYPES: Record<SecureType, number> = {
  A: TYPE_A,
  AAAA: TYPE_AAAA,
  MX: TYPE_MX,
  CNAME: TYPE_CNAME,
  TLSA: TYPE_TLSA,
};

/** What one query (one name, one type) gave. */
type QueryOutcome =
  | Extract<DnsResponseOutcome, { kind: "answer" }>
  | { kind: "failure"; code: DnsTxtErrorCode; answered: boolean };

/** The transport's view of a reply to `question`. */
function checkFor(
  question: DnsQuestion,
): (message: Uint8Array) => ReplyCheck<QueryOutcome> {
  return (message) => {
    const outcome = parseDnsResponse(message, question);
    if (outcome.kind === "mismatch" || outcome.kind === "truncated") return outcome;
    if (outcome.kind === "error") {
      return {
        kind: "reply",
        reply: {
          kind: "failure",
          code: outcome.code,
          answered: outcome.code !== "EBADRESP",
        },
      };
    }
    return { kind: "reply", reply: outcome };
  };
}

/** An exchange as a query outcome. */
function fromExchange(exchange: Exchange<QueryOutcome>): QueryOutcome {
  return exchange.kind === "reply"
    ? exchange.reply
    : { kind: "failure", code: exchange.code, answered: false };
}

/**
 * One attempt at the resolver until `attemptEnds`: UDP with EDNS0, once
 * more without it after a FORMERR, TCP when truncated.
 */
async function askOnce(
  resolver: DnsServer,
  labels: readonly string[],
  qtype: number,
  attemptEnds: number,
): Promise<QueryOutcome> {
  for (let edns = true; ; edns = false) {
    if (attemptEnds - Date.now() <= 0) {
      return { kind: "failure", code: "ETIMEOUT", answered: false };
    }
    const question: DnsQuestion = { id: randomInt(0, 0x10000), labels, qtype };
    const message = encodeQuery(question, edns);
    const check = checkFor(question);
    const udp = await exchangeUdp(resolver, message, check, attemptEnds - Date.now());
    let outcome: QueryOutcome;
    if (udp.kind !== "truncated") {
      outcome = fromExchange(udp);
    } else if (attemptEnds - Date.now() <= 0) {
      outcome = { kind: "failure", code: "ETIMEOUT", answered: false };
    } else {
      outcome = fromExchange(
        await exchangeTcp(resolver, message, check, attemptEnds - Date.now()),
      );
    }
    /** RFC 6891 7: a server that does not do EDNS0 may answer FORMERR; ask it plainly once. */
    if (edns && outcome.kind === "failure" && outcome.code === "EFORMERR") continue;
    return outcome;
  }
}

/** One query, tried again when the resolver did not answer, until `deadline`. */
async function queryResolver(
  resolver: DnsServer,
  labels: readonly string[],
  qtype: number,
  attemptTimeoutMs: number,
  deadline: number,
): Promise<QueryOutcome> {
  let outcome: QueryOutcome = { kind: "failure", code: "ETIMEOUT", answered: false };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    outcome = await askOnce(
      resolver,
      labels,
      qtype,
      Date.now() + Math.min(attemptTimeoutMs, remaining),
    );
    if (outcome.kind !== "failure" || outcome.answered) return outcome;
  }
  if (outcome.kind === "failure") {
    logger.debug("DNSSEC lookup failed", {
      resolver: resolver.address,
      port: resolver.port,
      qtype,
      code: outcome.code,
    });
  }
  return outcome;
}

/**
 * Looks up the `type` records of `name` at the trusted resolver; see the
 * module comment for the outcomes. Never throws. A name that cannot be
 * queried (empty label, over 253 characters, non-ASCII) is `nxdomain`,
 * insecure: nothing can be learned about it.
 */
export async function lookupSecure<K extends SecureType>(
  name: string,
  type: K,
  options: SecureLookupOptions,
): Promise<SecureAnswer<RecordOf<K>>> {
  const asked = nameLabels(name);
  if (asked === null) return { kind: "nxdomain", secure: false };
  let labels: readonly string[] = asked;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const isType = (record: DnsRecord): record is RecordOf<K> => record.type === type;
  let secure = true;
  let aliased = false;
  for (let follows = 0; ; follows++) {
    const outcome = await queryResolver(
      options.resolver,
      labels,
      QTYPES[type],
      attemptTimeoutMs,
      deadline,
    );
    if (outcome.kind === "failure") return { kind: "failure", code: outcome.code };
    /** RFC 7672 2.1.3: one insecure answer on the way makes the result insecure. */
    secure = secure && outcome.authenticated;
    if (outcome.nxdomain) return { kind: "nxdomain", secure };
    const end: readonly string[] = outcome.chain.at(-1) ?? labels;
    aliased = aliased || outcome.chain.length > 1;
    const expanded = dottedName(end);
    /** A chain to a name that cannot be a host name: nothing usable. */
    if (expanded === null) return { kind: "failure", code: "EBADRESP" };
    const records = outcome.records.filter(isType);
    if (records.length > 0) {
      return { kind: "records", secure, records, name: expanded, aliased };
    }
    /** The answer ended on an alias without its records: ask at the end of the chain. */
    if (type === "CNAME" || outcome.chain.length < 2 || follows >= MAX_ALIAS_FOLLOWS) {
      return { kind: "nodata", secure, name: expanded, aliased };
    }
    labels = end;
  }
}
