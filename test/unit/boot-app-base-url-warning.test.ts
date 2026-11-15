import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { warnIgnoredSettings } from "../../src/boot.ts";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The one-time boot warning for an `APP_BASE_URL` that is set but not an
 * `http(s)://` URL (#420): it is treated as unset, so the dashboard
 * same-origin check falls back to the request host. `config` is changed in
 * place (read-only only to TypeScript) and restored; the logger is spied
 * on, never mocked as a module (a module mock leaks across files).
 */

/** The start of the warning's message. */
const MESSAGE = "APP_BASE_URL is set but is not an http(s) URL";

const originalBaseUrl = config.appBaseUrl;

afterEach(() => {
  expect(Reflect.set(config, "appBaseUrl", originalBaseUrl)).toBe(true);
});

/**
 * Runs the boot warnings with `APP_BASE_URL` set to `value`.
 *
 * @param value The `config.appBaseUrl` to boot with.
 * @returns How many times the #420 warning was logged, and its fields.
 */
function bootWith(value: string): { count: number; fields: unknown[] } {
  expect(Reflect.set(config, "appBaseUrl", value)).toBe(true);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    warnIgnoredSettings();
    const calls = warn.mock.calls.filter((call) => call[0].startsWith(MESSAGE));
    return { count: calls.length, fields: calls.map((call) => call[1]) };
  } finally {
    warn.mockRestore();
  }
}

describe("APP_BASE_URL boot warning (#420)", () => {
  test.each([["javascript:alert(1)"], ["mail.example.com"], ["ftp://mail.example.com"]])(
    "APP_BASE_URL=%p: warned once, without the value",
    (value) => {
      const { count, fields } = bootWith(value);
      expect(count).toBe(1);
      expect(JSON.stringify(fields)).not.toContain(value);
    },
  );

  test.each([[""], ["https://mail.example.com"], ["http://localhost:3000"]])(
    "APP_BASE_URL=%p: no warning",
    (value) => {
      expect(bootWith(value).count).toBe(0);
    },
  );
});
