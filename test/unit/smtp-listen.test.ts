import { describe, test, expect } from "bun:test";
import {
  describeListenError,
  isListenError,
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
