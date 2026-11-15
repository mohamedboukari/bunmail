/**
 * One outbound SMTP session (#250) against a real receiving server
 * (`test/smtp-fixture.ts`, run under Node): whatever way the session ends,
 * its connection is closed. A receiver that never answers, or a STARTTLS
 * handshake that never completes, fails the attempt at the deadline or
 * stall limit as retryable, and the receiver sees the connection go away
 * right after, instead of it staying open in the background.
 *
 * In the integration tier because it needs the real nodemailer, which a
 * unit file mocks with `mock.module` (that leaks across unit files). No
 * database.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "node:net";
import { runMxSession } from "../../src/modules/emails/services/mx-transport.ts";
import { runtimeHasSocketFeatures } from "../../src/config.ts";
import { classifySendFailure } from "../../src/utils/smtp-error.ts";
import {
  startFixtureServer,
  type FixtureMode,
  type FixtureServer,
} from "../smtp-fixture.ts";

const running: FixtureServer[] = [];

afterAll(() => {
  for (const server of running) server.stop();
});

async function startServer(mode: FixtureMode): Promise<FixtureServer> {
  const server = await startFixtureServer(mode);
  running.push(server);
  return server;
}

/** One transaction's message, numbered so each is distinct. */
function transaction(n: number) {
  return {
    key: `mx.example.test#${n}`,
    mail: {
      from: "sender@example.com",
      to: `rcpt${n}@example.org`,
      subject: `session ${n}`,
      text: "hello",
    },
  };
}

/** A session against the fixture on `port`, with the given overrides. */
function session(
  port: number,
  count: number,
  overrides: { deadlineMs?: number; stallMs?: number } = {},
) {
  return runMxSession({
    address: "127.0.0.1",
    mxHost: "mx.example.test",
    heloName: "bunmail.example.test",
    transactions: Array.from({ length: count }, (_, i) => transaction(i)),
    port,
    ...overrides,
  });
}

describe("runMxSession: the connection is closed however the session ends", () => {
  test("a receiver that never answers: fails at the deadline, retryable, and is disconnected", async () => {
    const server = await startServer("silent");
    const started = Date.now();
    const outcomes = await session(server.port, 1, { deadlineMs: 800 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcomes).toHaveLength(1);
    expect(String(outcomes[0]?.error)).toContain("SMTP session exceeded");
    expect(classifySendFailure(outcomes[0]?.error)).toBeNull();
    expect(outcomes[0]?.tls).toBeNull();
    expect(server.connections()).toBe(1);
    /** The receiver sees the connection close, well before any socket timeout. */
    await server.waitForNoneOpen(2_000);
  });

  test("a STARTTLS handshake that never completes: fails, retryable, and is disconnected", async () => {
    const server = await startServer("mute-tls");
    const outcomes = await session(server.port, 1, { deadlineMs: 3_000, stallMs: 500 });
    expect(outcomes[0]?.error).toBeInstanceOf(Error);
    expect(classifySendFailure(outcomes[0]?.error)).toBeNull();
    expect(outcomes[0]?.tls).toBeNull();
    expect(server.connections()).toBe(1);
    await server.waitForNoneOpen(2_000);
  });

  test("a session stuck after a completed STARTTLS handshake: fails, retryable, and is disconnected", async () => {
    const server = await startServer("stall-data");
    const outcomes = await session(server.port, 1, { deadlineMs: 1_500 });
    expect(String(outcomes[0]?.error)).toContain("SMTP session exceeded");
    expect(classifySendFailure(outcomes[0]?.error)).toBeNull();
    /** The upgrade completed and the session got ready before it stalled. */
    expect(outcomes[0]?.tls).toBe("starttls");
    expect(await server.waitForMessages(1)).toBe(1);
    expect(server.connections()).toBe(1);
    await server.waitForNoneOpen(2_000);
  });

  test("every transaction after a stuck one fails fast, and nothing stays open", async () => {
    const server = await startServer("silent");
    const outcomes = await session(server.port, 3, { deadlineMs: 800 });
    expect(outcomes.map((o) => o.error instanceof Error)).toEqual([true, true, true]);
    expect(server.connections()).toBeGreaterThanOrEqual(1);
    await server.waitForNoneOpen(2_000);
  });

  test("a normal session sends every transaction on one connection, then closes it", async () => {
    const server = await startServer("starttls");
    const outcomes = await session(server.port, 2);
    expect(outcomes).toEqual([
      { key: "mx.example.test#0", tls: "starttls" },
      { key: "mx.example.test#1", tls: "starttls" },
    ]);
    expect(await server.waitForMessages(2)).toBe(2);
    expect(server.connections()).toBe(1);
    await server.waitForNoneOpen(2_000);
  });

  test("a single transaction is the same pooled session, closed after", async () => {
    const server = await startServer("plaintext");
    const outcomes = await session(server.port, 1);
    expect(outcomes).toEqual([{ key: "mx.example.test#0", tls: "plaintext" }]);
    expect(server.connections()).toBe(1);
    await server.waitForNoneOpen(2_000);
  });

  test("a refused connection fails as retryable without an SMTP reply", async () => {
    /** A port nothing listens on: bound, then released. */
    const probe = createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const outcomes = await session(port, 2, { deadlineMs: 5_000 });
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.error).toBeInstanceOf(Error);
      expect(classifySendFailure(outcome.error)).toBeNull();
      expect(outcome.tls).toBeNull();
    }
  });
});

