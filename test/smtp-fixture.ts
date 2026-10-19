/**
 * Starts `test/fixtures/smtp-tls-server.mjs`, a real receiving MX, under
 * Node (#250): Bun cannot upgrade an accepted socket to TLS, so it cannot
 * serve STARTTLS. The client side, the code under test, runs under Bun.
 */

const FIXTURE = new URL("fixtures/smtp-tls-server.mjs", import.meta.url).pathname;

/** What the fixture server does, see the fixture's header. */
export type FixtureMode =
  "starttls" | "plaintext" | "tls11" | "silent" | "mute-tls" | "stall-data";

/** A running fixture server and what it reported on stdout. */
export interface FixtureServer {
  port: number;
  /** Messages the server accepted so far. */
  messages: () => number;
  /** Connections the server accepted so far. */
  connections: () => number;
  /** Connections closed so far, by either side. */
  closed: () => number;
  /** TCP connections open on the server now. */
  open: () => number;
  /** Resolves once no connection is open, or rejects after `withinMs`. */
  waitForNoneOpen: (withinMs: number) => Promise<void>;
  stop: () => void;
}

/** Starts the fixture server in `mode` and waits for its port. */
export async function startFixtureServer(mode: FixtureMode): Promise<FixtureServer> {
  const node = Bun.which("node");
  if (node === null)
    throw new Error("these tests need `node` on PATH to run smtp-server");
  const proc = Bun.spawn([node, FIXTURE, mode], { stdin: "pipe", stdout: "pipe" });
  let messages = 0;
  let connections = 0;
  let closed = 0;
  let open = 0;
  let resolvePort: (port: number) => void = () => undefined;
  const port = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line: unknown = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (typeof line !== "object" || line === null) continue;
        const reported: unknown = Reflect.get(line, "port");
        const message: unknown = Reflect.get(line, "message");
        const connection: unknown = Reflect.get(line, "connection");
        const closedCount: unknown = Reflect.get(line, "closed");
        const openCount: unknown = Reflect.get(line, "open");
        if (typeof openCount === "number") open = openCount;
        if (typeof reported === "number") resolvePort(reported);
        if (typeof message === "number") messages = message;
        if (typeof connection === "number") connections = connection;
        if (typeof closedCount === "number") closed = closedCount;
      }
    }
  })();
  return {
    port: await port,
    messages: () => messages,
    connections: () => connections,
    closed: () => closed,
    open: () => open,
    waitForNoneOpen: async (withinMs) => {
      /** Every connection the server accepted is gone (counters update in the background). */
      const allClosed = (): boolean => open === 0 && closed >= connections;
      const deadline = Date.now() + withinMs;
      while (!allClosed()) {
        if (Date.now() > deadline) {
          throw new Error(
            `server still has ${open} open connection(s), ${closed} of ${connections} closed`,
          );
        }
        await Bun.sleep(20);
      }
    },
    stop: () => {
      void proc.stdin.end();
      proc.kill();
    },
  };
}
