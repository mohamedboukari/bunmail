import { afterAll, beforeAll } from "bun:test";
import type { Socket } from "bun";
import {
  DnsTxtError,
  resolveTxtRecords,
  type TxtLookupOptions,
} from "../src/utils/dns-txt.ts";

/**
 * A fake DNS server for the TXT resolver's tests (`src/utils/dns-txt.ts`):
 * UDP and TCP on one port of 127.0.0.1, answering each query with whatever
 * the test's handler returns, byte for byte. No test reaches real DNS.
 *
 * The handler gets the parsed query and returns the messages to send back,
 * in order (none: the client times out). Over TCP each message is framed
 * with its two-byte length unless it is given as `{ raw }`; a `{ raw }`
 * reply can wait `delayMs` after the one before it (a peer that dribbles
 * its answer). Builders below make well-formed responses, and the tests
 * corrupt them as they need. {@link useFakeDns} runs one server per test
 * file with the helpers the transport tests share.
 */

export const TYPE_TXT = 16;
export const TYPE_CNAME = 5;
export const TYPE_OPT = 41;
export const CLASS_IN = 1;

/** One query as the fake server received it. */
export interface FakeDnsQuery {
  id: number;
  /** The question name as sent (case kept), without a trailing dot. */
  name: string;
  qtype: number;
  qclass: number;
  /** Header flags as sent (RD is 0x0100). */
  flags: number;
  /** ARCOUNT, and the UDP payload size of the OPT record when there is one. */
  additionalCount: number;
  ednsPayload: number | null;
  transport: "udp" | "tcp";
  /** The client's source port (UDP), for tests that spoof it. */
  clientPort: number;
  raw: Uint8Array;
}

/** A message to send: framed over TCP, unless `raw` (sent as is, `delayMs` after the previous one). */
export type FakeDnsReply = Uint8Array | { raw: Uint8Array; delayMs?: number };

export type FakeDnsHandler = (query: FakeDnsQuery) => FakeDnsReply[];

/** A running fake server. */
export interface FakeDnsServer {
  /** `127.0.0.1:<port>`, as `dns.getServers()` lists a server on another port. */
  server: string;
  port: number;
  /** Every query received, in order. */
  queries: FakeDnsQuery[];
  /** Replaces the handler. */
  setHandler(handler: FakeDnsHandler): void;
  stop(): void;
}

/** Reads a query's question (uncompressed, as the client sends it). */
function parseQuery(
  raw: Uint8Array,
  transport: "udp" | "tcp",
  clientPort: number,
): FakeDnsQuery | null {
  if (raw.length < 12) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    const length = raw[at];
    if (length === undefined) return null;
    if (length === 0) break;
    labels.push(Buffer.from(raw.subarray(at + 1, at + 1 + length)).toString("latin1"));
    at += 1 + length;
  }
  at += 1;
  if (at + 4 > raw.length) return null;
  const additionalCount = view.getUint16(10);
  let ednsPayload: number | null = null;
  const optAt = at + 4;
  if (additionalCount > 0 && raw[optAt] === 0 && optAt + 11 <= raw.length) {
    if (view.getUint16(optAt + 1) === TYPE_OPT) ednsPayload = view.getUint16(optAt + 3);
  }
  return {
    id: view.getUint16(0),
    name: labels.join("."),
    qtype: view.getUint16(at),
    qclass: view.getUint16(at + 2),
    flags: view.getUint16(2),
    additionalCount,
    ednsPayload,
    transport,
    clientPort,
    raw,
  };
}

/**
 * Sends `replies` in order through `send`, framing plain messages over TCP;
 * a reply with `delayMs` goes that long after the one before it.
 */
function deliver(
  replies: FakeDnsReply[],
  tcp: boolean,
  send: (bytes: Uint8Array) => void,
): void {
  let wait = 0;
  for (const reply of replies) {
    const bytes = reply instanceof Uint8Array ? (tcp ? framed(reply) : reply) : reply.raw;
    wait += reply instanceof Uint8Array ? 0 : (reply.delayMs ?? 0);
    if (wait === 0) {
      send(bytes);
      continue;
    }
    setTimeout(() => {
      try {
        send(bytes);
      } catch {
        /** The server or the connection is gone: nothing to send to. */
      }
    }, wait);
  }
}

