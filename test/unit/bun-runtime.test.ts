/**
 * Bun runtime behaviours BunMail relies on since it dropped the Bun 1.3.14
 * workarounds for them (#456, after the 1.4.4 upgrade, #447). Each test
 * fails on 1.3.14 (checked in the `oven/bun:1.3.14` Linux image) and
 * passes on 1.4.4, so a runtime bump that brings a bug back fails here,
 * and the weekly canary run (`bun-canary.yml`) warns before the bump.
 *
 * The clients are Node child processes, so the client is never the
 * runtime under test.
 */

import { readFileSync } from "fs";
import type { AddressInfo } from "net";
import { Writable } from "stream";
import { createServer as createTlsServer } from "tls";
import { describe, expect, test } from "bun:test";
import { boundTestPort } from "../listen-port.ts";

const TLS_DIR = new URL("../fixtures/tls/", import.meta.url).pathname;

/** Node on `PATH`, as for the other tests that run a real peer. */
function nodeBinary(): string {
  const node = Bun.which("node");
  if (node === null) throw new Error("these tests need `node` on PATH");
  return node;
}

/** `/proc/net/tcp` state codes of a server socket a gone client must not leave. */
const LINGERING_STATES = new Map([
  ["01", "ESTABLISHED"],
  ["08", "CLOSE_WAIT"],
]);

/**
 * This process's sockets on `port` still open for a client (the listener
 * aside): the kernel's TCP tables on Linux, `lsof` on macOS (where a socket
 * the runtime never released also shows as CLOSED).
 */
function lingeringSockets(port: number): string[] {
  if (process.platform === "linux") {
    const local = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
    const states: string[] = [];
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let rows: string[];
      try {
        rows = readFileSync(table, "utf8").split("\n").slice(1);
      } catch {
        /** No IPv6 table on a host without IPv6. */
        continue;
      }
      for (const row of rows) {
        const [, address, , state] = row.trim().split(/\s+/);
        const name = state === undefined ? undefined : LINGERING_STATES.get(state);
        if (address?.endsWith(local) && name !== undefined) states.push(name);
      }
    }
    return states;
  }
  const lsof = Bun.which("lsof");
  if (lsof === null) throw new Error("this test needs /proc/net/tcp or `lsof`");
  const out = Bun.spawnSync([
    lsof,
    "-nP",
    "-a",
    "-p",
    String(process.pid),
    `-iTCP:${port}`,
  ]).stdout.toString();
  return out
    .split("\n")
    .map((line) => /\((ESTABLISHED|CLOSE_WAIT|CLOSED)\)$/.exec(line.trim())?.[1])
    .filter((state) => state !== undefined);
}

/** Polls `done` every 50 ms for up to `ms`; returns its last answer. */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (done() || Date.now() > deadline) return done();
    await Bun.sleep(50);
  }
}

/** The share of one CPU core this process uses over `ms`. */
async function cpuShare(ms: number): Promise<number> {
  const before = process.cpuUsage();
  const startedAt = performance.now();
  await Bun.sleep(ms);
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000 / (performance.now() - startedAt);
}

describe("Bun runtime behaviours (#456)", () => {
  /**
   * #351: smtp-server answers QUIT, ends the socket, then unpipes its
   * parser, which pauses it. Under Bun 1.3.14 such a TLS socket never
   * closed once the client's FIN arrived: it stayed in CLOSE_WAIT and the
   * event loop spun on it at a full core (Linux). The implicit-TLS
   * listener guarded every socket against it (`closeWholeSocket`) until
   * #456. The QUIT exchange here is the one smtp-server runs.
   */
  test("a TLS socket ended then paused closes when the client hangs up (#351)", async () => {
    const CLIENTS = 5;
    let closed = 0;
    const server = createTlsServer(
      {
        key: readFileSync(`${TLS_DIR}mx1.example.test.key.pem`),
        cert: readFileSync(`${TLS_DIR}mx1.example.test.cert.pem`),
      },
      (socket) => {
        socket.on("close", () => {
          closed += 1;
        });
        const parser = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            if (chunk.toString().includes("QUIT")) {
              socket.write("221 Bye\r\n");
              socket.end();
              socket.unpipe(parser);
            }
            callback();
          },
        });
        socket.pipe(parser);
        socket.write("220 ready\r\n");
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    const port = await boundTestPort(
      typeof address === "object" && address !== null ? address.port : 0,
      "TLS half-close",
    );
    try {
      const client = `
        const s = require("tls").connect({ port: ${port}, host: "127.0.0.1", rejectUnauthorized: false });
        s.on("data", (d) => {
          if (String(d).startsWith("220")) s.write("QUIT\\r\\n");
          if (String(d).startsWith("221")) s.end();
        });
        s.on("close", () => process.exit(0));
        s.on("error", () => process.exit(1));
        setTimeout(() => process.exit(2), 5000);`;
      for (let i = 0; i < CLIENTS; i += 1) {
        const proc = Bun.spawn([nodeBinary(), "-e", client]);
        expect(await proc.exited).toBe(0);
      }

      await waitFor(() => closed === CLIENTS, 2000);
      expect(closed).toBe(CLIENTS);
      expect(lingeringSockets(port)).toEqual([]);
      /** A spinning socket takes the whole core (1.0); idle is a few percent. */
      expect(await cpuShare(1000)).toBeLessThan(0.25);
    } finally {
      server.close();
    }
  }, 20_000);

  /**
   * Bun 1.3.14 drained a streamed response body as fast as `pull`
   * produced it, whatever the client read: a client that stopped reading
   * made the server build and buffer the whole body (all 64 MB here). Bun
   * 1.4.4 pulls only a few MB ahead (about 1 MB on macOS, 3 MB on Linux),
   * and its idle timeout then cancels the stream, which is what gives a
   * stalled CSV export's slot back (`src/pages/lib/csv-export.tsx`).
   */
  test("a streamed response stops pulling ahead of a client that does not read, then is cancelled", async () => {
    const CHUNK_BYTES = 64 * 1024;
    const CHUNKS = 1024;
    let pulled = 0;
    let cancelled = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      /** Seconds; the app runs with Elysia's 30. */
      idleTimeout: 1,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              await Bun.sleep(0);
              if (pulled >= CHUNKS) {
                controller.close();
                return;
              }
              pulled += 1;
              controller.enqueue(new Uint8Array(CHUNK_BYTES));
            },
            cancel: () => {
              cancelled = true;
            },
          }),
        ),
    });
    const port = await boundTestPort(server.port ?? 0, "streamed response");
    /** Sends the request, then never reads a byte. */
    const client = Bun.spawn([
      nodeBinary(),
      "-e",
      `const s = require("net").connect(${port}, "127.0.0.1", () => {
         s.write("GET / HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n");
         s.pause();
       });
       s.on("error", () => undefined);
       setTimeout(() => process.exit(0), 15000);`,
    ]);
    try {
      await Bun.sleep(1000);
      const afterOneSecond = pulled;
      await Bun.sleep(500);
      expect(pulled).toBe(afterOneSecond);
      expect(pulled * CHUNK_BYTES).toBeLessThan(16 * 1024 * 1024);

      expect(await waitFor(() => cancelled, 10_000)).toBe(true);
    } finally {
      client.kill();
      await client.exited;
      await server.stop(true);
    }
  }, 20_000);
});
