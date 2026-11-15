import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { warnIgnoredSettings } from "../../src/boot.ts";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The boot warnings about `MAIL_SOURCE_IP` (#414), through the real
 * `warnIgnoredSettings` and this host's real interfaces. `config` is
 * changed in place (read-only only to TypeScript) and restored; the logger
 * is spied on, never mocked as a module (a module mock leaks across files).
 */

const originalSourceIps = config.mail.sourceIps;

afterEach(() => {
  expect(Reflect.set(config.mail, "sourceIps", originalSourceIps)).toBe(true);
});

/** The `MAIL_SOURCE_IP` warnings logged by one boot with `sourceIps`. */
function bootWith(sourceIps: { v4: string | null; v6: string | null }): string[] {
  expect(Reflect.set(config.mail, "sourceIps", sourceIps)).toBe(true);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    warnIgnoredSettings();
    return warn.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("MAIL_SOURCE_IP"));
  } finally {
    warn.mockRestore();
  }
}

describe("MAIL_SOURCE_IP boot warnings (#414)", () => {
  test("unset: none", () => {
    expect(bootWith({ v4: null, v6: null })).toEqual([]);
  });

  test("an address this host has (loopback is always there): none about the interface", () => {
    /** Loopback is refused by the config reader; set directly, it only checks the interface lookup. */
    expect(bootWith({ v4: "127.0.0.1", v6: null })).not.toContainEqual(
      expect.stringMatching(/not an address of this host/),
    );
  });

  test("an address this host does not have (TEST-NET-1): one warning", () => {
    /** Filtered: a MAIL_PUBLIC_IP in the test environment may add the mismatch warning. */
    const notLocal = bootWith({ v4: "192.0.2.1", v6: null }).filter((message) =>
      message.includes("not an address of this host"),
    );
    expect(notLocal).toEqual([
      "MAIL_SOURCE_IP is not an address of this host: outbound SMTP will fail",
    ]);
  });
});
