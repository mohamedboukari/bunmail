import { describe, test, expect } from "bun:test";
import { createServer } from "node:net";
import {
  boundPort,
  describeListenError,
  isListenError,
  tlsSocketError,
} from "../../src/modules/inbound/services/smtp-listen.ts";

/** Builds an error shaped like the one Bun's net server emits. */
function socketError(syscall: string, code: string): Error {
  return Object.assign(new Error("Failed to listen at ::"), { syscall, code });
}

describe("isListenError (#167)", () => {
  test("recognises a bind failure", () => {
    expect(isListenError(socketError("listen", "EACCES"))).toBe(true);
    expect(isListenError(socketError("listen", "EADDRINUSE"))).toBe(true);
  });

  test("ignores runtime errors on individual connections", () => {
    expect(isListenError(socketError("read", "ECONNRESET"))).toBe(false);
    expect(isListenError(new Error("Socket closed unexpectedly"))).toBe(false);
  });

  test("ignores non-Error values", () => {
    expect(isListenError({ syscall: "listen" })).toBe(false);
    expect(isListenError("listen")).toBe(false);
    expect(isListenError(undefined)).toBe(false);
  });
});

describe("describeListenError (#167)", () => {
  test("EACCES explains the non-root cause and both fixes", () => {
    const msg = describeListenError("Inbound SMTP", 25, "EACCES");
    expect(msg).toContain("port 25");
    expect(msg).toContain("EACCES");
    expect(msg).toContain("non-root");
    expect(msg).toContain("net.ipv4.ip_unprivileged_port_start=0");
    expect(msg).toContain(">= 1024");
  });

  test("EADDRINUSE says the port is taken", () => {
    const msg = describeListenError("SMTP submission", 587, "EADDRINUSE");
    expect(msg).toContain("port 587");
    expect(msg).toContain("already using it");
  });

  test("unknown or missing codes still name the server and port", () => {
    expect(describeListenError("Inbound SMTP", 25, "EINVAL")).toBe(
      "Inbound SMTP can't listen on port 25 (EINVAL).",
    );
    expect(describeListenError("Inbound SMTP", 25)).toContain("(unknown error)");
  });
});

describe("boundPort (#443)", () => {
  test("reads the port the OS picked for port 0", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = boundPort(server, 0);
      expect(port).toBeGreaterThan(0);
      const address = server.address();
      expect(typeof address === "object" && address !== null ? address.port : -1).toBe(
        port,
      );
    } finally {
      server.close();
    }
  });

  test("returns the bound port, which is the configured one in production", () => {
    const listening = {
      address: () => ({ address: "::", family: "IPv6", port: 2525 }),
    };
    expect(boundPort(listening, 2525)).toBe(2525);
  });

  test("falls back to the requested port without a TCP address", () => {
    expect(boundPort({ address: () => null }, 587)).toBe(587);
    expect(boundPort({ address: () => "/tmp/smtp.sock" }, 587)).toBe(587);
  });
});

describe("tlsSocketError (#414)", () => {
  /** An error shaped like the ones smtp-server emits for a client's TLS failure. */
  const tlsError = (code: string, remoteAddress?: string, meta?: object): Error =>
    Object.assign(new Error("wrong version number"), { code, remoteAddress, meta });

  test("a STARTTLS connection's error (smtp-server adds meta.protocol smtp)", () => {
    const meta = { tlsProtocol: "TLSv1.2", protocol: "smtp", stage: "connect" };
    expect(
      tlsSocketError(tlsError("ERR_SSL_WRONG_VERSION_NUMBER", "203.0.113.9", meta)),
    ).toEqual({
      ip: "203.0.113.9",
      code: "ERR_SSL_WRONG_VERSION_NUMBER",
      starttls: true,
    });
  });

  test("a TLS error without that meta (implicit TLS, terminated upstream)", () => {
    expect(tlsSocketError(tlsError("ERR_SSL_BAD_PACKET_LENGTH", "::1"))).toEqual({
      ip: "::1",
      code: "ERR_SSL_BAD_PACKET_LENGTH",
      starttls: false,
    });
    expect(tlsSocketError(tlsError("ERR_TLS_HANDSHAKE_TIMEOUT"))).toEqual({
      ip: null,
      code: "ERR_TLS_HANDSHAKE_TIMEOUT",
      starttls: false,
    });
    expect(
      tlsSocketError(tlsError("TLSError", "::1", { protocol: "http" })),
    ).toMatchObject({
      code: "TLSError",
      starttls: false,
    });
  });

  test("ignores every other error", () => {
    expect(tlsSocketError(socketError("listen", "EADDRINUSE"))).toBeNull();
    expect(tlsSocketError(tlsError("ECONNRESET", "203.0.113.9"))).toBeNull();
    expect(tlsSocketError(new Error("boom"))).toBeNull();
    expect(tlsSocketError({ code: "ERR_SSL_X" })).toBeNull();
    expect(tlsSocketError(undefined)).toBeNull();
  });
});
