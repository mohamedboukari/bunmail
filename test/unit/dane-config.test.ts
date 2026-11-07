import { describe, expect, test } from "bun:test";
import {
  daneResolverIsLocal,
  readDaneEnabled,
  readDaneResolver,
} from "../../src/config.ts";

/**
 * DANE's env vars (#345): `DANE_ENABLED` is a strict boolean, off by
 * default; `DANE_RESOLVER` is an IP literal with an optional port, port 53
 * by default, required when DANE is on and refused when malformed, even
 * with DANE off. A host name is refused: resolving it would need a
 * resolver already trusted.
 */

describe("readDaneEnabled", () => {
  test("off by default, true and false only", () => {
    expect(readDaneEnabled(undefined)).toBe(false);
    expect(readDaneEnabled("")).toBe(false);
    expect(readDaneEnabled("true")).toBe(true);
    expect(readDaneEnabled("false")).toBe(false);
    for (const raw of ["1", "yes", "TRUE"]) {
      expect(() => readDaneEnabled(raw)).toThrow(
        /DANE_ENABLED must be "true" or "false"/,
      );
    }
  });
});

describe("readDaneResolver", () => {
  test("DANE on without a resolver refuses to boot", () => {
    expect(() => readDaneResolver(true, "")).toThrow(
      /DANE_ENABLED=true needs DANE_RESOLVER/,
    );
    expect(() => readDaneResolver(true, "   ")).toThrow(/needs DANE_RESOLVER/);
  });

  test("DANE off without a resolver is fine", () => {
    expect(readDaneResolver(false, "")).toBeNull();
  });

  test("IP literals with an optional port", () => {
    expect(readDaneResolver(true, "172.30.53.53")).toEqual({
      address: "172.30.53.53",
      port: 53,
      family: 4,
    });
    expect(readDaneResolver(true, " 172.30.53.53:5353 ")).toEqual({
      address: "172.30.53.53",
      port: 5353,
      family: 4,
    });
    expect(readDaneResolver(true, "2001:db8::53")).toEqual({
      address: "2001:db8::53",
      port: 53,
      family: 6,
    });
    expect(readDaneResolver(true, "[2001:db8::53]:5300")).toEqual({
      address: "2001:db8::53",
      port: 5300,
      family: 6,
    });
  });

  test("a host name, a bad port or garbage refuses to boot, even with DANE off", () => {
    for (const raw of [
      "unbound",
      "resolver.example:53",
      "172.30.53.53:0",
      "172.30.53.53:70000",
      "[2001:db8::53]:x",
      "999.1.1.1",
    ]) {
      expect(() => readDaneResolver(false, raw)).toThrow(
        /DANE_RESOLVER must be an IP address/,
      );
    }
  });
});

describe("daneResolverIsLocal (boot warning, RFC 7672 2.1.1)", () => {
  /** The resolver of `raw`. */
  function resolver(raw: string) {
    const parsed = readDaneResolver(true, raw);
    if (parsed === null) throw new Error("no resolver");
    return parsed;
  }

  test("loopback, private and link-local addresses are local", () => {
    for (const raw of [
      "127.0.0.1",
      "127.0.0.53:5353",
      "10.1.2.3",
      "172.30.53.53",
      "172.17.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "::1",
      "[fd00::53]:53",
      "fe80::1",
    ]) {
      expect(daneResolverIsLocal(resolver(raw))).toBe(true);
    }
  });

  test("public resolvers are not (a warning at boot, not a refusal)", () => {
    for (const raw of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2001:4860:4860::8888"]) {
      expect(daneResolverIsLocal(resolver(raw))).toBe(false);
    }
  });
});