/** `bytes` with its two-byte TCP length prefix. */
function framed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 2);
  new DataView(out.buffer).setUint16(0, bytes.length);
  out.set(bytes, 2);
  return out;
}

/**
 * Starts a fake server on 127.0.0.1: UDP on a free port, TCP on the same
 * port (retried on another port when that one is taken for TCP).
 */
export async function startFakeDns(initial: FakeDnsHandler): Promise<FakeDnsServer> {
  let handler = initial;
  const queries: FakeDnsQuery[] = [];
  /** Bytes received per TCP connection, until a whole message is in. */
  const buffers = new WeakMap<Socket, Uint8Array>();

  for (let tries = 0; tries < 20; tries++) {
    const udp = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      binaryType: "uint8array",
      socket: {
        data(socket, data, port, address) {
          const query = parseQuery(new Uint8Array(data), "udp", port);
          if (query === null) return;
          queries.push(query);
          deliver(handler(query), false, (bytes) => socket.send(bytes, port, address));
        },
      },
    });
    try {
      const tcp = Bun.listen({
        hostname: "127.0.0.1",
        port: udp.port,
        socket: {
          data(socket, data) {
            const previous = buffers.get(socket) ?? new Uint8Array(0);
            const all = new Uint8Array(previous.length + data.length);
            all.set(previous);
            all.set(data, previous.length);
            buffers.set(socket, all);
            if (all.length < 2) return;
            const length = ((all[0] ?? 0) << 8) | (all[1] ?? 0);
            if (all.length < length + 2) return;
            buffers.set(socket, new Uint8Array(0));
            const query = parseQuery(all.slice(2, length + 2), "tcp", 0);
            if (query === null) return;
            queries.push(query);
            deliver(handler(query), true, (bytes) => socket.write(bytes));
          },
        },
      });
      return {
        server: `127.0.0.1:${udp.port}`,
        port: udp.port,
        queries,
        setHandler(next) {
          handler = next;
        },
        stop() {
          udp.close();
          tcp.stop(true);
        },
      };
    } catch {
      udp.close();
    }
  }
  throw new Error("no free port for the fake DNS server");
}

/** A small seeded PRNG (mulberry32), so fuzz cases are the same on every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/* ─── Message builders ─── */

/** A name in wire form, uncompressed. */
export function encodeName(name: string): Uint8Array {
  const labels = name
    .replace(/\.$/, "")
    .split(".")
    .filter((label) => label !== "");
  const out: number[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "latin1");
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return Uint8Array.from(out);
}

/** TXT RDATA holding `strings`, each latin1, as `<length><bytes>`. */
export function txtRdata(...strings: string[]): Uint8Array {
  const out: number[] = [];
  for (const text of strings) {
    const bytes = Buffer.from(text, "latin1");
    if (bytes.length > 255) throw new Error("a character-string holds 255 bytes at most");
    out.push(bytes.length, ...bytes);
  }
  return Uint8Array.from(out);
}

/** One resource record for {@link buildResponse}. */
export interface FakeRecord {
  /** Owner name; `null` means a pointer to the question name (offset 12). */
  name: string | null;
  type?: number;
  rrClass?: number;
  ttl?: number;
  rdata: Uint8Array;
  /** RDLENGTH as written; default the RDATA's length. */
  rdlength?: number;
}

/** What {@link buildResponse} writes; every field has a sensible default. */
export interface ResponseOptions {
  id?: number;
  rcode?: number;
  tc?: boolean;
  qr?: boolean;
  opcode?: number;
  /** The question echoed; default the query's. */
  question?: { name: string; type?: number; rrClass?: number };
  answers?: FakeRecord[];
  authority?: FakeRecord[];
  additional?: FakeRecord[];
}

/** A TXT record owned by the question name (compressed), with `strings`. */
export function txt(...strings: string[]): FakeRecord {
  return { name: null, rdata: txtRdata(...strings) };
}

