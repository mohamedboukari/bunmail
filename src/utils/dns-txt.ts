import { randomInt } from "crypto";
import { getServers } from "dns";
import {
  exchangeTcp,
  exchangeUdp,
  parseServer,
  type DnsServer,
  type Exchange,
  type ReplyCheck,
} from "./dns-transport.ts";
import {
  encodeQuery,
  nameLabels,
  parseTxtResponse,
  type DnsTxtErrorCode,
  type TxtQuestion,
  type TxtResponseOutcome,
} from "./dns-wire.ts";
import { logger } from "./logger.ts";

/**
 * TXT lookups with the record boundaries right.
 *
 * Bun's `dns/promises.resolveTxt` (1.3.14, and still 1.4.3, oven-sh/bun#44692)
 * returns each character-string of a TXT record as a record of its own: one
 * record `"s1" "s2"` comes back as `[["s1"], ["s2"]]` where Node returns
 * `[["s1", "s2"]]`. A 2048-bit DKIM key, or an SPF record over 255
 * characters, is published as several strings, so it reads as two broken
 * records. This module asks the system resolvers itself and returns Node's
 * shape: one entry per record, each the list of its strings. No dependency.
 * The wire format (name checks, query, strict response parse) is in
 * `dns-wire.ts`, the sockets in `dns-transport.ts`; this file is the
 * lookup: servers, attempts, retries and errors.
 *
 * **Servers:** `dns.getServers()` (in Docker the compose or host resolver,
 * on a host its `/etc/resolv.conf`), or `options.servers` (tests). Each is
 * tried in order, then once more, under a per-attempt timeout and an
 * overall cap, so a lookup never hangs. A server that cannot even be
 * reached (no route, a socket error) is skipped for the next one.
 *
 * **One attempt** at one server, within one budget: a query over UDP from
 * a fresh socket connected to the server (a random source port, so
 * concurrent answers cannot cross) with a random 16-bit ID from `crypto`
 * and EDNS0; after a FORMERR, once more without EDNS0; when the answer is
 * truncated (TC), the same query over TCP (`node:net`, whose pending
 * connect can be aborted, so a stalled connect never outlives the attempt).
 * A UDP datagram counts only from the address and port queried, at most
 * 4096 bytes and not cut short by the kernel, and only if `dns-wire.ts`
 * says it answers our query; anything else is dropped and the wait goes
 * on, so a blind spoof cannot end the lookup. Over TCP a reply that does
 * not answer the query, is truncated again or runs past its length prefix
 * is `EBADRESP`.
 *
 * **Errors** are {@link DnsTxtError}s whose `code` is the one `node:dns`
 * uses, which every caller already classifies: NXDOMAIN `ENOTFOUND`, no TXT
 * record `ENODATA`, SERVFAIL `ESERVFAIL`, REFUSED `EREFUSED`, NOTIMP
 * `ENOTIMP`, FORMERR `EFORMERR`, no answer in time `ETIMEOUT`, a malformed
 * answer `EBADRESP`, no usable server or a failed socket `ECONNREFUSED`. A
 * name that cannot exist is `ENOTFOUND` without a query, as Bun's resolver
 * reports it. When one server answers with an error and another times
 * out, the answered error is reported.
 *
 * Logs only the server and the error code at `debug`: the name is not
 * logged, since SPF macros can put a sender's local part in it.
 */

/** A failed TXT lookup, shaped like a `node:dns` error (`code`, `syscall`, `hostname`). */
export class DnsTxtError extends Error {
  override readonly name = "DnsTxtError";
  readonly code: DnsTxtErrorCode;
  readonly syscall = "queryTxt";
  readonly hostname: string;

  constructor(code: DnsTxtErrorCode, hostname: string) {
    super(`queryTxt ${code} ${hostname}`);
    this.code = code;
    this.hostname = hostname;
  }
}