/**
 * `MAIL_SOURCE_IP` (#414): the session's socket binds the source address
 * of the destination's family. Bun 1.3.14 ignores `localAddress` (the
 * config refuses the setting there), so this block skips on a Bun older
 * than 1.4.4 (`runtimeHasSocketFeatures`).
 */
describe.skipIf(!runtimeHasSocketFeatures())(
  "runMxSession: MAIL_SOURCE_IP (#414)",
  () => {
    test("bound to a local address, the session delivers", async () => {
      const server = await startServer("plaintext");
      const outcomes = await runMxSession({
        address: "127.0.0.1",
        mxHost: "mx.example.test",
        heloName: "bunmail.example.test",
        transactions: [transaction(0)],
        port: server.port,
        sourceIps: { v4: "127.0.0.1", v6: null },
      });
      expect(outcomes).toEqual([{ key: "mx.example.test#0", tls: "plaintext" }]);
      expect(await server.waitForMessages(1)).toBe(1);
    });

    test("an address this host does not have fails the attempt, retryable, without connecting", async () => {
      const server = await startServer("plaintext");
      const outcomes = await runMxSession({
        address: "127.0.0.1",
        mxHost: "mx.example.test",
        heloName: "bunmail.example.test",
        transactions: [transaction(0)],
        port: server.port,
        /** TEST-NET-1: never assigned to a host, so the bind is refused. */
        sourceIps: { v4: "192.0.2.1", v6: null },
      });
      expect(outcomes).toHaveLength(1);
      expect(Reflect.get(Object(outcomes[0]?.error), "code")).toBe("EADDRNOTAVAIL");
      expect(classifySendFailure(outcomes[0]?.error)).toBeNull();
      expect(server.connections()).toBe(0);
    });

    test("an IPv4 destination ignores an IPv6-only setting: the system's choice", async () => {
      const server = await startServer("plaintext");
      const outcomes = await runMxSession({
        address: "127.0.0.1",
        mxHost: "mx.example.test",
        heloName: "bunmail.example.test",
        transactions: [transaction(0)],
        port: server.port,
        sourceIps: { v4: null, v6: "2001:db8::5" },
      });
      expect(outcomes).toEqual([{ key: "mx.example.test#0", tls: "plaintext" }]);
    });
  },
);
