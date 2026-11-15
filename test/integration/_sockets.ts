/**
 * Socket leak checks for the SMTP TLS tests (#351, #414): a client hanging
 * up at any stage must leave no server socket behind (Bun 1.3.14 kept a TLS
 * socket in CLOSE_WAIT and spun a CPU core on it). Shared by
 * `smtp-submission-tls.integration.test.ts` and
 * `inbound-starttls.integration.test.ts`.
 */
import { readFileSync } from "fs";

/** `/proc/net/tcp` state codes of a server socket a gone client must not leave. */
const LINGERING_STATES = new Map([
  ["01", "ESTABLISHED"],
  ["08", "CLOSE_WAIT"],
]);

/**
 * The server's sockets on `port` that are still open for a client (the
 * listener aside). Linux: the kernel's TCP tables, by local port (the Node
 * clients use ephemeral ports, never this one). macOS: `lsof` on this
 * process, where a socket the runtime never released also shows as CLOSED.
 */
export function lingeringSockets(port: number): string[] {
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
  if (lsof === null) throw new Error("these tests need /proc/net/tcp or `lsof`");
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

/** Polls for up to 2 s until no socket lingers on `port`; returns what is left. */
export async function socketsLeftAfterHangUp(port: number): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const left = lingeringSockets(port);
    if (left.length === 0 || Date.now() > deadline) return left;
    await Bun.sleep(50);
  }
}

/**
 * The share of one CPU core this (server) process may use while idle. A
 * socket Bun spins on takes the whole core (about 1.0); idle is a few
 * percent. The 0.25 budget leaves room both ways, so a busy shared CI
 * runner neither fails it nor hides a spin.
 */
export const IDLE_CPU_BUDGET = 0.25;

/** The share of one CPU core this process uses over 3 s, after a short settle. */
export async function serverCpuShare(): Promise<number> {
  await Bun.sleep(250);
  const before = process.cpuUsage();
  const startedAt = performance.now();
  await Bun.sleep(3000);
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000 / (performance.now() - startedAt);
}