/** How a lookup runs; the defaults suit production. */
export interface TxtLookupOptions {
  /**
   * Resolvers to ask, in order, as `dns.getServers()` lists them: `1.2.3.4`,
   * `1.2.3.4:5353`, `2001:db8::1` or `[2001:db8::1]:5353`. Default:
   * `dns.getServers()`, read at each lookup.
   */
  servers?: readonly string[];
  /**
   * Longest one attempt at one server may take, all of it: UDP, the retry
   * without EDNS0 after a FORMERR, and TCP when the answer is truncated.
   */
  attemptTimeoutMs?: number;
  /** Longest the whole lookup may take, all attempts included. */
  timeoutMs?: number;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 8_000;
/** Passes over the server list; a server that answered is not asked again. */
const ROUNDS = 2;

/* ─── Transports ─── */

/** What one attempt against one server gave. */
type AttemptOutcome =
  | { kind: "records"; records: string[][] }
  /** `answered`: the server replied with this error (it is not asked again). */
  | { kind: "error"; code: DnsTxtErrorCode; answered: boolean };

/** A failure the server did not answer with (timeout, socket, malformed). */
function unanswered(code: DnsTxtErrorCode): AttemptOutcome {
  return { kind: "error", code, answered: false };
}

/** Turns a parsed reply into an attempt outcome. */
function attemptOutcome(
  outcome: Extract<TxtResponseOutcome, { kind: "records" | "error" }>,
): AttemptOutcome {
  if (outcome.kind === "records") return outcome;
  return { kind: "error", code: outcome.code, answered: outcome.code !== "EBADRESP" };
}

/** The transport's view of a TXT reply to `question`. */
function txtCheck(
  question: TxtQuestion,
): (
  message: Uint8Array,
) => ReplyCheck<Extract<TxtResponseOutcome, { kind: "records" | "error" }>> {
  return (message) => {
    const outcome = parseTxtResponse(message, question);
    if (outcome.kind === "mismatch" || outcome.kind === "truncated") return outcome;
    return { kind: "reply", reply: outcome };
  };
}

/** An exchange's outcome as an attempt outcome. */
function fromExchange(
  exchange: Exchange<Extract<TxtResponseOutcome, { kind: "records" | "error" }>>,
): AttemptOutcome {
  return exchange.kind === "reply"
    ? attemptOutcome(exchange.reply)
    : unanswered(exchange.code);
}

/**
 * Sends `query` over TCP to `server` and reads one message back, up to
 * `timeoutMs` (`exchangeTcp`): over TCP a reply that is not ours, is
 * truncated, or has bytes past the message is `EBADRESP`. Exported for
 * the tests.
 */
export async function queryTcp(
  server: DnsServer,
  query: Uint8Array,
  question: TxtQuestion,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  return fromExchange(await exchangeTcp(server, query, txtCheck(question), timeoutMs));
}

/* ─── Lookup ─── */

/**
 * One attempt at `server` until `attemptEnds`: UDP with EDNS0, once more
 * without it after a FORMERR, TCP when truncated. Every step gets only what
 * is left of the attempt's budget.
 */
async function askServer(
  server: DnsServer,
  labels: readonly string[],
  attemptEnds: number,
): Promise<AttemptOutcome> {
  for (let edns = true; ; edns = false) {
    if (attemptEnds - Date.now() <= 0) return unanswered("ETIMEOUT");
    const question: TxtQuestion = { id: randomInt(0, 0x10000), labels };
    const query = encodeQuery(question, edns);
    const udp = await exchangeUdp(
      server,
      query,
      txtCheck(question),
      attemptEnds - Date.now(),
    );
    let outcome: AttemptOutcome;
    if (udp.kind !== "truncated") {
      outcome = fromExchange(udp);
    } else if (attemptEnds - Date.now() <= 0) {
      outcome = unanswered("ETIMEOUT");
    } else {
      outcome = await queryTcp(server, query, question, attemptEnds - Date.now());
    }
    /** RFC 6891 7: a server that does not do EDNS0 may answer FORMERR; ask it plainly once. */
    if (edns && outcome.kind === "error" && outcome.code === "EFORMERR") continue;
    return outcome;
  }
}

/**
 * The TXT records at `hostname`: one entry per record, each the list of
 * its character-strings, in the order the answer gives them (the shape of
 * `dns/promises.resolveTxt` under Node). Rejects with a
 * {@link DnsTxtError}; see the module comment for the codes.
 */
export async function resolveTxtRecords(
  hostname: string,
  options: TxtLookupOptions = {},
): Promise<string[][]> {
  const labels = nameLabels(hostname);
  if (labels === null) throw new DnsTxtError("ENOTFOUND", hostname);
  const servers = (options.servers ?? getServers())
    .map(parseServer)
    .filter((server): server is DnsServer => server !== null);
  if (servers.length === 0) throw new DnsTxtError("ECONNREFUSED", hostname);

  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  /** Servers that answered (with an error): asking them again would get the same answer. */
  const answered = new Set<DnsServer>();
  let answeredError: DnsTxtErrorCode | null = null;
  let transportError: DnsTxtErrorCode = "ETIMEOUT";

  for (let round = 0; round < ROUNDS; round++) {
    for (const server of servers) {
      if (answered.has(server)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const outcome = await askServer(
        server,
        labels,
        Date.now() + Math.min(attemptTimeoutMs, remaining),
      );
      if (outcome.kind === "records") return outcome.records;
      if (outcome.code === "ENOTFOUND" || outcome.code === "ENODATA") {
        throw new DnsTxtError(outcome.code, hostname);
      }
      logger.debug("DNS TXT attempt failed", {
        server: server.address,
        port: server.port,
        code: outcome.code,
      });
      if (outcome.answered) {
        answered.add(server);
        answeredError = outcome.code;
      } else {
        transportError = outcome.code;
      }
    }
  }
  throw new DnsTxtError(answeredError ?? transportError, hostname);
}
