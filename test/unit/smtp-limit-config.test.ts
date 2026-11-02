import { describe, expect, test } from "bun:test";
import {
  SMTP_LIMIT_SWITCHES,
  readSmtpLimitSwitch,
  readInboundConnectionLimit,
  readSubmissionAuthLimit,
  readSubmissionConnectionLimit,
} from "../../src/config.ts";

/**
 * The per-IP SMTP limits (#185) are read strictly: a whole number from 1
 * up to a ceiling for `*_MAX`, 1 to 86400 seconds for `*_WINDOW`. Unset or
 * blank gives the default; 0, a sign, a decimal, not a number or out of
 * range refuses to boot, naming the variable. A bare `parseInt` used to
 * let 0 refuse every connection or AUTH, and a typo (`NaN`) turn the
 * limit off silently.
 */

/** Values every setting refuses: never a whole number in range. */
const ALWAYS_REFUSED = ["0", "-1", "+5", "1.5", "1e3", "0x10", "ten", "NaN"];

/** One setting: its variable, how to read it alone, its default and range. */
interface Setting {
  name: string;
  read: (raw: string | undefined) => number;
  fallback: number;
  ceiling: number;
}

const SETTINGS: Setting[] = [
  {
    name: "SMTP_RATE_LIMIT_MAX",
    read: (raw) => readInboundConnectionLimit({ max: raw, window: undefined }).max,
    fallback: 10,
    ceiling: 100_000,
  },
  {
    name: "SMTP_RATE_LIMIT_WINDOW",
    read: (raw) => readInboundConnectionLimit({ max: undefined, window: raw }).windowSec,
    fallback: 60,
    ceiling: 86_400,
  },
  {
    name: "SMTP_SUBMISSION_RATE_LIMIT_MAX",
    read: (raw) => readSubmissionConnectionLimit({ max: raw, window: undefined }).max,
    fallback: 30,
    ceiling: 100_000,
  },
  {
    name: "SMTP_SUBMISSION_RATE_LIMIT_WINDOW",
    read: (raw) =>
      readSubmissionConnectionLimit({ max: undefined, window: raw }).windowSec,
    fallback: 60,
    ceiling: 86_400,
  },
  {
    name: "SMTP_SUBMISSION_AUTH_RATE_LIMIT_MAX",
    read: (raw) => readSubmissionAuthLimit({ max: raw, window: undefined }).maxAttempts,
    fallback: 10,
    ceiling: 10_000,
  },
  {
    name: "SMTP_SUBMISSION_AUTH_RATE_LIMIT_WINDOW",
    read: (raw) => readSubmissionAuthLimit({ max: undefined, window: raw }).windowSec,
    fallback: 900,
    ceiling: 86_400,
  },
];

describe.each(SETTINGS)("$name", ({ name, read, fallback, ceiling }) => {
  test("unset or blank: the default", () => {
    expect(read(undefined)).toBe(fallback);
    expect(read("")).toBe(fallback);
    expect(read("  ")).toBe(fallback);
  });

  test("accepts 1, the ceiling, and values in between", () => {
    expect(read("1")).toBe(1);
    expect(read(String(ceiling))).toBe(ceiling);
    expect(read(" 42 ")).toBe(42);
  });

  test.each([...ALWAYS_REFUSED, String(ceiling + 1)])(
    "refuses %p, naming the variable and the range",
    (raw) => {
      expect(() => read(raw)).toThrow(
        `[config] ${name} must be a whole number from 1 to ${ceiling}`,
      );
    },
  );
});

/**
 * The limits' on/off switches are read strictly too (#185, review L5):
 * `true` or `false`, unset or blank for on; anything else refuses to boot,
 * where a bare `=== "true"` turned a typo off.
 */
describe.each([...SMTP_LIMIT_SWITCHES])("%s", (name) => {
  test("unset or blank: on", () => {
    expect(readSmtpLimitSwitch(name, undefined)).toBe(true);
    expect(readSmtpLimitSwitch(name, "")).toBe(true);
  });

  test("accepts true and false", () => {
    expect(readSmtpLimitSwitch(name, "true")).toBe(true);
    expect(readSmtpLimitSwitch(name, "false")).toBe(false);
    expect(readSmtpLimitSwitch(name, " false ")).toBe(false);
  });

  test.each(["TRUE", "False", "1", "0", "yes", "no", "on", "off"])(
    "refuses %p, naming the variable",
    (raw) => {
      expect(() => readSmtpLimitSwitch(name, raw)).toThrow(
        `[config] ${name} must be "true" or "false"`,
      );
    },
  );
});