/** Builds a response to `query`. */
export function buildResponse(
  query: FakeDnsQuery,
  options: ResponseOptions = {},
): Uint8Array {
  const question = options.question ?? { name: query.name };
  const answers = options.answers ?? [];
  const authority = options.authority ?? [];
  const additional = options.additional ?? [];
  const out: number[] = [];
  const u16 = (value: number): void => {
    out.push((value >> 8) & 0xff, value & 0xff);
  };
  u16(options.id ?? query.id);
  const flags =
    ((options.qr ?? true) ? 0x8000 : 0) |
    ((options.opcode ?? 0) << 11) |
    (options.tc === true ? 0x0200 : 0) |
    0x0100 |
    0x0080 |
    ((options.rcode ?? 0) & 0x0f);
  u16(flags);
  u16(1);
  u16(answers.length);
  u16(authority.length);
  u16(additional.length);
  out.push(...encodeName(question.name));
  u16(question.type ?? TYPE_TXT);
  u16(question.rrClass ?? CLASS_IN);
  for (const record of [...answers, ...authority, ...additional]) {
    if (record.name === null) out.push(0xc0, 12);
    else out.push(...encodeName(record.name));
    u16(record.type ?? TYPE_TXT);
    u16(record.rrClass ?? CLASS_IN);
    const ttl = record.ttl ?? 300;
    u16((ttl >>> 16) & 0xffff);
    u16(ttl & 0xffff);
    u16(record.rdlength ?? record.rdata.length);
    out.push(...record.rdata);
  }
  return Uint8Array.from(out);
}

/** An EDNS0 OPT record for the additional section, with the given extended RCODE bits. */
export function optRecord(extendedRcode = 0): FakeRecord {
  return {
    name: "",
    type: TYPE_OPT,
    rrClass: 1232,
    ttl: (extendedRcode << 24) >>> 0,
    rdata: new Uint8Array(0),
  };
}

/** What a zone name answers: TXT records (each a list of strings), or an RCODE. */
export type ZoneAnswer = string[][] | { rcode: number };

/**
 * A handler serving `zone` over UDP and TCP: TXT queries for a listed name
 * get its records (or its RCODE), other names NXDOMAIN. Names compare
 * case-insensitively.
 */
export function zoneHandler(zone: Record<string, ZoneAnswer>): FakeDnsHandler {
  const byName = new Map(
    Object.entries(zone).map(([name, answer]) => [name.toLowerCase(), answer]),
  );
  return (query) => {
    const answer = byName.get(query.name.toLowerCase());
    if (answer === undefined) return [buildResponse(query, { rcode: 3 })];
    if (!Array.isArray(answer)) return [buildResponse(query, { rcode: answer.rcode })];
    return [
      buildResponse(query, {
        answers: answer.map((strings) => txt(...strings)),
        additional: [optRecord()],
      }),
    ];
  };
}

/* ─── Test harness ─── */

/** One fake server for a test file, and the helpers its tests share. */
export interface FakeDnsHarness {
  /** The running server (set in `beforeAll`). */
  readonly dns: FakeDnsServer;
  /** Lookup options aimed at the fake, with short timeouts, plus `overrides`. */
  readonly options: (overrides?: TxtLookupOptions) => TxtLookupOptions;
  /** Serves `handler` for the next lookups and clears the query log. */
  readonly serve: (handler: FakeDnsHandler) => void;
  /** The error a lookup rejects with; fails when it resolves or rejects with something else. */
  readonly lookupError: (
    name: string,
    overrides?: TxtLookupOptions,
  ) => Promise<DnsTxtError>;
}

/** Starts a fake server before the file's tests and stops it after them. */
export function useFakeDns(): FakeDnsHarness {
  let server: FakeDnsServer | undefined;
  beforeAll(async () => {
    server = await startFakeDns(() => []);
  });
  afterAll(() => {
    server?.stop();
  });
  const running = (): FakeDnsServer => {
    if (server === undefined) throw new Error("the fake DNS server is not running");
    return server;
  };
  const options = (overrides: TxtLookupOptions = {}): TxtLookupOptions => ({
    servers: [running().server],
    attemptTimeoutMs: 400,
    timeoutMs: 1_500,
    ...overrides,
  });
  return {
    get dns() {
      return running();
    },
    options,
    serve: (handler) => {
      const dns = running();
      dns.queries.length = 0;
      dns.setHandler(handler);
    },
    lookupError: async (name, overrides = {}) => {
      try {
        const records = await resolveTxtRecords(name, options(overrides));
        throw new Error(`expected a rejection, got ${JSON.stringify(records)}`);
      } catch (error) {
        if (error instanceof DnsTxtError) return error;
        throw error;
      }
    },
  };
}
