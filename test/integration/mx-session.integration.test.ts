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
    expect(server.messages()).toBe(1);
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
    expect(server.messages()).toBe(2);
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
