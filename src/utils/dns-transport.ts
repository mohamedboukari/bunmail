import { createConnection, isIP, type Socket } from "net";
import { DNS_HEADER_BYTES } from "./dns-wire.ts";

/**
 * The DNS transport shared by the TXT resolver (`dns-txt.ts`) and the
 * DNSSEC-aware lookups of DANE (`dns-secure.ts`, #345): one query to one
 * server over UDP or TCP, with the spoofing checks. What a reply says is
 * the caller's parser's business ({@link ReplyCheck}): the transport only
 * needs to know whether a message answers the query, asks for TCP, or is
 * the reply.
 *
 * - **UDP:** a fresh socket connected to the server (a random source port,
 *   so concurrent answers cannot cross). A datagram counts only from the
 *   address and port queried, at most 4096 bytes and not cut short by the
 *   kernel, and only if the parser says it answers our query; anything
 *   else is dropped and the wait goes on, so a blind spoof cannot end the
 *   lookup.
 * - **TCP:** `node:net`, whose pending connect can be aborted, so a stalled
 *   connect never outlives the attempt; one message read back after its
 *   two-byte length prefix. A reply that does not answer the query, is
 *   truncated again or runs past its length prefix is `EBADRESP`.
 *
 * Both close their socket and clear their timer on every path.
 */

/** A resolver to send queries to. */
export interface DnsServer {
  address: string;
  port: number;
  family: 4 | 6;
}

const DNS_PORT = 53;
/** Datagrams larger than this are dropped unread. */
const MAX_UDP_RESPONSE_BYTES = 4096;

/**
 * A server as `dns.getServers()` lists it (`1.2.3.4`, `1.2.3.4:5353`,
 * `2001:db8::1` or `[2001:db8::1]:5353`, port 53 by default), or `null`
 * when it is not an IP literal with a valid port.
 */
export function parseServer(entry: string): DnsServer | null {
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

/** What the caller's parser says about one message. */
export type ReplyCheck<R> =
  /** Not an answer to our query: dropped (UDP) or `EBADRESP` (TCP). */
  | { kind: "mismatch" }
  /** TC set: ask again over TCP (`EBADRESP` over TCP). */
  | { kind: "truncated" }
  | { kind: "reply"; reply: R };

/** A transport failure: nothing usable came back. */
export type TransportCode = "ETIMEOUT" | "ECONNREFUSED" | "EBADRESP";

/** What one exchange with one server gave. */
export type Exchange<R> =
  { kind: "reply"; reply: R } | { kind: "failed"; code: TransportCode };

/**
 * Sends `query` over UDP from a fresh socket connected to `server` and
 * waits up to `timeoutMs` for a datagram `check` accepts; others are
 * dropped. A socket that cannot be created or connected (Bun throws at
 * once for no route, EHOSTUNREACH) is `ECONNREFUSED`.
 */
export function exchangeUdp<R>(
  server: DnsServer,
  query: Uint8Array,
  check: (message: Uint8Array) => ReplyCheck<R>,
  timeoutMs: number,
): Promise<Exchange<R> | { kind: "truncated" }> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: { close(): void; readonly closed: boolean } | undefined;
    /** The server's address as Bun formats it, to compare each datagram's source with. */
    let remote: { address: string; port: number } | undefined;
    const finish = (outcome: Exchange<R> | { kind: "truncated" }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeQuietly(socket);
      resolve(outcome);
    };
    const fail = (code: TransportCode): void => finish({ kind: "failed", code });
    const timer = setTimeout(() => fail("ETIMEOUT"), timeoutMs);
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
          const outcome = check(data);
          if (outcome.kind === "mismatch") return;
          finish(outcome);
        },
        () => fail("ECONNREFUSED"),
      );
    } catch {
      fail("ECONNREFUSED");
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
          if (!opened.send(query)) fail("ECONNREFUSED");
        } catch {
          fail("ECONNREFUSED");
        }
      },
      () => fail("ECONNREFUSED"),
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
 * a reply `check` does not accept as the reply, or bytes past the message,
 * is `EBADRESP`. `node:net` rather than `Bun.connect`: its socket exists
 * before the connect completes, so the timeout destroys a stalled connect
 * at once instead of leaving it to the OS timeout.
 */
export function exchangeTcp<R>(
  server: DnsServer,
  query: Uint8Array,
  check: (message: Uint8Array) => ReplyCheck<R>,
  timeoutMs: number,
): Promise<Exchange<R>> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    const prefix = new Uint8Array(2);
    let prefixBytes = 0;
    let message: Uint8Array | undefined;
    let filled = 0;

    const finish = (outcome: Exchange<R>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(outcome);
    };
    const fail = (code: TransportCode): void => finish({ kind: "failed", code });
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
      const outcome = check(message);
      if (outcome.kind !== "reply") return fail("EBADRESP");
      finish(outcome);
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
