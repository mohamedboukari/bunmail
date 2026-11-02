import { randomInt } from "crypto";
import { getServers } from "dns";
import { createConnection, isIP, type Socket } from "net";
import {
  DNS_HEADER_BYTES,
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
 * `dns-wire.ts`; this file is the transport.
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

const DNS_PORT = 53;
/** Datagrams larger than this are dropped unread. */
const MAX_UDP_RESPONSE_BYTES = 4096;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 8_000;
/** Passes over the server list; a server that answered is not asked again. */
const ROUNDS = 2;

/* ─── Servers ─── */

/** A resolver to send queries to. */
interface DnsServer {
  address: string;
  port: number;
  family: 4 | 6;
}

/** A `dns.getServers()` entry as a server, or `null` when it cannot be read. */
function parseServer(entry: string): DnsServer | null {
  let address = entry;
  let port = DNS_PORT;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry);
  if (bracketed) {
    address = bracketed[1] ?? "";
    port = bracketed[2] === undefined ? DNS_PORT : Number(bracketed[2]);
  } else if (isIP(entry) === 0) {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(entry);
    if (!withPort) return null;
    address = withPort[1] ?? "";
    port = Number(withPort[2]);
  }
  const family = isIP(address);
  if (family === 0 || port < 1 || port > 65_535) return null;
  return { address, port, family: family === 4 ? 4 : 6 };
}

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

/** Turns a parsed response into an attempt outcome (`truncated` and `mismatch` handled by the caller). */
function attemptOutcome(outcome: TxtResponseOutcome): AttemptOutcome {
  if (outcome.kind === "records") return outcome;
  if (outcome.kind === "error") {
    return { kind: "error", code: outcome.code, answered: outcome.code !== "EBADRESP" };
  }
  return unanswered("EBADRESP");
}

/** What a UDP attempt gave, or `truncated` when the answer needs TCP. */
type UdpOutcome = AttemptOutcome | { kind: "truncated" };

/**
 * Sends `query` over UDP from a fresh socket connected to `server` and
 * waits up to `timeoutMs` for an answer that passes the checks; others are
 * dropped. A socket that cannot be created or connected (Bun throws at
 * once for no route, EHOSTUNREACH) is `ECONNREFUSED`. The socket is closed
 * and the timer cleared on every path.
 */
function queryUdp(
  server: DnsServer,
  query: Uint8Array,
  question: TxtQuestion,
  timeoutMs: number,
): Promise<UdpOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: { close(): void; readonly closed: boolean } | undefined;
    /** The server's address as Bun formats it, to compare each datagram's source with. */
    let remote: { address: string; port: number } | undefined;
    const finish = (outcome: UdpOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeQuietly(socket);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish(unanswered("ETIMEOUT")), timeoutMs);
    let opening: ReturnType<typeof connectUdp>;
    try {
      opening = connectUdp(
        server,
        (data, port, address, truncated) => {
          if (settled) return;
          /** The socket is connected, so the kernel filters too; checked again here. */
          if (
            remote === undefined ||
            port !== remote.port ||
            address !== remote.address
          ) {
            return;
          }
          if (truncated || data.byteLength > MAX_UDP_RESPONSE_BYTES) return;
          const outcome = parseTxtResponse(data, question);
          if (outcome.kind === "mismatch") return;
          finish(outcome.kind === "truncated" ? outcome : attemptOutcome(outcome));
        },
        () => finish(unanswered("ECONNREFUSED")),
      );
    } catch {
      finish(unanswered("ECONNREFUSED"));
      return;
    }
    opening.then(
      (opened) => {
        socket = opened;
        if (settled) {
          closeQuietly(opened);
          return;
        }
        remote = {
          address: opened.remoteAddress.address,
          port: opened.remoteAddress.port,
        };
        try {
          if (!opened.send(query)) finish(unanswered("ECONNREFUSED"));
        } catch {
          finish(unanswered("ECONNREFUSED"));
        }
      },
      () => finish(unanswered("ECONNREFUSED")),
    );
  });
}

/** A UDP socket connected to `server`, delivering datagrams and errors to the callbacks. */
function connectUdp(
  server: DnsServer,
  onData: (data: Uint8Array, port: number, address: string, truncated: boolean) => void,
  onError: () => void,
) {
  return Bun.udpSocket({
    hostname: server.family === 6 ? "::" : "0.0.0.0",
    binaryType: "uint8array",
    connect: { hostname: server.address, port: server.port },
    socket: {
      data(_socket, data, port, address, flags) {
        onData(data, port, address, flags.truncated);
      },
      error() {
        onError();
      },
    },
  });
}

/** Closes a UDP socket once; Bun may already have closed it (an ICMP error). */
function closeQuietly(
  socket: { close(): void; readonly closed: boolean } | undefined,
): void {
  if (socket === undefined || socket.closed) return;
  try {
    socket.close();
  } catch {
    /** Already closed: nothing to release. */
  }
}

/**
 * Sends `query` over TCP to `server` with the two-byte length prefix and
 * reads one message back, up to `timeoutMs`. The message is read into one
 * buffer of the size the prefix gives (at most 65535 bytes, copied once);
 * over TCP a reply that is not ours, is truncated, or has bytes past the
 * message is `EBADRESP`. `node:net` rather than `Bun.connect`: its socket
 * exists before the connect completes, so the timeout destroys a stalled
 * connect at once instead of leaving it to the OS timeout. Exported for
 * the tests.
 */
export function queryTcp(
  server: DnsServer,
  query: Uint8Array,
  question: TxtQuestion,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    const prefix = new Uint8Array(2);
    let prefixBytes = 0;
    let message: Uint8Array | undefined;
    let filled = 0;

    const finish = (outcome: AttemptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(outcome);
    };
    const fail = (code: DnsTxtErrorCode): void => finish(unanswered(code));
    const timer = setTimeout(() => fail("ETIMEOUT"), timeoutMs);

    /** Copies one chunk into the prefix, then the message; parses once the message is whole. */
    const receive = (chunk: Uint8Array): void => {
      let at = 0;
      while (prefixBytes < 2 && at < chunk.length)
        prefix[prefixBytes++] = chunk[at++] ?? 0;
      if (prefixBytes < 2) return;
      if (message === undefined) {
        const length = ((prefix[0] ?? 0) << 8) | (prefix[1] ?? 0);
        if (length < DNS_HEADER_BYTES) return fail("EBADRESP");
        message = new Uint8Array(length);
      }
      const rest = chunk.length - at;
      if (filled + rest > message.length) return fail("EBADRESP");
      message.set(chunk.subarray(at), filled);
      filled += rest;
      if (filled < message.length) return;
      const outcome = parseTxtResponse(message, question);
      if (outcome.kind === "mismatch" || outcome.kind === "truncated")
        return fail("EBADRESP");
      finish(attemptOutcome(outcome));
    };

    const frame = new Uint8Array(query.length + 2);
    new DataView(frame.buffer).setUint16(0, query.length);
    frame.set(query, 2);
    try {
      socket = createConnection({ host: server.address, port: server.port });
      socket.on("data", (chunk: Buffer) => {
        if (!settled) receive(chunk);
      });
      socket.on("error", () => fail("ECONNREFUSED"));
      socket.on("close", () => fail("EBADRESP"));
      socket.write(frame);
    } catch {
      fail("ECONNREFUSED");
    }
  });
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
    const udp = await queryUdp(server, query, question, attemptEnds - Date.now());
    let outcome: AttemptOutcome;
    if (udp.kind !== "truncated") {
      outcome = udp;
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
